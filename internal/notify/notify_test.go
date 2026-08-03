package notify

import (
	"sync"
	"testing"
	"time"
)

// overrideDeliver swaps in a recording deliver and returns a function to read
// the call count safely. This guarantees tests never invoke the real
// say/osascript/notify-send.
func overrideDeliver(s *Store) func() int {
	var (
		mu    sync.Mutex
		calls int
	)
	s.deliver = func(string, Severity) {
		mu.Lock()
		defer mu.Unlock()
		calls++
	}
	return func() int {
		mu.Lock()
		defer mu.Unlock()
		return calls
	}
}

func TestNewIdempotent(t *testing.T) {
	dir := t.TempDir()

	s1, err := New(dir)
	if err != nil {
		t.Fatalf("first New: %v", err)
	}
	s1.deliver = func(string, Severity) {}
	id, err := s1.Record("T1", "codex", Info, "seed", false)
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	if id != 1 {
		t.Fatalf("seed id = %d want 1", id)
	}
	if err := s1.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	s2, err := New(dir)
	if err != nil {
		t.Fatalf("second New on same dir: %v", err)
	}
	defer s2.Close()
	s2.deliver = func(string, Severity) {}

	all, err := s2.List("")
	if err != nil {
		t.Fatalf("List after reopen: %v", err)
	}
	if len(all) != 1 || all[0].Message != "seed" {
		t.Fatalf("data not preserved across reopen: %+v", all)
	}

	// Idempotent migrate must not reset the autoincrement; ids keep climbing.
	next, err := s2.Record("T1", "codex", Info, "second", false)
	if err != nil {
		t.Fatalf("record after reopen: %v", err)
	}
	if next <= id {
		t.Fatalf("id should keep increasing: got %d after %d", next, id)
	}
}

func TestRecordStoresProvenanceAndIncreasingIDs(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer s.Close()
	s.deliver = func(string, Severity) {}

	var prev int64
	for i := 0; i < 3; i++ {
		id, err := s.Record("TASK-7", "gemini", Warn, "blocked on input", false)
		if err != nil {
			t.Fatalf("record %d: %v", i, err)
		}
		if id <= prev {
			t.Fatalf("ids must increase: got %d after %d", id, prev)
		}
		prev = id
		time.Sleep(2 * time.Millisecond)
	}

	all, err := s.List("")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("expected 3 alerts, got %d", len(all))
	}
	a := all[0] // newest first
	if a.TaskID != "TASK-7" || a.Holder != "gemini" || a.Severity != Warn {
		t.Fatalf("provenance mismatch: %+v", a)
	}
	if a.Message != "blocked on input" {
		t.Fatalf("message mismatch: %q", a.Message)
	}
	if a.CreatedAt == "" || a.Acknowledged {
		t.Fatalf("created_at empty or already acked: %+v", a)
	}
}

func TestRecordFiresDeliver(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer s.Close()

	var (
		mu    sync.Mutex
		calls int
		lastM string
		lastS Severity
	)
	s.deliver = func(m string, sv Severity) {
		mu.Lock()
		defer mu.Unlock()
		calls++
		lastM = m
		lastS = sv
	}

	// Info is below the speak threshold, so speak=true must be what triggers it.
	if _, err := s.Record("T1", "codex", Info, "explicit speak", true); err != nil {
		t.Fatalf("record: %v", err)
	}
	// deliver runs in a goroutine; poll briefly for it to land.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		c := calls
		mu.Unlock()
		if c == 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if calls != 1 {
		t.Fatalf("deliver call count = %d want 1", calls)
	}
	if lastM != "explicit speak" || lastS != Info {
		t.Fatalf("deliver args mismatch: msg=%q sev=%q", lastM, lastS)
	}
}

func TestSpeakGating(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer s.Close()
	calls := overrideDeliver(s)

	// Info with speak=false: must NOT deliver.
	if _, err := s.Record("T", "codex", Info, "quiet info", false); err != nil {
		t.Fatalf("record info: %v", err)
	}
	// Give any errant goroutine a chance to land and fail the assertion.
	time.Sleep(20 * time.Millisecond)
	if got := calls(); got != 0 {
		t.Fatalf("Info speak=false should not deliver: calls=%d", got)
	}

	// Block with speak=false: warn/error/block always deliver.
	if _, err := s.Record("T", "codex", Block, "blocked", false); err != nil {
		t.Fatalf("record block: %v", err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if calls() == 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if got := calls(); got != 1 {
		t.Fatalf("Block speak=false should deliver once: calls=%d", got)
	}
}

func TestListNewestFirstAndFilter(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer s.Close()
	s.deliver = func(string, Severity) {}

	idInfo, _ := s.Record("T", "codex", Info, "first", false)
	time.Sleep(2 * time.Millisecond)
	idWarn, _ := s.Record("T", "codex", Warn, "second", false)
	time.Sleep(2 * time.Millisecond)
	idErr, _ := s.Record("T", "codex", Error, "third", false)

	all, err := s.List("")
	if err != nil {
		t.Fatalf("List all: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("expected 3, got %d", len(all))
	}
	if all[0].ID != idErr || all[1].ID != idWarn || all[2].ID != idInfo {
		t.Fatalf("newest-first order wrong: %v", idsOf(all))
	}

	warns, err := s.List(Warn)
	if err != nil {
		t.Fatalf("List Warn: %v", err)
	}
	if len(warns) != 1 || warns[0].ID != idWarn {
		t.Fatalf("Warn filter wrong: %+v", warns)
	}
}

func TestPendingAndAck(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer s.Close()
	s.deliver = func(string, Severity) {}

	id1, _ := s.Record("T", "codex", Block, "one", false)
	id2, _ := s.Record("T", "codex", Block, "two", false)

	pending, err := s.Pending()
	if err != nil {
		t.Fatalf("Pending: %v", err)
	}
	if len(pending) != 2 {
		t.Fatalf("expected 2 pending, got %d", len(pending))
	}

	if err := s.Ack(id1); err != nil {
		t.Fatalf("Ack: %v", err)
	}

	pending, err = s.Pending()
	if err != nil {
		t.Fatalf("Pending after ack: %v", err)
	}
	if len(pending) != 1 || pending[0].ID != id2 {
		t.Fatalf("ack did not remove from pending: %v", idsOf(pending))
	}

	all, err := s.List("")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	for _, a := range all {
		if a.ID == id1 && !a.Acknowledged {
			t.Fatalf("ack did not flip Acknowledged: %+v", a)
		}
	}

	// Ack on a missing id must surface as an error.
	if err := s.Ack(99999); err == nil {
		t.Fatal("Ack on missing id should error")
	}
}

func idsOf(as []Alert) []int64 {
	out := make([]int64, len(as))
	for i, a := range as {
		out[i] = a.ID
	}
	return out
}
