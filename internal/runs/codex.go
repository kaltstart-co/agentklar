package runs

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Discover probes local executables only. Finding a binary does not prove account access.
func Discover() []Harness {
	home, _ := os.UserHomeDir()
	claude, _ := filepath.Glob(filepath.Join(home, "Library/Application Support/Claude/claude-code/*/claude.app/Contents/MacOS/claude"))
	muse, _ := filepath.Glob(filepath.Join(home, ".local/bin/muse-bin-*"))
	candidates := map[string][]string{
		"codex":    {"/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex", "codex"},
		"claude":   append([]string{"claude"}, claude...),
		"muse":     append([]string{"muse"}, muse...),
		"opencode": {"opencode"}, "gemini": {"gemini"}, "cursor": {"cursor-agent", "agent"},
	}
	out := []Harness{}
	for _, name := range []string{"codex", "claude", "muse", "opencode", "gemini", "cursor"} {
		for _, candidate := range candidates[name] {
			path, err := exec.LookPath(candidate)
			if err != nil {
				continue
			}
			path, err = filepath.Abs(path)
			if err != nil {
				continue
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			b, err := exec.CommandContext(ctx, path, "--version").CombinedOutput()
			cancel()
			if err != nil || len(b) > 4096 {
				continue
			}
			if name == "cursor" && !strings.Contains(strings.ToLower(string(b)), "cursor") {
				continue
			}
			caps := []string{"version-probed"}
			if name == "codex" {
				caps = append(caps, "app-server-adapter")
			}
			out = append(out, Harness{Name: name, Executable: path, Args: []string{}, Version: strings.TrimSpace(string(b)), Capabilities: caps, CheckedAt: now()})
			break
		}
	}
	if node, err := exec.LookPath("node"); err == nil {
		path := "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"
		if _, err := os.Stat(path); err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			b, err := exec.CommandContext(ctx, node, path, "--version").CombinedOutput()
			cancel()
			if err == nil && len(b) < 4096 {
				out = append(out, Harness{Name: "zcode", Executable: node, Args: []string{path}, Version: strings.TrimSpace(string(b)), Capabilities: []string{"version-probed"}, CheckedAt: now()})
			}
		}
	}
	return out
}

type message struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

type codex struct {
	cmd        *exec.Cmd
	in         io.WriteCloser
	enc        *json.Encoder
	mu         sync.Mutex
	next       int
	pending    map[string]chan message
	events     chan message
	done       chan struct{}
	wait       chan error
	stop       chan struct{}
	once       sync.Once
	diagnostic *diagnostic
}

type diagnostic struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (d *diagnostic) Write(p []byte) (int, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.buf.Len() < 8192 {
		remaining := 8192 - d.buf.Len()
		if len(p) > remaining {
			d.buf.Write(p[:remaining])
		} else {
			d.buf.Write(p)
		}
	}
	return len(p), nil
}
func (d *diagnostic) summary() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	s := d.buf.String()
	lines := strings.Split(s, "\n")
	safe := []string{}
	sensitive := regexp.MustCompile(`(?i)token|secret|password|authorization|credential|api.?key|cookie|bearer`)
	for _, line := range lines {
		if sensitive.MatchString(line) {
			safe = append(safe, "[credential-related diagnostic omitted]")
		} else if strings.Contains(strings.ToLower(line), "error") || strings.Contains(strings.ToLower(line), "failed") {
			if len(line) > 400 {
				line = line[:400]
			}
			safe = append(safe, line)
		}
	}
	if len(safe) > 3 {
		safe = safe[len(safe)-3:]
	}
	return strings.Join(safe, "; ")
}

func openCodex(h Harness, repo string) (*codex, error) {
	cmd := exec.Command(h.Executable, append(h.Args, "app-server", "--listen", "stdio://")...)
	d := &diagnostic{}
	cmd.Dir = repo
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Stderr = d
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		in.Close()
		return nil, err
	}
	if err = cmd.Start(); err != nil {
		in.Close()
		return nil, err
	}
	c := &codex{cmd: cmd, in: in, enc: json.NewEncoder(in), pending: map[string]chan message{}, events: make(chan message, 256), done: make(chan struct{}), stop: make(chan struct{}), wait: make(chan error, 1), diagnostic: d}
	go func() {
		defer close(c.done)
		defer close(c.events)
		sc := bufio.NewScanner(out)
		sc.Buffer(make([]byte, 65536), 8*1024*1024)
		for sc.Scan() {
			var m message
			if err := json.Unmarshal(sc.Bytes(), &m); err != nil {
				_, _ = d.Write([]byte("error: invalid native JSON event"))
				break
			}
			if len(m.ID) > 0 && m.Method == "" {
				c.mu.Lock()
				ch := c.pending[string(m.ID)]
				c.mu.Unlock()
				if ch != nil {
					ch <- m
				}
				continue
			}
			select {
			case c.events <- m:
			case <-c.stop:
				_ = cmd.Wait()
				return
			}
		}
		if err := sc.Err(); err != nil {
			_, _ = d.Write([]byte("error: native stream read failed: " + err.Error()))
		}
		// Wait only after stdout has been fully drained; otherwise the final event can be lost.
		c.wait <- cmd.Wait()
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if _, err = c.call(ctx, "initialize", map[string]any{"clientInfo": map[string]string{"name": "agentklar", "title": "AgentKlar", "version": "0.1.0"}}); err != nil {
		c.close()
		return nil, fmt.Errorf("initialize native app-server: %w", err)
	}
	if err = c.send(map[string]any{"method": "initialized", "params": map[string]any{}}); err != nil {
		c.close()
		return nil, err
	}
	return c, nil
}

func (c *codex) send(v any) error { c.mu.Lock(); defer c.mu.Unlock(); return c.enc.Encode(v) }
func (c *codex) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	c.mu.Lock()
	c.next++
	id := c.next
	key := fmt.Sprint(id)
	ch := make(chan message, 1)
	c.pending[key] = ch
	err := c.enc.Encode(map[string]any{"id": id, "method": method, "params": params})
	c.mu.Unlock()
	defer func() { c.mu.Lock(); delete(c.pending, key); c.mu.Unlock() }()
	if err != nil {
		return nil, err
	}
	m, err := awaitReply(ctx, ch, c.done)
	if err != nil {
		return nil, err
	}
	if m.Error != nil {
		return nil, fmt.Errorf("native %s: %s", method, m.Error.Message)
	}
	return m.Result, nil
}

func awaitReply(ctx context.Context, ch <-chan message, done <-chan struct{}) (message, error) {
	select {
	case m := <-ch:
		return m, nil
	case <-ctx.Done():
		return message{}, ctx.Err()
	case <-done:
		// A final reply may already be buffered when EOF becomes ready.
		select {
		case m := <-ch:
			return m, nil
		default:
			return message{}, errors.New("native app-server disconnected")
		}
	}
}

func (c *codex) close() {
	c.once.Do(func() {
		close(c.stop)
		c.in.Close()
		if c.cmd.Process != nil {
			_ = syscall.Kill(-c.cmd.Process.Pid, syscall.SIGKILL)
		}
	})
	select {
	case <-c.done:
	case <-time.After(5 * time.Second):
	}
}

// Catalog is a native model catalog, not an entitlement or a billing choice.
func Catalog(h Harness, repo string) (json.RawMessage, error) {
	c, err := openCodex(h, repo)
	if err != nil {
		return nil, err
	}
	defer c.close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return c.call(ctx, "model/list", map[string]any{})
}
