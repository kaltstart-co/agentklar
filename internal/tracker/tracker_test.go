package tracker

import (
	"strings"
	"testing"
	"time"
)

const nonce = "9f2c4a1b8e7d6c5f4a3b2c1d0e9f8a7b"

func policy() ApprovalPolicy {
	return ApprovalPolicy{ServiceAccountID: "svc-agentklar", HumanAccountIDs: []string{"u-divyansh"}}
}

func comment(authorID, body string) Comment {
	return Comment{TaskID: "T1", AuthorID: authorID, Author: authorID, Body: body, CreatedAt: time.Now()}
}

// The happy path: a human account writing the directive approves.
func TestHumanApprovalAccepted(t *testing.T) {
	d, err := ParseApproval(comment("u-divyansh", "looks good, approve "+nonce), nonce, policy())
	if err != nil {
		t.Fatalf("expected approval, got %v", err)
	}
	if !d.Approve || d.Channel != "tracker_comment" {
		t.Fatalf("unexpected decision: %+v", d)
	}
}

// The security boundary: Agentklar's own service account can never
// approve, even with a perfectly valid nonce. Otherwise a projection
// write could complete its own task.
func TestServiceAccountCannotApprove(t *testing.T) {
	_, err := ParseApproval(comment("svc-agentklar", "approve "+nonce), nonce, policy())
	if err != ErrServiceAccount {
		t.Fatalf("expected ErrServiceAccount, got %v", err)
	}
}

// An account outside the allowlist cannot approve even with the nonce.
func TestUnknownAccountCannotApprove(t *testing.T) {
	_, err := ParseApproval(comment("u-stranger", "approve "+nonce), nonce, policy())
	if err != ErrNotHumanActor {
		t.Fatalf("expected ErrNotHumanActor, got %v", err)
	}
}

// A comment for a different (e.g. older) nonce is not a decision on this
// submission — this is what binds approval to an exact review snapshot.
func TestWrongNonceRejected(t *testing.T) {
	other := "00000000000000000000000000000000"
	if _, err := ParseApproval(comment("u-divyansh", "approve "+other), nonce, policy()); err != ErrNoDirective {
		t.Fatalf("expected ErrNoDirective for mismatched nonce, got %v", err)
	}
}

// Prose that merely discusses approval is not approval.
func TestProseIsNotApproval(t *testing.T) {
	bodies := []string{
		"I think we should approve this once CI is green",
		"approved!",
		"lgtm",
		"approve",
	}
	for _, b := range bodies {
		if _, err := ParseApproval(comment("u-divyansh", b), nonce, policy()); err == nil {
			t.Fatalf("prose accepted as approval: %q", b)
		}
	}
}

// Rejection is parsed distinctly and carries the reason forward.
func TestRejectionParsed(t *testing.T) {
	d, err := ParseApproval(comment("u-divyansh", "reject "+nonce+" — the retry loop is unbounded"), nonce, policy())
	if err != nil {
		t.Fatal(err)
	}
	if d.Approve {
		t.Fatal("rejection parsed as approval")
	}
}

// An empty author (e.g. a webhook missing actor identity) is never trusted.
func TestMissingAuthorRejected(t *testing.T) {
	if _, err := ParseApproval(comment("", "approve "+nonce), nonce, policy()); err != ErrNotHumanActor {
		t.Fatalf("expected ErrNotHumanActor for empty author, got %v", err)
	}
}

// The pending-approval comment must give the human a copy-pasteable
// directive and state that moving the card is not approval.
func TestPendingApprovalCommentIsActionable(t *testing.T) {
	body := PendingApprovalComment("T1", nonce, "abcdef1234567890", []string{"criterion one"})
	if !strings.Contains(body, "approve "+nonce) {
		t.Fatal("comment lacks a copy-pasteable approve directive")
	}
	if !strings.Contains(body, "reject "+nonce) {
		t.Fatal("comment lacks a reject directive")
	}
	if !strings.Contains(strings.ToLower(body), "moving this card alone does not") {
		t.Fatal("comment must state that a card move is not approval")
	}
	if !strings.Contains(body, "criterion one") {
		t.Fatal("comment should list verified acceptance criteria")
	}
}

// Echo suppression: Agentklar's own projection writes are fingerprinted so
// reconciliation cannot mistake them for human requests and loop.
func TestFingerprintDistinguishesActors(t *testing.T) {
	own := Fingerprint("T1", "done", "svc-agentklar")
	human := Fingerprint("T1", "done", "u-divyansh")
	if own == human {
		t.Fatal("fingerprints must distinguish service-account writes from human requests")
	}
}
