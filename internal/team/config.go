// Package team stores project roles and makes evidence-based routing suggestions.
// Its access labels never change a native harness's permissions.
package team

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"regexp"
	"strings"

	"github.com/BurntSushi/toml"
)

type Selection struct {
	Harness string `json:"harness" toml:"harness"`
	Model   string `json:"model" toml:"model"`
}

type Role struct {
	ID               string      `json:"id" toml:"id"`
	Responsibility   string      `json:"responsibility" toml:"responsibility"`
	Harness          string      `json:"harness" toml:"harness"`
	Model            string      `json:"model" toml:"model"`
	Skills           []string    `json:"skills" toml:"skills"`
	Access           []string    `json:"access" toml:"access"`
	ExpectedEvidence []string    `json:"expected_evidence" toml:"expected_evidence"`
	AllowedFallback  []Selection `json:"allowed_fallback" toml:"allowed_fallback"`
}

type Pin struct {
	TaskID  string `json:"task_id" toml:"task_id"`
	Harness string `json:"harness" toml:"harness"`
	Model   string `json:"model" toml:"model"`
}

type Config struct {
	Version    int    `json:"version" toml:"version"`
	Preference string `json:"preference" toml:"preference"`
	Roles      []Role `json:"roles" toml:"roles"`
	Pins       []Pin  `json:"pins" toml:"pins"`
}

func Default() Config {
	return Config{Version: 1, Preference: "balanced", Roles: []Role{}, Pins: []Pin{}}
}

var identifier = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`)
var modelID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$`)
var skillPath = regexp.MustCompile(`^[a-zA-Z0-9._/-]+$`)

var ErrConflict = errors.New("team settings changed; reload before saving")

func validSelection(harness, model string, auto bool) bool {
	return identifier.MatchString(harness) && modelID.MatchString(model) && (auto || (harness != "auto" && model != "auto"))
}

func (c Config) Validate() error {
	if c.Version != 1 {
		return errors.New("team version must be 1")
	}
	if c.Preference != "cost" && c.Preference != "balanced" && c.Preference != "quality" {
		return errors.New("preference must be cost, balanced, or quality")
	}
	if len(c.Roles) > 64 || len(c.Pins) > 1000 {
		return errors.New("too many roles or task pins")
	}
	ids := map[string]bool{}
	for _, r := range c.Roles {
		if !identifier.MatchString(r.ID) || ids[r.ID] {
			return fmt.Errorf("invalid or duplicate role id %q", r.ID)
		}
		ids[r.ID] = true
		if strings.TrimSpace(r.Responsibility) == "" || len(r.Responsibility) > 4000 {
			return fmt.Errorf("role %s needs a responsibility of at most 4000 bytes", r.ID)
		}
		if !validSelection(r.Harness, r.Model, true) {
			return fmt.Errorf("role %s has invalid harness or model", r.ID)
		}
		if len(r.Skills) > 64 || len(r.Access) > 64 || len(r.ExpectedEvidence) > 64 || len(r.AllowedFallback) > 64 {
			return fmt.Errorf("role %s has too many references", r.ID)
		}
		for _, ref := range r.Skills {
			if ref == "" || ref == "." || len(ref) > 512 || !skillPath.MatchString(ref) || path.IsAbs(ref) || path.Clean(ref) != ref || strings.ContainsAny(ref, "\\\x00") || ref == ".." || strings.HasPrefix(ref, "../") {
				return fmt.Errorf("role %s skill must be a clean relative path", r.ID)
			}
		}
		for _, label := range append(append([]string{}, r.Access...), r.ExpectedEvidence...) {
			if strings.TrimSpace(label) == "" || len(label) > 1000 || strings.ContainsRune(label, 0) {
				return fmt.Errorf("role %s has an invalid label", r.ID)
			}
		}
		for _, f := range r.AllowedFallback {
			if !validSelection(f.Harness, f.Model, true) || f.Harness == "auto" {
				return fmt.Errorf("role %s fallback needs a named harness", r.ID)
			}
		}
	}
	ids = map[string]bool{}
	for _, p := range c.Pins {
		if !identifier.MatchString(p.TaskID) || ids[p.TaskID] || !validSelection(p.Harness, p.Model, true) || p.Harness == "auto" {
			return errors.New("task pins need unique task ids, a named harness, and a named model or auto")
		}
		ids[p.TaskID] = true
	}
	return nil
}

