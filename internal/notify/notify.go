// Package notify is Agentklar's human-alert system. An agent that is blocked,
// needs input, hit an error (e.g. network down), or finished and wants more
// work calls into here to record an alert and optionally speak/notify the
// human.
//
// Every alert is logged with provenance (task, holder, time) and is
// human-visible: agents can record but never delete or acknowledge their own
// alerts. Acknowledgement is a human-only action exposed only on the local
// trusted channel.
package notify

import (
	"context"
	"database/sql"
	"fmt"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// Severity classifies an alert's importance and drives delivery.
type Severity string

const (
	Info  Severity = "info"
	Warn  Severity = "warn"
	Error Severity = "error"
	Block Severity = "block"
)

// Alert is one recorded human-facing alert with provenance.
type Alert struct {
	ID           int64
	TaskID       string
	Holder       string
	Severity     Severity
	Message      string
	CreatedAt    string // UTC RFC3339Nano
	Acknowledged bool
}

// Store is a handle on alerts.sqlite. Methods are safe for concurrent use
// because the underlying connection pool is serialized (SetMaxOpenConns(1)).
//
// deliver is the platform-default notification hook chosen in New and may be
// replaced by callers in the same package (notably tests) to avoid invoking
// the real say/osascript/notify-send.
type Store struct {
	db      *sql.DB
	deliver func(msg string, sev Severity)
}

const schema = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS alerts (
    id           INTEGER PRIMARY KEY,
    task_id      TEXT NOT NULL DEFAULT '',
    holder       TEXT NOT NULL DEFAULT '',
    severity     TEXT NOT NULL,
    message      TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    acknowledged INTEGER NOT NULL DEFAULT 0
);
`

// New opens (creating if needed) <workspaceDir>/alerts.sqlite, ensures the
// schema, and wires the platform-default delivery function selected via
// runtime.GOOS. Idempotent: safe to call repeatedly on the same directory.
func New(workspaceDir string) (*Store, error) {
	db, err := sql.Open("sqlite", filepath.Join(workspaceDir, "alerts.sqlite"))
	if err != nil {
		return nil, fmt.Errorf("open alerts.sqlite: %w", err)
	}
	// modernc/sqlite serializes writes; a single connection avoids SQLITE_BUSY
	// between our own statements and keeps per-connection PRAGMAs stable.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate alerts.sqlite: %w", err)
	}
	return &Store{db: db, deliver: defaultDeliver(runtime.GOOS)}, nil
}

// Record inserts an alert (always logged, with provenance) and, when speak is
// true OR severity is warn/error/block, fires deliver in a goroutine
// (best-effort, never blocks, errors ignored). Returns the new alert id.
func (s *Store) Record(taskID, holder string, sev Severity, message string, speak bool) (int64, error) {
	// RFC3339Nano is RFC3339-compliant; sub-second precision lets newest-first
	// ordering be observable without sleeps.
	now := time.Now().UTC().Format(time.RFC3339Nano)
	res, err := s.db.Exec(`
        INSERT INTO alerts (task_id, holder, severity, message, created_at, acknowledged)
        VALUES (?, ?, ?, ?, ?, 0)`,
		taskID, holder, string(sev), message, now)
	if err != nil {
		return 0, fmt.Errorf("record alert: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("record alert id: %w", err)
	}
	// Best-effort delivery: fire-and-forget so Record returns immediately. A
	// wedged `say` cannot hang the caller because deliver bounds each command
	// with a context timeout.
	if s.deliver != nil && (speak || shouldSpeak(sev)) {
		msg, sv := message, sev
		go s.deliver(msg, sv)
	}
	return id, nil
}

// shouldSpeak reports whether sev forces delivery regardless of the speak flag.
func shouldSpeak(sev Severity) bool {
	return sev == Warn || sev == Error || sev == Block
}

// List returns alerts newest-first, optionally filtered by severity ("" = all).
func (s *Store) List(sev Severity) ([]Alert, error) {
	var (
		rows *sql.Rows
		err  error
	)
	if sev == "" {
		rows, err = s.db.Query(`
            SELECT id, task_id, holder, severity, message, created_at, acknowledged
            FROM alerts
            ORDER BY created_at DESC, id DESC`)
	} else {
		rows, err = s.db.Query(`
            SELECT id, task_id, holder, severity, message, created_at, acknowledged
            FROM alerts
            WHERE severity = ?
            ORDER BY created_at DESC, id DESC`, string(sev))
	}
	if err != nil {
		return nil, fmt.Errorf("list alerts: %w", err)
	}
	defer rows.Close()
	return scanAlerts(rows)
}

// Pending returns unacknowledged alerts, newest-first.
func (s *Store) Pending() ([]Alert, error) {
	rows, err := s.db.Query(`
        SELECT id, task_id, holder, severity, message, created_at, acknowledged
        FROM alerts
        WHERE acknowledged = 0
        ORDER BY created_at DESC, id DESC`)
	if err != nil {
		return nil, fmt.Errorf("pending alerts: %w", err)
	}
	defer rows.Close()
	return scanAlerts(rows)
}

// Ack marks an alert acknowledged. This is a human action; there is no agent
// path to ack (agents cannot silence alerts they raised). Returns an error if
// no row matches id.
func (s *Store) Ack(id int64) error {
	res, err := s.db.Exec(`UPDATE alerts SET acknowledged = 1 WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("ack alert: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("ack alert rows: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("ack alert: no row with id %d", id)
	}
	return nil
}

