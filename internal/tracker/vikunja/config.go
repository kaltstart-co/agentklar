package vikunja

import (
	"os"
	"path/filepath"

	"github.com/BurntSushi/toml"
)

// Config is the per-workspace tracker binding stored at
// {workspace}/tracker.toml. In this dev slice the service token lives in
// the file; the shipped product moves it to the OS keychain.
type Config struct {
	URL          string `toml:"url"`
	ProjectID    int64  `toml:"project_id"`
	ServiceToken string `toml:"service_token"`
	ServiceUser  string `toml:"service_user"`
	ServiceID    int64  `toml:"service_id"`
	HumanUser    string `toml:"human_user"`
}

func configPath(workspaceDir string) string {
	return filepath.Join(workspaceDir, "tracker.toml")
}

// LoadConfig reads the tracker binding, or returns (nil, nil) if unbound.
func LoadConfig(workspaceDir string) (*Config, error) {
	path := configPath(workspaceDir)
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return nil, nil
	}
	var c Config
	if _, err := toml.DecodeFile(path, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

// Save writes the tracker binding with owner-only permissions (it holds a
// token).
func (c *Config) Save(workspaceDir string) error {
	f, err := os.OpenFile(configPath(workspaceDir), os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	return toml.NewEncoder(f).Encode(c)
}

// ClientFromConfig builds a service-account client from stored config.
func (c *Config) Client() *Client { return New(c.URL, c.ServiceToken) }
