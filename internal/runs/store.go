// Package runs owns registered native workers, separate from task completion.
package runs

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

const schema = `
CREATE TABLE IF NOT EXISTS native_harnesses (
 name TEXT PRIMARY KEY, executable TEXT NOT NULL, args TEXT NOT NULL,
 version TEXT NOT NULL, capabilities TEXT NOT NULL, checked_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS native_runs (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), holder TEXT NOT NULL,
 fencing_token INTEGER NOT NULL, request_hash TEXT NOT NULL, harness TEXT NOT NULL,
 model TEXT NOT NULL, purpose TEXT NOT NULL, read_only INTEGER NOT NULL, prompt TEXT NOT NULL,
 status TEXT NOT NULL, thread_id TEXT NOT NULL DEFAULT '', turn_id TEXT NOT NULL DEFAULT '', process_pid INTEGER NOT NULL DEFAULT 0, pending_request TEXT NOT NULL DEFAULT '',
 result TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS native_runs_serial ON native_runs((1))
 WHERE status IN ('starting','running','cancelling','attention_required');
CREATE TABLE IF NOT EXISTS native_run_events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES native_runs(id),
 method TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
);
`

type Store struct{ DB *sql.DB }

func NewStore(db *sql.DB) (*Store, error) {
	_, err := db.Exec(schema)
	return &Store{DB: db}, err
}

type Harness struct {
	Name         string   `json:"name"`
	Executable   string   `json:"executable"`
	Args         []string `json:"args"`
	Version      string   `json:"version"`
	Capabilities []string `json:"capabilities"`
	CheckedAt    string   `json:"checked_at"`
}

type Start struct {
	ID           string `json:"id"`
	TaskID       string `json:"task_id"`
	Holder       string `json:"holder"`
	FencingToken int64  `json:"fencing_token"`
	Harness      string `json:"harness"`
	Model        string `json:"model"`
	Purpose      string `json:"purpose"`
	ReadOnly     bool   `json:"read_only"`
	Prompt       string `json:"prompt"`
}

type Run struct {
	Start
	Status         string          `json:"status"`
	ThreadID       string          `json:"thread_id"`
	TurnID         string          `json:"turn_id"`
	ProcessPID     int             `json:"process_pid"`
	PendingRequest json.RawMessage `json:"pending_request,omitempty"`
	Result         string          `json:"result"`
	Error          string          `json:"error"`
	CreatedAt      string          `json:"created_at"`
	UpdatedAt      string          `json:"updated_at"`
}