// Close releases the database handle.
func (s *Store) Close() error { return s.db.Close() }

// SetDeliver overrides the delivery function (e.g. to silence it in tests or
// to route alerts to a custom sink). Pass nil to make delivery a no-op.
func (s *Store) SetDeliver(f func(msg string, sev Severity)) {
	if f == nil {
		f = func(string, Severity) {}
	}
	s.deliver = f
}

func scanAlerts(rows *sql.Rows) ([]Alert, error) {
	var out []Alert
	for rows.Next() {
		var (
			a     Alert
			sev   string
			acked int
		)
		if err := rows.Scan(&a.ID, &a.TaskID, &a.Holder, &sev, &a.Message, &a.CreatedAt, &acked); err != nil {
			return nil, err
		}
		a.Severity = Severity(sev)
		a.Acknowledged = acked != 0
		out = append(out, a)
	}
	return out, rows.Err()
}

// defaultDeliver selects the platform-default delivery function for the given
// GOOS. Delivery is always best-effort and never fatal; a nil-effect function
// is returned for unsupported platforms.
func defaultDeliver(goos string) func(string, Severity) {
	switch goos {
	case "darwin":
		return deliverDarwin
	case "linux":
		return deliverLinux
	default:
		return func(string, Severity) {}
	}
}

// deliverDarwin speaks the message with `say` and posts a macOS notification
// via `osascript`, in parallel goroutines. Each command is bounded by a 10s
// context so a wedged helper cannot leak the goroutine. The osascript payload
// is sanitized so embedded quotes/backslashes cannot break the -e string.
func deliverDarwin(msg string, sev Severity) {
	sayCtx, sayCancel := context.WithTimeout(context.Background(), 10*time.Second)
	go func() {
		defer sayCancel()
		_ = exec.CommandContext(sayCtx, "say", msg).Run()
	}()

	osaCtx, osaCancel := context.WithTimeout(context.Background(), 10*time.Second)
	go func() {
		defer osaCancel()
		script := fmt.Sprintf(`display notification "%s" with title "Agentklar" subtitle "%s"`,
			sanitizeApple(msg), string(sev))
		_ = exec.CommandContext(osaCtx, "osascript", "-e", script).Run()
	}()
}

// sanitizeApple replaces characters that would break an osascript -e string:
// backslashes and double quotes become spaces, leaving a payload that is safe
// to embed between literal double quotes in the display-notification script.
func sanitizeApple(s string) string {
	r := strings.NewReplacer(`\`, " ", `"`, " ")
	return r.Replace(s)
}

// deliverLinux posts a desktop notification via notify-send if it is on PATH;
// otherwise it is a no-op. The command is bounded by a 10s context and errors
// are ignored.
func deliverLinux(msg string, _ Severity) {
	if _, err := exec.LookPath("notify-send"); err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = exec.CommandContext(ctx, "notify-send", "Agentklar", msg).Run()
}
