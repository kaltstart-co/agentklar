package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

//go:embed all:assets
var assets embed.FS

// installTargets describes where Agentklar's skill and slash commands land for
// each supported agent host, and (for opencode/claude) how to register MCP if
// a CLI is present. All paths are global so one install reaches every project.
type installTarget struct {
	name       string
	skillDir   string                 // dir to receive skill/agentklar/SKILL.md
	commandDir string                 // dir to receive command *.md (empty if host has none)
	mcp        func(bin string) error // register MCP, or nil
}

func installTargets() []installTarget {
	home, _ := os.UserHomeDir()
	return []installTarget{
		{
			name:       "opencode",
			skillDir:   filepath.Join(home, ".config", "opencode", "skill"),
			commandDir: filepath.Join(home, ".config", "opencode", "command"),
			mcp:        nil, // opencode MCP is JSON in opencode.json; mcp install prints it.
		},
		{
			name:       "claude",
			skillDir:   filepath.Join(home, ".claude", "skills"),
			commandDir: filepath.Join(home, ".claude", "commands"),
			mcp:        mcpClaude,
		},
		{
			name:       "codex",
			skillDir:   filepath.Join(home, ".codex", "skills"),
			commandDir: "",  // Codex has no slash-command system.
			mcp:        nil, // already a TOML block in config.toml; mcp install prints it.
		},
	}
}

// cmdInstall installs Agentklar's skill + slash commands globally for the
// requested agent hosts, and prints MCP wiring snippets. It copies embedded
// assets — never edits an agent's existing config beyond writing skill/command
// files. MCP registration via a host CLI (claude mcp add) is best-effort.
func cmdInstall(args []string) error {
	fs_ := flag.NewFlagSet("install", flag.ContinueOnError)
	agents := fs_.String("agents", "opencode,claude,codex", "comma-separated: opencode,claude,codex")
	dryRun := fs_.Bool("dry-run", false, "print what would happen without writing")
	if err := fs_.Parse(args); err != nil {
		return err
	}

	bin, err := agentklarBinaryPath()
	if err != nil {
		return err
	}
	want := map[string]bool{}
	for _, a := range strings.Split(*agents, ",") {
		a = strings.TrimSpace(a)
		if a != "" {
			want[strings.ToLower(a)] = true
		}
	}
	targets := installTargets()
	any := false
	for _, t := range targets {
		if !want[t.name] {
			continue
		}
		any = true
		fmt.Printf("== %s ==\n", t.name)
		if err := installHost(t, bin, *dryRun); err != nil {
			fmt.Fprintf(os.Stderr, "  error: %v\n", err)
		}
		fmt.Println()
	}
	if !any {
		return fmt.Errorf("no recognized agents in --agents %q (want: opencode,claude,codex)", *agents)
	}
	fmt.Println("Skill + commands installed. Restart your agent(s) to load them.")
	fmt.Println("MCP wiring: run `agentklar mcp install` for the exact snippets per client.")
	return nil
}

func installHost(t installTarget, bin string, dryRun bool) error {
	// 1. Skill.
	skillWritten, err := copyAssetDir("assets/skill", t.skillDir, dryRun)
	if err != nil {
		return err
	}
	fmt.Printf("  skill:     %d file(s) -> %s\n", skillWritten, t.skillDir)

	// 2. Slash commands.
	if t.commandDir != "" {
		cmdWritten, err := copyAssetDir("assets/commands", t.commandDir, dryRun)
		if err != nil {
			return err
		}
		fmt.Printf("  commands:  %d file(s) -> %s\n", cmdWritten, t.commandDir)
	} else {
		fmt.Printf("  commands:  (none — %s has no slash-command system)\n", t.name)
	}

	// 3. MCP via host CLI if available.
	if t.mcp != nil {
		if lookHostCLI(t.name) {
			if err := t.mcp(bin); err != nil {
				fmt.Fprintf(os.Stderr, "  mcp: %v\n", err)
			}
		} else {
			fmt.Printf("  mcp:       run `agentklar mcp install --client %s` for the snippet\n", t.name)
		}
	} else {
		fmt.Printf("  mcp:       run `agentklar mcp install --client %s` for the snippet\n", t.name)
	}
	return nil
}

// copyAssetDir copies an embedded subtree (e.g. "assets/skill") into dst,
// preserving the relative structure. Returns the number of files written.
func copyAssetDir(srcRoot, dst string, dryRun bool) (int, error) {
	count := 0
	err := fs.WalkDir(assets, srcRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel := strings.TrimPrefix(path, srcRoot+"/")
		target := filepath.Join(dst, rel)
		if dryRun {
			fmt.Printf("  (dry-run) would write %s\n", target)
			count++
			return nil
		}
		data, err := assets.ReadFile(path)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(target, data, 0o644); err != nil {
			return err
		}
		count++
		return nil
	})
	return count, err
}

// agentklarBinaryPath returns the absolute path of the running agentklar, so
// MCP configs point at the real binary on this machine.
func agentklarBinaryPath() (string, error) {
	bin, err := os.Executable()
	if err != nil || bin == "" {
		if p, lerr := exec.LookPath("agentklar"); lerr == nil {
			return p, nil
		}
		return "", fmt.Errorf("could not locate the agentklar binary")
	}
	if resolved, rerr := filepath.EvalSymlinks(bin); rerr == nil {
		return resolved, nil
	}
	return bin, nil
}

func lookHostCLI(name string) bool {
	switch name {
	case "claude":
		_, err := exec.LookPath("claude")
		return err == nil
	}
	return false
}

// mcpClaude registers the agentklar MCP server with Claude Code via its CLI,
// which is the documented, safe way to edit ~/.claude.json.
func mcpClaude(bin string) error {
	scope := "-s"
	scopeVal := "user"
	cmd := exec.Command("claude", "mcp", "add", scope, scopeVal, "agentklar", "--", bin, "mcp")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("claude mcp add: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	fmt.Printf("  mcp:       registered via `claude mcp add` (user scope)\n")
	// If it was already registered, claude prints a notice; treat as success.
	return nil
}