type Event struct {
	Seq       int64           `json:"seq"`
	Method    string          `json:"method"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt string          `json:"created_at"`
}

func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }

func (s *Store) SaveHarness(h Harness) error {
	args, _ := json.Marshal(h.Args)
	caps, _ := json.Marshal(h.Capabilities)
	_, err := s.DB.Exec(`INSERT INTO native_harnesses VALUES(?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET executable=excluded.executable,args=excluded.args,version=excluded.version,capabilities=excluded.capabilities,checked_at=excluded.checked_at`, h.Name, h.Executable, string(args), h.Version, string(caps), h.CheckedAt)
	return err
}

func (s *Store) Harnesses() ([]Harness, error) {
	rows, err := s.DB.Query(`SELECT name,executable,args,version,capabilities,checked_at FROM native_harnesses ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Harness{}
	for rows.Next() {
		var h Harness
		var a, c string
		if err := rows.Scan(&h.Name, &h.Executable, &a, &h.Version, &c, &h.CheckedAt); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(a), &h.Args); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(c), &h.Capabilities); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

const runColumns = `id,task_id,holder,fencing_token,harness,model,purpose,read_only,prompt,status,thread_id,turn_id,process_pid,pending_request,result,error,created_at,updated_at`

func scanRun(row interface{ Scan(...any) error }) (Run, error) {
	var r Run
	var pending string
	err := row.Scan(&r.ID, &r.TaskID, &r.Holder, &r.FencingToken, &r.Harness, &r.Model, &r.Purpose, &r.ReadOnly, &r.Prompt, &r.Status, &r.ThreadID, &r.TurnID, &r.ProcessPID, &pending, &r.Result, &r.Error, &r.CreatedAt, &r.UpdatedAt)
	if pending != "" {
		r.PendingRequest = json.RawMessage(pending)
	}
	return r, err
}

func (s *Store) Get(id string) (Run, error) {
	return scanRun(s.DB.QueryRow(`SELECT `+runColumns+` FROM native_runs WHERE id=?`, id))
}
func (s *Store) List() ([]Run, error) {
	rows, err := s.DB.Query(`SELECT ` + runColumns + ` FROM native_runs ORDER BY created_at DESC LIMIT 100`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Run{}
	for rows.Next() {
		r, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Insert validates the live task ownership in the same transaction as launch reservation.
func (s *Store) Insert(in Start, repo string) (Run, bool, error) {
	if strings.TrimSpace(in.ID) == "" || len(in.ID) > 100 || strings.TrimSpace(in.Prompt) == "" || len(in.Prompt) > 100000 || in.Holder == "" || in.FencingToken <= 0 {
		return Run{}, false, errors.New("id, prompt, holder, and current claim token required")
	}
	if in.Harness != "codex" {
		return Run{}, false, errors.New("only the codex app-server adapter is enabled")
	}
	if in.Purpose != "implement" && in.Purpose != "review" && in.Purpose != "fix" {
		return Run{}, false, errors.New("purpose must be implement, review, or fix")
	}
	if in.Purpose == "review" && !in.ReadOnly {
		return Run{}, false, errors.New("review runs must be read-only")
	}
	raw, _ := json.Marshal(in)
	sum := sha256.Sum256(raw)
	hash := hex.EncodeToString(sum[:])
	tx, err := s.DB.Begin()
	if err != nil {
		return Run{}, false, err
	}
	defer tx.Rollback()
	var prior string
	err = tx.QueryRow(`SELECT request_hash FROM native_runs WHERE id=?`, in.ID).Scan(&prior)
	if err == nil {
		if prior != hash {
			return Run{}, false, errors.New("run id already belongs to a different request")
		}
		tx.Rollback()
		r, err := s.Get(in.ID)
		return r, false, err
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Run{}, false, err
	}
	var holder, state, path, expiry string
	var token int64
	err = tx.QueryRow(`SELECT l.holder,l.fencing_token,l.expires_at,t.state,t.repo_path FROM leases l JOIN tasks t ON t.id=l.task_id WHERE t.id=?`, in.TaskID).Scan(&holder, &token, &expiry, &state, &path)
	if err != nil {
		return Run{}, false, fmt.Errorf("task needs a live claim: %w", err)
	}
	expires, err := time.Parse(time.RFC3339Nano, expiry)
	if err != nil || !time.Now().Before(expires) || holder != in.Holder || token != in.FencingToken || state != "in_progress" || path != repo {
		return Run{}, false, errors.New("stale ownership or task outside this repository")
	}
	if !in.ReadOnly {
		var exclusive int
		var leaseExpiry string
		err = tx.QueryRow(`SELECT exclusive,expires_at FROM repo_leases WHERE repo_path=? AND task_id=?`, repo, in.TaskID).Scan(&exclusive, &leaseExpiry)
		expires, parseErr := time.Parse(time.RFC3339Nano, leaseExpiry)
		if err != nil || parseErr != nil || !time.Now().Before(expires) || exclusive != 1 {
			return Run{}, false, errors.New("editing requires an exclusive primary claim; dedicated worktree creation is not yet supported")
		}
	}
	t := now()
	_, err = tx.Exec(`INSERT INTO native_runs(id,task_id,holder,fencing_token,request_hash,harness,model,purpose,read_only,prompt,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'starting',?,?)`, in.ID, in.TaskID, in.Holder, in.FencingToken, hash, in.Harness, in.Model, in.Purpose, in.ReadOnly, in.Prompt, t, t)
	if err != nil {
		return Run{}, false, fmt.Errorf("reserve run (one active worker per project): %w", err)
	}
	if err = tx.Commit(); err != nil {
		return Run{}, false, err
	}
	r, err := s.Get(in.ID)
	return r, true, err
}

func (s *Store) Update(id, status, thread, turn, result, problem string) error {
	_, err := s.DB.Exec(`UPDATE native_runs SET status=?,thread_id=?,turn_id=?,result=?,error=?,updated_at=? WHERE id=?`, status, thread, turn, result, problem, now(), id)
	return err
}
func (s *Store) Append(id, method string, payload json.RawMessage) error {
	if !json.Valid(payload) {
		return errors.New("invalid event JSON")
	}
	_, err := s.DB.Exec(`INSERT INTO native_run_events(run_id,method,payload,created_at) VALUES(?,?,?,?)`, id, method, string(payload), now())
	return err
}
func (s *Store) Events(id string, after int64) ([]Event, error) {
	rows, err := s.DB.Query(`SELECT seq,method,payload,created_at FROM native_run_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 200`, id, after)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var e Event
		var p string
		if err := rows.Scan(&e.Seq, &e.Method, &p, &e.CreatedAt); err != nil {
			return nil, err
		}
		e.Payload = json.RawMessage(p)
		out = append(out, e)
	}
	return out, rows.Err()
}

func (s *Store) InterruptActive() error {
	_, err := s.DB.Exec(`UPDATE native_runs SET status='interrupted',pending_request='',error='Supervisor stopped; native reattachment has not been verified',updated_at=? WHERE status IN ('starting','running','cancelling','attention_required')`, now())
	return err
}
