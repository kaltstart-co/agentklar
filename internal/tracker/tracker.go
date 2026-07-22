// Package tracker defines field authority between Agentklar and the
// tracker, plus the trusted human-approval channel.
//
// Authority split (spec §6.3): the tracker owns task content, assignees,
// comments, and attachments. control.sqlite owns protected workflow state,
// leases, evidence attestations, review snapshots, and approvals. Tracker
// buckets are a projection of protected state, never an approval boundary.
package tracker

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

var (
	ErrNotHumanActor  = errors.New("approval comment was not authored by an allowed human account")
	ErrServiceAccount = errors.New("approval attempted by the agentklar service account")
	ErrNoDirective    = errors.New("comment contains no approve/reject directive with a valid nonce")
)

// Comment is a tracker comment as delivered by webhook or polling.
type Comment struct {
	TaskID    string
	AuthorID  string
	Author    string
	Body      string
	CreatedAt time.Time
}

// Decision is a validated human approval decision ready to be applied to
// the workflow engine. It is produced ONLY by ParseApproval.
type Decision struct {
	TaskID  string
	Nonce   string
	Approve bool
	Actor   string
	Channel string // "tracker_comment" | "elicitation"
}

// ApprovalPolicy names the accounts trusted to approve. The Agentklar
// service account is explicitly excluded: it writes projections, and a
// projection write must never be able to approve its own task.
type ApprovalPolicy struct {
	// ServiceAccountID is Agentklar's own tracker identity.
	ServiceAccountID string
	// HumanAccountIDs are the accounts allowed to approve. Empty means
	// "any account that is not the service account" — acceptable for the
	// single-user lightweight profile, tightened in the full profile.
	HumanAccountIDs []string
}

func (p ApprovalPolicy) allows(authorID string) error {
	if authorID == "" {
		return ErrNotHumanActor
	}
	if authorID == p.ServiceAccountID {
		return ErrServiceAccount
	}
	if len(p.HumanAccountIDs) == 0 {
		return nil
	}
	for _, id := range p.HumanAccountIDs {
		if id == authorID {
			return nil
		}
	}
	return ErrNotHumanActor
}

// directive matches the copy-pasteable reply Agentklar posts in its
// pending-approval comment, e.g. "approve 9f2c...". Case-insensitive and
// tolerant of surrounding prose so a human can add reasoning.
var directive = regexp.MustCompile(`(?i)\b(approve|reject)\s+([0-9a-f]{32})\b`)

// ParseApproval validates that a tracker comment constitutes a trusted
// human approval for the given pending nonce.
//
// The security boundary is the comment's AUTHOR identity — an account
// whose credentials Agentklar never stores and never exposes to agent
// processes. The nonce binds the decision to a specific submission and
// expiry; it is not itself a secret that grants authority.
func ParseApproval(c Comment, expectedNonce string, policy ApprovalPolicy) (*Decision, error) {
	if err := policy.allows(c.AuthorID); err != nil {
		return nil, err
	}
	m := directive.FindStringSubmatch(c.Body)
	if m == nil {
		return nil, ErrNoDirective
	}
	if !strings.EqualFold(m[2], expectedNonce) {
		return nil, ErrNoDirective
	}
	return &Decision{
		TaskID:  c.TaskID,
		Nonce:   strings.ToLower(m[2]),
		Approve: strings.EqualFold(m[1], "approve"),
		Actor:   c.Author,
		Channel: "tracker_comment",
	}, nil
}

// PendingApprovalComment renders the comment Agentklar posts when a task
// enters User Approval. It contains a pre-formatted reply so approving is
// a copy-paste, not a transcription (addresses approval-UX friction).
func PendingApprovalComment(taskID, nonce, headCommit string, criteria []string) string {
	var b strings.Builder
	b.WriteString("**Agentklar: awaiting your approval**\n\n")
	fmt.Fprintf(&b, "Task `%s` passed Completion Review and Auto QA at commit `%s`.\n\n", taskID, shortSHA(headCommit))
	if len(criteria) > 0 {
		b.WriteString("Acceptance criteria verified:\n")
		for _, c := range criteria {
			fmt.Fprintf(&b, "- %s\n", c)
		}
		b.WriteString("\n")
	}
	b.WriteString("To finish this task, reply **as yourself** (not through an agent) with one of:\n\n")
	fmt.Fprintf(&b, "```\napprove %s\n```\n\n", nonce)
	fmt.Fprintf(&b, "```\nreject %s — <what needs to change>\n```\n\n", nonce)
	b.WriteString("_Moving this card alone does not complete the task. ")
	b.WriteString("Agentklar accepts the decision only from your tracker account._\n")
	return b.String()
}

func shortSHA(s string) string {
	if len(s) > 12 {
		return s[:12]
	}
	return s
}

// Outbox fingerprints let reconciliation distinguish Agentklar's own
// projection writes (echoes) from genuine human requests (spec §10.10).
func Fingerprint(taskID, state, actor string) string {
	return fmt.Sprintf("%s|%s|%s", taskID, state, actor)
}

// NonceRegexp matches a bare approval nonce, for locating the nonce inside
// a posted tracker comment (e.g. when a human reads it back). It does not
// validate authority — that is ParseApproval's job.
func NonceRegexp() *regexp.Regexp {
	return regexp.MustCompile(`[0-9a-f]{32}`)
}
