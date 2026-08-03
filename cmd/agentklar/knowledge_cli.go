package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	akctx "github.com/kaltstart-co/agentklar/internal/context"
	"github.com/kaltstart-co/agentklar/internal/knowledge"
	"github.com/kaltstart-co/agentklar/internal/memory"
	"github.com/kaltstart-co/agentklar/internal/notify"
)

// cmdKnowledge manages the in-repo .agentklar/knowledge/ layer (decisions,
// conventions, glossary, runbook). All output is plain markdown in the repo —
// fully discoverable via git and `agentklar open knowledge`.
func cmdKnowledge(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: agentklar knowledge list|decide|add|show")
	}
	store, err := knowledge.New(repoRoot())
	if err != nil {
		return err
	}
	switch args[0] {
	case "list":
		entries, err := store.List()
		if err != nil {
			return err
		}
		fmt.Printf("%d knowledge entries in %s\n", len(entries), store.Dir())
		for _, e := range entries {
			fmt.Printf("  %-11s %s\n", e.Kind, e.Title)
		}
		return nil

	case "decide":
		fs := flag.NewFlagSet("knowledge decide", flag.ContinueOnError)
		context_ := fs.String("context", "", "what makes this a real decision")
		decision := fs.String("decision", "", "the chosen option, and why")
		if err := fs.Parse(reorderFlags(args[1:], nil)); err != nil {
			return err
		}
		title := strings.Join(fs.Args(), " ")
		if title == "" || *decision == "" {
			return fmt.Errorf("usage: agentklar knowledge decide <title> --context \"...\" --decision \"...\"")
		}
		slug, err := store.AddDecision(title, *context_, *decision)
		if err != nil {
			return err
		}
		fmt.Printf("decision recorded: decisions/%s.md\n", slug)
		fmt.Println("commit it so every agent (and reviewer) sees the same context.")
		return nil

	case "add":
		fs := flag.NewFlagSet("knowledge add", flag.ContinueOnError)
		body := fs.String("body", "", "content of the section")
		if err := fs.Parse(reorderFlags(args[1:], nil)); err != nil {
			return err
		}
		rest := fs.Args()
		if len(rest) < 2 || *body == "" {
			return fmt.Errorf("usage: agentklar knowledge add <convention|glossary|runbook> <title> --body \"...\"")
		}
		kind := knowledge.Kind(rest[0])
		title := strings.Join(rest[1:], " ")
		slug, err := store.Add(kind, title, *body)
		if err != nil {
			return err
		}
		fmt.Printf("%s added: %s\n", kind, slug)
		return nil

	case "show":
		if len(args) < 3 {
			return fmt.Errorf("usage: agentklar knowledge show <decision|convention|glossary|runbook> <slug>")
		}
		e, err := store.Read(knowledge.Kind(args[1]), args[2])
		if err != nil {
			return err
		}
		fmt.Printf("# %s — %s\n(%s)\n\n%s\n", e.Kind, e.Title, e.Path, e.Body)
		return nil
	}
	return fmt.Errorf("unknown knowledge subcommand %q", args[0])
}

// cmdMemory drives the shared memory store. Writes are agent- or human-writable;
// forget is human-only and prints that boundary.
func cmdMemory(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: agentklar memory list|search|remember|forget")
	}
	eng, dir, err := openEngine()
	if err != nil {
		return err
	}
	_ = eng
	store, err := memory.New(dir)
	if err != nil {
		return err
	}
	switch args[0] {
	case "list":
		fs := flag.NewFlagSet("memory list", flag.ContinueOnError)
		ns := fs.String("namespace", "", "filter by namespace")
		if err := fs.Parse(reorderFlags(args[1:], nil)); err != nil {
			return err
		}
		entries, err := store.List(*ns)
		if err != nil {
			return err
		}
		fmt.Printf("%d memory rows\n", len(entries))
		for _, e := range entries {
			fmt.Printf("  #%d  [%s/%s]  %s  (by %s, task %s)\n", e.ID, e.Namespace, e.Key, truncate(e.Value, 60), e.Holder, e.SourceTask)
		}
		return nil

	case "search", "recall":
		if len(args) < 2 {
			return fmt.Errorf("usage: agentklar memory search <query>")
		}
		entries, err := store.Recall(strings.Join(args[1:], " "), 0)
		if err != nil {
			return err
		}
		fmt.Printf("%d match(es)\n", len(entries))
		for _, e := range entries {
			fmt.Printf("  #%d  [%s/%s]  %s\n", e.ID, e.Namespace, e.Key, truncate(e.Value, 80))
		}
		return nil

	case "remember":
		fs := flag.NewFlagSet("memory remember", flag.ContinueOnError)
		ns := fs.String("namespace", "", "scope (usually a task id)")
		value := fs.String("value", "", "the fact to remember")
		task := fs.String("task", "", "task id this memory came from")
		holder := fs.String("holder", os.Getenv("USER"), "who is writing this")
		if err := fs.Parse(reorderFlags(args[1:], nil)); err != nil {
			return err
		}
		key := strings.Join(fs.Args(), " ")
		if key == "" || *value == "" {
			return fmt.Errorf("usage: agentklar memory remember <key> --value \"...\" [--namespace ns] [--task id]")
		}
		id, err := store.Remember(*ns, key, *value, *task, *holder)
		if err != nil {
			return err
		}
		fmt.Printf("remembered as #%d\n", id)
		return nil

	case "forget":
		if len(args) < 2 {
			return fmt.Errorf("usage: agentklar memory forget <id>  (human-only)")
		}
		id, err := strconv.ParseInt(args[1], 10, 64)
		if err != nil {
			return fmt.Errorf("id must be a number")
		}
		if err := store.Forget(id); err != nil {
			return err
		}
		fmt.Printf("forgot #%d\n", id)
		fmt.Fprintln(os.Stderr, "note: memory deletion is human-only; no agent method can call this.")
		return nil
	}
	return fmt.Errorf("unknown memory subcommand %q", args[0])
}

