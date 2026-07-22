// Package quality parses .agentklar/quality.toml and executes allowlisted
// project recipes, producing machine-attested evidence. Agentklar never
// infers that an absent command exists and never translates prose into
// shell commands: only declared recipes run.
package quality

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
)

// Recipe is one declared quality command (spec §10.7/§10.8).
type Recipe struct {
	Name        string   `toml:"name"`
	Level       string   `toml:"level"` // L0..L3
	Command     string   `toml:"command"`
	Args        []string `toml:"args"`
	WorkDir     string   `toml:"workdir"`
	TimeoutSecs int      `toml:"timeout_seconds"`
	Env         []string `toml:"env"`     // allowlisted VAR names passed through
	Network     string   `toml:"network"` // "none" (default) | "allowed" — recorded, not yet sandboxed
	Scopes      []string `toml:"scopes"`  // changed-path prefixes this recipe covers
	Cleanup     string   `toml:"cleanup"` // optional cleanup command
}

type Config struct {
	Recipes []Recipe `toml:"recipe"`
}

// Load reads .agentklar/quality.toml from a repository root.
func Load(repoRoot string) (*Config, error) {
	path := filepath.Join(repoRoot, ".agentklar", "quality.toml")
	var cfg Config
	if _, err := toml.DecodeFile(path, &cfg); err != nil {
		return nil, fmt.Errorf("load %s: %w", path, err)
	}
	for i, r := range cfg.Recipes {
		if r.Name == "" || r.Command == "" {
			return nil, fmt.Errorf("recipe %d: name and command are required", i)
		}
		if r.Level == "" {
			cfg.Recipes[i].Level = "L0"
		}
	}
	return &cfg, nil
}

// Select returns recipes whose scopes match any changed path. Recipes with
// no scopes match everything. Missing coverage is the caller's visible gap.
func (c *Config) Select(changedPaths []string, maxLevel string) []Recipe {
	levelRank := map[string]int{"L0": 0, "L1": 1, "L2": 2, "L3": 3}
	max, ok := levelRank[maxLevel]
	if !ok {
		max = 3
	}
	var out []Recipe
	for _, r := range c.Recipes {
		if levelRank[r.Level] > max {
			continue
		}
		if len(r.Scopes) == 0 {
			out = append(out, r)
			continue
		}
		for _, s := range r.Scopes {
			matched := false
			for _, p := range changedPaths {
				if strings.HasPrefix(p, s) {
					out = append(out, r)
					matched = true
					break
				}
			}
			if matched {
				break
			}
		}
	}
	return out
}

// Attestation is machine-attested evidence of one recipe execution.
// Agentklar itself ran the command; nothing here is agent-reported.
type Attestation struct {
	Recipe     string
	Level      string
	Command    string
	WorkDir    string
	Commit     string
	StartedAt  time.Time
	FinishedAt time.Time
	ExitCode   int
	TimedOut   bool
	LogPath    string
	LogSHA256  string
	// Summary is a compact tail of output for model context; full logs
	// stay on disk at LogPath (spec: logs outside model context).
	Summary string
}

func (a Attestation) Passed() bool { return a.ExitCode == 0 && !a.TimedOut }

// Runner executes recipes inside a task's isolated worktree.
type Runner struct {
	RepoRoot string // worktree the recipe runs against
	LogDir   string // retained-log directory (workspace evidence/)
	Commit   string // head commit being verified
}

// Run executes one recipe with enforced workdir, timeout, and environment
// allowlist, retaining the full log and hashing it for attestation.
func (r *Runner) Run(ctx context.Context, rec Recipe) (*Attestation, error) {
	workdir := r.RepoRoot
	if rec.WorkDir != "" {
		wd := filepath.Clean(filepath.Join(r.RepoRoot, rec.WorkDir))
		if !strings.HasPrefix(wd, filepath.Clean(r.RepoRoot)+string(os.PathSeparator)) && wd != filepath.Clean(r.RepoRoot) {
			return nil, fmt.Errorf("recipe %q: workdir escapes repository root", rec.Name)
		}
		workdir = wd
	}
	timeout := 10 * time.Minute
	if rec.TimeoutSecs > 0 {
		timeout = time.Duration(rec.TimeoutSecs) * time.Second
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	if err := os.MkdirAll(r.LogDir, 0o755); err != nil {
		return nil, err
	}
	logPath := filepath.Join(r.LogDir, fmt.Sprintf("%s-%d.log", sanitize(rec.Name), time.Now().UnixNano()))
	logFile, err := os.Create(logPath)
	if err != nil {
		return nil, err
	}
	defer logFile.Close()

	cmd := exec.CommandContext(cctx, rec.Command, rec.Args...)
	cmd.Dir = workdir
	// Environment allowlist: PATH/HOME plus explicitly declared names only.
	env := []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME")}
	for _, name := range rec.Env {
		if v, ok := os.LookupEnv(name); ok {
			env = append(env, name+"="+v)
		}
	}
	cmd.Env = env
	// Capture a bounded tail for the summary while streaming to the log.
	tail := &tailBuffer{limit: 4096}
	cmd.Stdout = io.MultiWriter(logFile, tail)
	cmd.Stderr = io.MultiWriter(logFile, tail)

	att := &Attestation{
		Recipe: rec.Name, Level: rec.Level,
		Command: rec.Command + " " + strings.Join(rec.Args, " "),
		WorkDir: workdir, Commit: r.Commit, LogPath: logPath,
		StartedAt: time.Now(),
	}
	runErr := cmd.Run()
	att.FinishedAt = time.Now()
	att.TimedOut = cctx.Err() == context.DeadlineExceeded
	if exit, ok := runErr.(*exec.ExitError); ok {
		att.ExitCode = exit.ExitCode()
	} else if runErr != nil {
		att.ExitCode = -1
		fmt.Fprintf(logFile, "\nagentklar: exec error: %v\n", runErr)
	}
	att.Summary = tail.String()

	logFile.Sync()
	if sum, err := fileSHA256(logPath); err == nil {
		att.LogSHA256 = sum
	}

	if rec.Cleanup != "" {
		parts := strings.Fields(rec.Cleanup)
		clean := exec.Command(parts[0], parts[1:]...)
		clean.Dir = workdir
		clean.Env = env
		clean.Run() // cleanup failure is logged by absence, never fatal
	}
	return att, nil
}

type tailBuffer struct {
	buf   []byte
	limit int
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.buf = append(t.buf, p...)
	if len(t.buf) > t.limit {
		t.buf = t.buf[len(t.buf)-t.limit:]
	}
	return len(p), nil
}

func (t *tailBuffer) String() string { return string(t.buf) }

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func sanitize(s string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' {
			return r
		}
		return '_'
	}, s)
}
