// Package vikunja is the live REST adapter for a Vikunja tracker.
//
// It implements the projection side of the field-authority split: task
// content, buckets, and comments live in Vikunja; protected workflow state
// lives in control.sqlite. The adapter writes projections through a
// dedicated service account and reads comment author identity to feed the
// trusted human-approval channel.
//
// Endpoints here were verified against Vikunja API v2.4.0.
package vikunja

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Client talks to one Vikunja instance as one authenticated account.
type Client struct {
	BaseURL string // e.g. http://localhost:3456/api/v1
	Token   string
	HTTP    *http.Client
	userID  int64
}

func New(baseURL, token string) *Client {
	return &Client{
		BaseURL: baseURL,
		Token:   token,
		HTTP:    &http.Client{Timeout: 15 * time.Second},
	}
}

// Login exchanges credentials for a long-lived token and returns a client.
func Login(baseURL, username, password string) (*Client, error) {
	c := &Client{BaseURL: baseURL, HTTP: &http.Client{Timeout: 15 * time.Second}}
	var out struct {
		Token string `json:"token"`
	}
	err := c.do("POST", "/login", map[string]any{
		"username": username, "password": password, "long_token": true,
	}, &out)
	if err != nil {
		return nil, err
	}
	if out.Token == "" {
		return nil, fmt.Errorf("vikunja login: empty token")
	}
	c.Token = out.Token
	if _, err := c.CurrentUserID(); err != nil {
		return nil, err
	}
	return c, nil
}

// CurrentUserID returns (and caches) the authenticated account's user id.
// For the service-account client this is the id ParseApproval must reject.
func (c *Client) CurrentUserID() (int64, error) {
	if c.userID != 0 {
		return c.userID, nil
	}
	var u struct {
		ID int64 `json:"id"`
	}
	if err := c.do("GET", "/user", nil, &u); err != nil {
		return 0, err
	}
	c.userID = u.ID
	return u.ID, nil
}

type Project struct {
	ID    int64  `json:"id"`
	Title string `json:"title"`
}

// EnsureProject returns the project with the given title, creating it if
// absent. Idempotent so repeated init/reconcile never forks the board.
func (c *Client) EnsureProject(title string) (*Project, error) {
	var projects []Project
	if err := c.do("GET", "/projects", nil, &projects); err != nil {
		return nil, err
	}
	for _, p := range projects {
		if p.Title == title {
			return &p, nil
		}
	}
	var created Project
	if err := c.do("PUT", "/projects", map[string]any{"title": title}, &created); err != nil {
		return nil, err
	}
	return &created, nil
}

// ShareWithUser grants a human account access to the service-owned board.
// permission: 0 read, 1 read+write, 2 admin.
func (c *Client) ShareWithUser(projectID int64, username string, permission int) error {
	err := c.do("PUT", fmt.Sprintf("/projects/%d/users", projectID),
		map[string]any{"username": username, "permission": permission}, nil)
	// A duplicate share is not an error for our purposes.
	if err != nil && !isConflict(err) {
		return err
	}
	return nil
}

type Task struct {
	ID          int64  `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Done        bool   `json:"done"`
}

// CreateTask projects an Agentklar task into the board and returns the
// tracker task id to store as tracker_id.
func (c *Client) CreateTask(projectID int64, title, description string) (*Task, error) {
	var t Task
	err := c.do("PUT", fmt.Sprintf("/projects/%d/tasks", projectID),
		map[string]any{"title": title, "description": description}, &t)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// SetDone projects the terminal Done state onto the tracker task.
func (c *Client) SetDone(taskID int64, done bool) error {
	return c.do("POST", fmt.Sprintf("/tasks/%d", taskID),
		map[string]any{"done": done}, nil)
}

// PostComment adds a comment as the authenticated account. Agentklar posts
// its pending-approval prompt through the service-account client.
func (c *Client) PostComment(taskID int64, body string) (int64, error) {
	var out struct {
		ID int64 `json:"id"`
	}
	err := c.do("PUT", fmt.Sprintf("/tasks/%d/comments", taskID),
		map[string]any{"comment": body}, &out)
	return out.ID, err
}

// Comment carries the author identity that is the approval security boundary.
type Comment struct {
	ID     int64  `json:"id"`
	Body   string `json:"comment"`
	Author struct {
		ID       int64  `json:"id"`
		Username string `json:"username"`
	} `json:"author"`
	Created time.Time `json:"created"`
}

// ListComments returns a task's comments in creation order.
func (c *Client) ListComments(taskID int64) ([]Comment, error) {
	var out []Comment
	if err := c.do("GET", fmt.Sprintf("/tasks/%d/comments", taskID), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// --- transport ---

type apiError struct {
	Status  int
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *apiError) Error() string {
	return fmt.Sprintf("vikunja http %d (code %d): %s", e.Status, e.Code, e.Message)
}

func isConflict(err error) bool {
	if ae, ok := err.(*apiError); ok {
		// Vikunja returns 500/400 for an already-shared user; treat the
		// "already exists" family as non-fatal for idempotent shares.
		return ae.Status == http.StatusConflict || ae.Code == 4001
	}
	return false
}

func (c *Client) do(method, path string, body, out any) error {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.BaseURL+path, rdr)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		ae := &apiError{Status: resp.StatusCode}
		json.Unmarshal(data, ae)
		return ae
	}
	if out != nil && len(data) > 0 {
		return json.Unmarshal(data, out)
	}
	return nil
}
