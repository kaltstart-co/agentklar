package vikunja

import (
	"fmt"

	"github.com/kaltstart-co/agentklar/internal/contracts"
)

// WorkflowBuckets are the Kanban columns Agentklar maintains, in order.
// They mirror the protected workflow states so the board reads as the
// lifecycle a task moves through.
var WorkflowBuckets = []string{
	"Draft", "Ready", "In Progress", "Completion Review",
	"Auto QA", "Changes Requested", "User Approval", "Done",
}

// bucketForState maps a protected state to its column title. Exceptional
// states (waiting/blocked/cancelled) have no column and are left in place.
func bucketForState(s contracts.State) string {
	switch s {
	case contracts.StateDraft:
		return "Draft"
	case contracts.StateReady:
		return "Ready"
	case contracts.StateInProgress:
		return "In Progress"
	case contracts.StateCompletionReview:
		return "Completion Review"
	case contracts.StateAutoQA:
		return "Auto QA"
	case contracts.StateChangesRequested:
		return "Changes Requested"
	case contracts.StateUserApproval:
		return "User Approval"
	case contracts.StateDone:
		return "Done"
	}
	return ""
}

// BucketTitle is the exported column title for a state (empty if none).
func BucketTitle(s contracts.State) string { return bucketForState(s) }

type view struct {
	ID       int64  `json:"id"`
	ViewKind string `json:"view_kind"`
	Title    string `json:"title"`
}

type bucket struct {
	ID    int64  `json:"id"`
	Title string `json:"title"`
}

// kanbanViewID returns the id of the project's Kanban view.
func (c *Client) kanbanViewID(projectID int64) (int64, error) {
	var views []view
	if err := c.do("GET", fmt.Sprintf("/projects/%d/views", projectID), nil, &views); err != nil {
		return 0, err
	}
	for _, v := range views {
		if v.ViewKind == "kanban" {
			return v.ID, nil
		}
	}
	return 0, fmt.Errorf("no kanban view on project %d", projectID)
}

// Board is a resolved handle to a project's Kanban view and its columns.
type Board struct {
	ProjectID int64
	ViewID    int64
	buckets   map[string]int64 // title -> bucket id
}

// EnsureBoard finds the project's Kanban view and makes sure every workflow
// column exists, creating any that are missing. Idempotent: connecting to an
// existing Vikunja that already has these columns changes nothing.
func (c *Client) EnsureBoard(projectID int64) (*Board, error) {
	viewID, err := c.kanbanViewID(projectID)
	if err != nil {
		return nil, err
	}
	var existing []bucket
	if err := c.do("GET", fmt.Sprintf("/projects/%d/views/%d/buckets", projectID, viewID), nil, &existing); err != nil {
		return nil, err
	}
	have := map[string]int64{}
	for _, b := range existing {
		have[b.Title] = b.ID
	}
	for _, title := range WorkflowBuckets {
		if _, ok := have[title]; ok {
			continue
		}
		var created bucket
		if err := c.do("PUT", fmt.Sprintf("/projects/%d/views/%d/buckets", projectID, viewID),
			map[string]any{"title": title}, &created); err != nil {
			return nil, fmt.Errorf("create bucket %q: %w", title, err)
		}
		have[title] = created.ID
	}
	return &Board{ProjectID: projectID, ViewID: viewID, buckets: have}, nil
}

// PlaceTask moves a task's card into the column for the given state and
// reflects the terminal Done state. A no-column state is left untouched.
func (b *Board) PlaceTask(c *Client, trackerTaskID int64, state contracts.State) error {
	title := bucketForState(state)
	if title == "" {
		return nil
	}
	bucketID, ok := b.buckets[title]
	if !ok {
		return fmt.Errorf("no %q column on the board", title)
	}
	if err := c.do("POST",
		fmt.Sprintf("/projects/%d/views/%d/buckets/%d/tasks", b.ProjectID, b.ViewID, bucketID),
		map[string]any{"task_id": trackerTaskID}, nil); err != nil {
		return err
	}
	// Keep the tracker's own done flag in sync with the terminal state.
	return c.SetDone(trackerTaskID, state == contracts.StateDone)
}
