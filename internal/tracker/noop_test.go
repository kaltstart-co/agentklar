package tracker

import (
	"testing"

	"github.com/kaltstart-co/agentklar/internal/contracts"
)

// Noop is the default tracker backend when nothing is configured: it must be
// fully inert so the core workflow runs tracker-less.
func TestNoopIsInert(t *testing.T) {
	var tr Tracker = Noop{}
	if tr.Configured() {
		t.Fatal("Noop must report Configured()=false")
	}
	if err := tr.PlaceCard("123", contracts.StateDone); err != nil {
		t.Fatalf("Noop.PlaceCard must be a no-op, got %v", err)
	}
	// Empty trackerID must also be safe.
	if err := tr.PlaceCard("", contracts.StateDraft); err != nil {
		t.Fatalf("Noop.PlaceCard(\"\") must be a no-op, got %v", err)
	}
}
