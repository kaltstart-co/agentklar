package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/kaltstart-co/agentklar/internal/contracts"
	"github.com/kaltstart-co/agentklar/internal/tracker"
	"github.com/kaltstart-co/agentklar/internal/tracker/vikunja"
)

func cmdTracker(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: agentklar tracker connect|sync ...")
	}
	switch args[0] {
	case "connect":
		return trackerConnect(args[1:])
	case "sync":
		return trackerSync()
	default:
		return fmt.Errorf("unknown tracker subcommand %q (want: connect | sync)", args[0])
	}
}

// trackerConnect binds a workspace to a Vikunja board — a new instance or one
// you already run. Authenticate with a service account (--svc-user/--svc-pass)
// or an existing API token (--svc-token). It ensures the project exists,
// shares it with the human approver, and creates the workflow columns.
func trackerConnect(args []string) error {
	fs := flag.NewFlagSet("tracker connect", flag.ContinueOnError)
	url := fs.String("url", "http://localhost:3456/api/v1", "Vikunja API base URL")
	svcUser := fs.String("svc-user", "", "service account username")
	svcPass := fs.String("svc-pass", "", "service account password")
	svcToken := fs.String("svc-token", "", "existing Vikunja API token (instead of user/pass)")
	human := fs.String("human", "", "human approver username")
	project := fs.String("project", "Agentklar", "board/project title")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *human == "" {
		return fmt.Errorf("--human is required (the account that approves)")
	}

	_, dir, err := openEngine()
	if err != nil {
		return err
	}

	var svc *vikunja.Client
	if *svcToken != "" {
		svc = vikunja.New(*url, *svcToken)
	} else if *svcUser != "" && *svcPass != "" {
		svc, err = vikunja.Login(*url, *svcUser, *svcPass)
		if err != nil {
			return fmt.Errorf("service login: %w", err)
		}
	} else {
		return fmt.Errorf("provide either --svc-token or both --svc-user and --svc-pass")
	}

	svcID, err := svc.CurrentUserID()
	if err != nil {
		return fmt.Errorf("could not read the service account (bad token or credentials?): %w", err)
	}
	proj, err := svc.EnsureProject(*project)
	if err != nil {
		return err
	}
	if err := svc.ShareWithUser(proj.ID, *human, 2); err != nil {
		return fmt.Errorf("share board with %s: %w", *human, err)
	}
	if _, err := svc.EnsureBoard(proj.ID); err != nil {
		fmt.Fprintf(os.Stderr, "warning: could not set up board columns: %v\n", err)
	}

	cfg := &vikunja.Config{
		URL: *url, ProjectID: proj.ID, ServiceToken: svc.Token,
		ServiceUser: *svcUser, ServiceID: svcID, HumanUser: *human,
	}
	if err := cfg.Save(dir); err != nil {
		return err
	}
	fmt.Printf("connected to %s\n  project: %s (id %d)\n  service account id: %d\n  approver: %s\n  columns: %d workflow buckets ready\n",
		*url, proj.Title, proj.ID, svcID, *human, len(vikunja.WorkflowBuckets))
	fmt.Println("  run 'agentklar tracker sync' to place existing cards")
	return nil
}

// trackerSync places every projected task's card in the column that matches
// its current state. Run it any time to bring the board up to date.
func trackerSync() error {
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
	svc := cfg.Client()
	board, err := svc.EnsureBoard(cfg.ProjectID)
	if err != nil {
		return err
	}
	tasks, err := eng.ListAll()
	if err != nil {
		return err
	}
	n := 0
	for _, t := range tasks {
		if t.TrackerID == "" {
			continue
		}
		var tid int64
		fmt.Sscanf(t.TrackerID, "%d", &tid)
		if err := board.PlaceTask(svc, tid, t.State); err != nil {
			fmt.Fprintf(os.Stderr, "sync %s: %v\n", t.ID, err)
			continue
		}
		n++
	}
	fmt.Printf("synced %d cards to the board\n", n)
	return nil
}

// placeCard moves one task's card to its state column, best-effort. Used by
// task/gate/approve so the board tracks state without a manual sync. It never
// fails the calling command — a missing or offline tracker is non-fatal.
func placeCard(dir, trackerID string, state contracts.State) {
	if trackerID == "" {
		return
	}
	cfg, err := vikunja.LoadConfig(dir)
	if err != nil || cfg == nil {
		return
	}
	svc := cfg.Client()
	board, err := svc.EnsureBoard(cfg.ProjectID)
	if err != nil {
		return
	}
	var tid int64
	fmt.Sscanf(trackerID, "%d", &tid)
	_ = board.PlaceTask(svc, tid, state)
}

// cmdReconcile pulls comments for every task in User Approval and applies the
// first valid human approval/rejection. Missed-webhook / no-daemon path.
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
			placeCard(dir, t.TrackerID, after.State)
			fmt.Printf("%s %s by %s → %s\n", t.ID, verb, decision.Actor, after.State)
			applied++
		}
	}
	if applied == 0 {
		fmt.Println("no pending human decisions found")
	}
	return nil
}
