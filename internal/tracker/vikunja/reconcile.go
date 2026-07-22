package vikunja

import (
	"fmt"

	"github.com/kaltstart-co/agentklar/internal/tracker"
	"github.com/kaltstart-co/agentklar/internal/workflow"
)

// Reconciler applies validated human approvals found in tracker comments to
// the workflow engine. It is the bridge between the untrusted tracker and
// the protected state machine: only a comment authored by an allowed human
// account, carrying the task's live nonce, moves a task to Done.
type Reconciler struct {
	Engine  *workflow.Engine
	Client  *Client // service-account client (reads comments, posts prompts)
	Policy  tracker.ApprovalPolicy
	Project int64
}

// PostPendingPrompt posts the copy-pasteable approval prompt as the service
// account when a task enters User Approval. Returned nonce stays server-side.
func (r *Reconciler) PostPendingPrompt(taskID string, trackerTaskID int64, headCommit string, criteria []string) error {
	nonce, _, err := r.Engine.PendingApproval(taskID)
	if err != nil {
		return err
	}
	body := tracker.PendingApprovalComment(taskID, nonce, headCommit, criteria)
	_, err = r.Client.PostComment(trackerTaskID, body)
	return err
}

// ReconcileTask reads a tracker task's comments and applies the first valid
// human approval/rejection for the pending nonce. It is safe to call
// repeatedly: once decided, the nonce is spent and later calls are no-ops.
//
// Returns the decision applied, or nil if none was found.
func (r *Reconciler) ReconcileTask(taskID string, trackerTaskID int64) (*tracker.Decision, error) {
	nonce, _, err := r.Engine.PendingApproval(taskID)
	if err != nil {
		return nil, nil // no pending approval — nothing to reconcile
	}
	comments, err := r.Client.ListComments(trackerTaskID)
	if err != nil {
		return nil, err
	}
	for _, cm := range comments {
		// Echo suppression: skip anything authored by the service account,
		// including our own pending-approval prompt.
		if cm.Author.ID == r.svcID() {
			continue
		}
		c := tracker.Comment{
			TaskID:    taskID,
			AuthorID:  fmt.Sprintf("%d", cm.Author.ID),
			Author:    cm.Author.Username,
			Body:      cm.Body,
			CreatedAt: cm.Created,
		}
		decision, err := tracker.ParseApproval(c, nonce, r.Policy)
		if err != nil {
			continue // not a valid directive from an allowed human — ignore
		}
		// Apply to the protected state machine. This is the ONLY path that
		// can reach Done, and it originates from a human tracker account.
		if err := r.Engine.ResolveApproval(taskID, decision.Nonce, decision.Approve,
			decision.Actor, decision.Channel); err != nil {
			return nil, err
		}
		// Project the terminal state back onto the board.
		if decision.Approve {
			_ = r.Client.SetDone(trackerTaskID, true)
		}
		return decision, nil
	}
	return nil, nil
}

func (r *Reconciler) svcID() int64 {
	id, _ := r.Client.CurrentUserID()
	return id
}
