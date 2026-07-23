package vikunja

import (
	"testing"

	"github.com/kaltstart-co/agentklar/internal/contracts"
)

// Every workflow state that has a column maps to a real WorkflowBuckets entry,
// and the human/terminal states land where the board expects them.
func TestBucketForStateCoversWorkflow(t *testing.T) {
	set := map[string]bool{}
	for _, b := range WorkflowBuckets {
		set[b] = true
	}
	cases := map[contracts.State]string{
		contracts.StateDraft:            "Draft",
		contracts.StateReady:            "Ready",
		contracts.StateInProgress:       "In Progress",
		contracts.StateCompletionReview: "Completion Review",
		contracts.StateAutoQA:           "Auto QA",
		contracts.StateChangesRequested: "Changes Requested",
		contracts.StateUserApproval:     "User Approval",
		contracts.StateDone:             "Done",
	}
	for state, want := range cases {
		got := BucketTitle(state)
		if got != want {
			t.Errorf("state %s: got column %q, want %q", state, got, want)
		}
		if !set[got] {
			t.Errorf("column %q for state %s is not in WorkflowBuckets", got, state)
		}
	}
}

// Exceptional states have no column, so a card is left where it is.
func TestExceptionalStatesHaveNoColumn(t *testing.T) {
	for _, s := range []contracts.State{contracts.StateWaiting, contracts.StateBlocked, contracts.StateCancelled} {
		if got := BucketTitle(s); got != "" {
			t.Errorf("state %s should have no column, got %q", s, got)
		}
	}
}