func safeConfigPath(root *os.Root) error {
	for _, p := range []string{".agentklar", ".agentklar/team.toml", ".agentklar/team.lock"} {
		info, err := root.Lstat(p)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("%s must not be a symlink", p)
		}
	}
	return nil
}

func Load(repo string) (Config, error) {
	c, _, err := LoadRevision(repo)
	return c, err
}

// LoadRevision returns a quoted content hash suitable for an HTTP ETag.
func LoadRevision(repo string) (Config, string, error) {
	root, err := os.OpenRoot(repo)
	if err != nil {
		return Config{}, "", err
	}
	defer root.Close()
	return loadRoot(root)
}

func loadRoot(root *os.Root) (Config, string, error) {
	if err := safeConfigPath(root); err != nil {
		return Config{}, "", err
	}
	f, err := root.Open(".agentklar/team.toml")
	if errors.Is(err, os.ErrNotExist) {
		return Default(), `"absent"`, nil
	}
	if err != nil {
		return Config{}, "", err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, (1<<20)+1))
	if err != nil {
		return Config{}, "", err
	}
	if len(data) > 1<<20 {
		return Config{}, "", errors.New("team file exceeds 1 MiB")
	}
	var c Config
	meta, err := toml.Decode(string(data), &c)
	if err != nil {
		return Config{}, "", err
	}
	if len(meta.Undecoded()) > 0 {
		return Config{}, "", errors.New("unknown team fields; refusing to discard them")
	}
	if err := c.Validate(); err != nil {
		return Config{}, "", err
	}
	c.normalize()
	return c, fmt.Sprintf(`"%x"`, sha256.Sum256(data)), nil
}

func (c *Config) normalize() {
	if c.Roles == nil {
		c.Roles = []Role{}
	}
	if c.Pins == nil {
		c.Pins = []Pin{}
	}
	for i := range c.Roles {
		r := &c.Roles[i]
		if r.Skills == nil {
			r.Skills = []string{}
		}
		if r.Access == nil {
			r.Access = []string{}
		}
		if r.ExpectedEvidence == nil {
			r.ExpectedEvidence = []string{}
		}
		if r.AllowedFallback == nil {
			r.AllowedFallback = []Selection{}
		}
	}
}

// Save replaces only AgentKlar's own file, using a same-directory atomic rename.
func Save(repo string, c Config) error {
	return save(repo, c, "")
}

// SaveRevision prevents stale callers from dropping newer project settings.
func SaveRevision(repo string, c Config, revision string) error {
	if revision == "" {
		return errors.New("team revision is required")
	}
	return save(repo, c, revision)
}

func save(repo string, c Config, revision string) error {
	if err := c.Validate(); err != nil {
		return err
	}
	var buf bytes.Buffer
	if err := toml.NewEncoder(&buf).Encode(c); err != nil {
		return err
	}
	root, err := os.OpenRoot(repo)
	if err != nil {
		return err
	}
	defer root.Close()
	if err := safeConfigPath(root); err != nil {
		return err
	}
	if err := root.Mkdir(".agentklar", 0755); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	lock, err := root.OpenFile(".agentklar/team.lock", os.O_RDWR|os.O_CREATE, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := lockFile(lock); err != nil {
		return err
	}
	defer unlockFile(lock)
	_, current, err := loadRoot(root)
	if err != nil {
		return err
	}
	if revision != "" && revision != current {
		return ErrConflict
	}
	name := ".agentklar/.team-" + rand.Text() + ".tmp"
	f, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer root.Remove(name)
	_, err = f.Write(buf.Bytes())
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	// Cooperating writers hold team.lock. This also detects most edits by an
	// external editor; an editor that ignores the lock can still race the rename.
	_, latest, err := loadRoot(root)
	if err != nil {
		return err
	}
	if latest != current {
		return ErrConflict
	}
	return root.Rename(name, ".agentklar/team.toml")
}
