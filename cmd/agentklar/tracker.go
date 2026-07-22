package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/kaltstart-co/agentklar/internal/contracts"
	"github.com/kaltstart-co/agentklar/internal/tracker"
	"github.com/kaltstart-co/agentklar/internal/tracker/vikunja"
)

// cmdTracker binds a workspace to a live Vikunja board using a dedicated
// service account, and shares the board with the human approver.
func cmdTracker(args []string) error {
	if len(args) < 1 || args[0] != "connect" {
		return fmt.Errorf("usage: agentklar tracker connect --url URL --svc-user U --svc-pass P --human USER [--project NAME]")
	}
	fs := flag.NewFlagSet("tracker connect", flag.ContinueOnError)
	url := fs.String("url", "http://localhost:3456/api/v1", "Vikunja API base URL")
	svcUser := fs.String("svc-user", "", "Agentklar service account username")
	svcPass := fs.String("svc-pass", "", "service account password")
	human := fs.String("human", "", "human approver username")
	project := fs.String("project", "Agentklar Board", "board/project title")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if *svcUser == "" || *svcPass == "" || *human == "" {
		return fmt.Errorf("--svc-user, --svc-pass, and --human are required")
	}

	_, dir, err := openEngine()
	if err != nil {
		return err
	}
	svc, err := vikunja.Login(*url, *svcUser, *svcPass)
	if err != nil {
		return fmt.Errorf("service login: %w", err)
	}
	svcID, _ := svc.CurrentUserID()
	proj, err := svc.EnsureProject(*project)
	if err != nil {
		return err
	}
	if err := svc.ShareWithUser(proj.ID, *human, 2); err != nil {
		return fmt.Errorf("share board with %s: %w", *human, err)
	}
	cfg := &vikunja.Config{
		URL: *url, ProjectID: proj.ID, ServiceToken: svc.Token,
		ServiceUser: *svcUser, ServiceID: svcID, HumanUser: *human,
	}
	if err := cfg.Save(dir); err != nil {
		return err
	}
	fmt.Printf("connected to %s\n  project: %s (id %d)\n  service account: %s (id %d)\n  approver: %s\n",
		*url, proj.Title, proj.ID, *svcUser, svcID, *human)
	return nil
}

// cmdReconcile pulls comments for every task in User Approval and applies
// the first valid human approval/rejection. This is the missed-webhook and
// no-daemon reconciliation path.
func cmdReconcile() error {
	eng, dir, err := openEngine()
	if err != nil {
		return err
	}
	cfg, err := vikunja.LoadConfig(dir)
	if err != nil {
		return err
	}
	if cfg == nil {
		return fmt.Errorf("no tracker connected; run 'agentklar tracker connect' first")
	}
	rec := &vikunja.Reconciler{
		Engine: eng, Client: cfg.Client(), Project: cfg.ProjectID,
		Policy: tracker.ApprovalPolicy{
			ServiceAccountID: fmt.Sprintf("%d", cfg.ServiceID),
			HumanAccountIDs:  nil, // any non-service account in the single-user profile
		},
	}
	tasks, err := eng.ListAll()
	if err != nil {
		return err
	}
	applied := 0
	for _, t := range tasks {
		if t.State != contracts.StateUserApproval || t.TrackerID == "" {
			continue
		}
		var tid int64
		fmt.Sscanf(t.TrackerID, "%d", &tid)
		decision, err := rec.ReconcileTask(t.ID, tid)
		if err != nil {
			fmt.Fprintf(os.Stderr, "reconcile %s: %v\n", t.ID, err)
			continue
		}
		if decision != nil {
			after, _ := eng.GetTask(t.ID)
			verb := "approved"
			if !decision.Approve {
				verb = "rejected"
			}
			fmt.Printf("%s %s by %s → %s\n", t.ID, verb, decision.Actor, after.State)
			applied++
		}
	}
	if applied == 0 {
		fmt.Println("no pending human decisions found")
	}
	return nil
}
