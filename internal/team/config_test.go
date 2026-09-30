package team

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
)

func fixtureConfig() Config {
	c := Default()
	c.Roles = []Role{{ID: "builder", Responsibility: "Implement and run declared checks", Harness: "codex", Model: "auto", Skills: []string{".agents/skills/build/SKILL.md"}, Access: []string{"read", "write only when the native tool permits"}, ExpectedEvidence: []string{"declared checks"}, AllowedFallback: []Selection{{"claude", "auto"}}}}
	c.Pins = []Pin{{TaskID: "task-1", Harness: "codex", Model: "sol"}}
	return c
}

func TestConfigRoundtripAndNativeFilePreserved(t *testing.T) {
	repo := t.TempDir()
	native := filepath.Join(repo, "native.toml")
	if err := os.WriteFile(native, []byte("unrelated = 'preserve me'\n"), 0600); err != nil {
		t.Fatal(err)
	}
	initial, revision, err := LoadRevision(repo)
	if err != nil || initial.Preference != "balanced" || revision != `"absent"` {
		t.Fatalf("default: %+v %s %v", initial, revision, err)
	}
	c := fixtureConfig()
	if err := SaveRevision(repo, c, revision); err != nil {
		t.Fatal(err)
	}
	got, next, err := LoadRevision(repo)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, c) || next == revision {
		t.Fatalf("roundtrip: %+v %s", got, next)
	}
	bytes, err := os.ReadFile(native)
	if err != nil || string(bytes) != "unrelated = 'preserve me'\n" {
		t.Fatal("native config changed")
	}
	info, err := os.Stat(filepath.Join(repo, ".agentklar/team.toml"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("team permissions", info, err)
	}
	files, _ := os.ReadDir(filepath.Join(repo, ".agentklar"))
	for _, f := range files {
		if f.Name() != "team.toml" && f.Name() != "team.lock" {
			t.Fatal("temporary files leaked", files)
		}
	}
}

func TestRejectConfig(t *testing.T) {
	for _, tc := range []struct {
		name string
		edit func(*Config)
	}{
		{"version", func(c *Config) { c.Version = 2 }},
		{"preference", func(c *Config) { c.Preference = "magic" }},
		{"duplicate role", func(c *Config) { c.Roles = append(c.Roles, c.Roles[0]) }},
		{"role id traversal", func(c *Config) { c.Roles[0].ID = "../builder" }},
		{"skill traversal", func(c *Config) { c.Roles[0].Skills = []string{"../secret"} }},
		{"absolute skill", func(c *Config) { c.Roles[0].Skills = []string{"/tmp/skill"} }},
		{"windows skill", func(c *Config) { c.Roles[0].Skills = []string{"C:/secret"} }},
		{"shell field", func(c *Config) { c.Roles[0].Harness = "$(run)" }},
		{"blank responsibility", func(c *Config) { c.Roles[0].Responsibility = " " }},
		{"duplicate pin", func(c *Config) { c.Pins = append(c.Pins, c.Pins[0]) }},
		{"automatic harness pin", func(c *Config) { c.Pins[0].Harness = "auto" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := fixtureConfig()
			tc.edit(&c)
			if err := Save(t.TempDir(), c); err == nil {
				t.Fatal("accepted invalid config")
			}
		})
	}
}

func TestUnknownFieldsAndSymlinksAreNotOverwritten(t *testing.T) {
	for _, symlink := range []bool{false, true} {
		t.Run(map[bool]string{false: "unknown field", true: "symlink"}[symlink], func(t *testing.T) {
			repo := t.TempDir()
			dir := filepath.Join(repo, ".agentklar")
			if err := os.Mkdir(dir, 0755); err != nil {
				t.Fatal(err)
			}
			file := filepath.Join(dir, "team.toml")
			original := []byte("version = 1\npreference = 'balanced'\nfuture_option = true\n")
			if symlink {
				target := filepath.Join(t.TempDir(), "team.toml")
				if err := os.WriteFile(target, original, 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, file); err != nil {
					t.Fatal(err)
				}
			} else if err := os.WriteFile(file, original, 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := Load(repo); err == nil {
				t.Fatal("unsafe read accepted")
			}
			if err := Save(repo, Default()); err == nil {
				t.Fatal("unsafe overwrite accepted")
			}
			got, _ := os.ReadFile(file)
			if string(got) != string(original) {
				t.Fatal("preexisting bytes changed")
			}
		})
	}
}

func TestRevisionAllowsOneConcurrentSave(t *testing.T) {
	repo := t.TempDir()
	_, revision, err := LoadRevision(repo)
	if err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, pref := range []string{"cost", "quality"} {
		wg.Add(1)
		go func(pref string) {
			defer wg.Done()
			c := Default()
			c.Preference = pref
			results <- SaveRevision(repo, c, revision)
		}(pref)
	}
	wg.Wait()
	close(results)
	success, conflict := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, ErrConflict) {
			conflict++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("success=%d conflict=%d", success, conflict)
	}
}

func TestRevisionSerializesSeparateProcesses(t *testing.T) {
	repo := t.TempDir()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	commands := []*exec.Cmd{}
	for _, preference := range []string{"cost", "quality"} {
		cmd := exec.Command(executable, "-test.run=^TestTeamWriterProcess$")
		cmd.Env = append(os.Environ(), "AGENTKLAR_TEST_TEAM_REPO="+repo, "AGENTKLAR_TEST_TEAM_PREFERENCE="+preference)
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		commands = append(commands, cmd)
	}
	success, conflict := 0, 0
	for _, cmd := range commands {
		err := cmd.Wait()
		if err == nil {
			success++
		} else if exit, ok := err.(*exec.ExitError); ok && exit.ExitCode() == 3 {
			conflict++
		} else {
			t.Fatalf("writer process: %v", err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("process success=%d conflict=%d", success, conflict)
	}
}

func TestTeamWriterProcess(t *testing.T) {
	repo := os.Getenv("AGENTKLAR_TEST_TEAM_REPO")
	if repo == "" {
		t.Skip("subprocess helper")
	}
	c := Default()
	c.Preference = os.Getenv("AGENTKLAR_TEST_TEAM_PREFERENCE")
	err := SaveRevision(repo, c, `"absent"`)
	if errors.Is(err, ErrConflict) {
		os.Exit(3)
	}
	if err != nil {
		os.Exit(2)
	}
	os.Exit(0)
}