// cmdContext drives the FTS5 context index. `index` pulls knowledge + memory
// into the index so `search` returns focused, cross-layer results.
func cmdContext(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: agentklar context search|index")
	}
	eng, dir, err := openEngine()
	if err != nil {
		return err
	}
	store, err := akctx.New(dir)
	if err != nil {
		return err
	}
	switch args[0] {
	case "search":
		if len(args) < 2 {
			return fmt.Errorf("usage: agentklar context search <query>")
		}
		packet, err := store.Packet(strings.Join(args[1:], " "), 25)
		if err != nil {
			return err
		}
		fmt.Printf("context packet for %q — %d items\n", packet.Query, len(packet.Items))
		for _, d := range packet.Items {
			fmt.Printf("  [%s] %s — %s\n", d.Source, d.Title, truncate(d.Body, 70))
		}
		return nil

	case "index":
		// Gather knowledge (in-repo) and memory (workspace sqlite) into the index,
		// then walk the repo's code. The context store is the union of all three
		// layers — what an agent gets back as a focused work packet on claim.
		var docs []akctx.Doc
		if ks, err := knowledge.New(repoRoot()); err == nil {
			entries, _ := ks.List()
			for _, e := range entries {
				docs = append(docs, akctx.Doc{Source: akctx.SourceKnowledge, Ref: string(e.Kind) + "/" + e.Slug, Title: e.Title, Body: e.Body})
			}
		}
		if ms, err := memory.New(dir); err == nil {
			rows, _ := ms.List("")
			for _, m := range rows {
				ref := fmt.Sprintf("memory/%d", m.ID)
				title := m.Namespace + "/" + m.Key
				docs = append(docs, akctx.Doc{Source: akctx.SourceMemory, Ref: ref, Title: title, Body: m.Value})
			}
		}
		n, err := store.Index(docs)
		if err != nil {
			return err
		}
		codeN, err := store.IndexCode(repoRoot())
		if err != nil {
			fmt.Fprintf(os.Stderr, "warning: code index partial: %v\n", err)
		}
		fmt.Printf("indexed %d knowledge/memory docs + %d code files\n", n, codeN)
		_ = eng
		return nil
	}
	return fmt.Errorf("unknown context subcommand %q", args[0])
}

// cmdAlerts drives the human-alert log. Agents record alerts (over MCP
// notify_human or here); only the human can acknowledge them — an agent can
// never silence alerts it raised.
func cmdAlerts(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: agentklar alerts list|pending|ack")
	}
	_, dir, err := openEngine()
	if err != nil {
		return err
	}
	store, err := notify.New(dir)
	if err != nil {
		return err
	}
	switch args[0] {
	case "list":
		entries, err := store.List("")
		if err != nil {
			return err
		}
		fmt.Printf("%d alerts\n", len(entries))
		for _, a := range entries {
			ack := " "
			if a.Acknowledged {
				ack = "x"
			}
			fmt.Printf("  [%s] #%d %-6s %s  (task %s, by %s)\n", ack, a.ID, a.Severity, truncate(a.Message, 60), a.TaskID, a.Holder)
		}
		return nil
	case "pending":
		entries, err := store.Pending()
		if err != nil {
			return err
		}
		fmt.Printf("%d pending alert(s)\n", len(entries))
		for _, a := range entries {
			fmt.Printf("  #%d %-6s %s\n", a.ID, a.Severity, truncate(a.Message, 70))
		}
		return nil
	case "ack":
		if len(args) < 2 {
			return fmt.Errorf("usage: agentklar alerts ack <id>  (human-only)")
		}
		id, err := strconv.ParseInt(args[1], 10, 64)
		if err != nil {
			return fmt.Errorf("id must be a number")
		}
		if err := store.Ack(id); err != nil {
			return err
		}
		fmt.Printf("acknowledged #%d\n", id)
		fmt.Fprintln(os.Stderr, "note: acknowledging alerts is human-only; no agent method can call this.")
		return nil
	}
	return fmt.Errorf("unknown alerts subcommand %q", args[0])
}

func truncate(s string, n int) string {
	s = strings.ReplaceAll(strings.ReplaceAll(s, "\n", " "), "\t", " ")
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}

var _ = filepath.Join // reserved for future code-indexing paths
