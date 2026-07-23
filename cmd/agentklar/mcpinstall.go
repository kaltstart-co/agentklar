package main

import (
	"flag"
	"fmt"
	"os"
)

// cmdMCPInstall prints ready-to-paste MCP configuration so a coding agent
// can launch Agentklar's MCP server. It does not edit an agent's config
// files (formats and locations vary and are easy to corrupt) — it gives you
// the exact snippet, with this binary's absolute path already filled in.
func cmdMCPInstall(args []string) error {
	fs := flag.NewFlagSet("mcp install", flag.ContinueOnError)
	client := fs.String("client", "all", "codex | opencode | generic | all")
	if err := fs.Parse(args); err != nil {
		return err
	}

	bin, err := os.Executable()
	if err != nil || bin == "" {
		bin = "agentklar" // fall back to whatever is on PATH
	}

	codex := fmt.Sprintf(`# Codex — add to ~/.codex/config.toml
[mcp_servers.agentklar]
command = "%s"
args = ["mcp"]
`, bin)

	opencode := fmt.Sprintf(`// OpenCode — add to opencode.json ("mcp" section)
{
  "mcp": {
    "agentklar": {
      "type": "local",
      "command": ["%s", "mcp"],
      "enabled": true
    }
  }
}
`, bin)

	generic := fmt.Sprintf(`// Generic MCP client — "mcpServers" section
{
  "mcpServers": {
    "agentklar": {
      "command": "%s",
      "args": ["mcp"]
    }
  }
}
`, bin)

	fmt.Printf("Agentklar MCP server: %s mcp\n\n", bin)
	switch *client {
	case "codex":
		fmt.Println(codex)
	case "opencode":
		fmt.Println(opencode)
	case "generic":
		fmt.Println(generic)
	case "all":
		fmt.Println(codex)
		fmt.Println(opencode)
		fmt.Println(generic)
	default:
		return fmt.Errorf("unknown --client %q (want: codex | opencode | generic | all)", *client)
	}
	fmt.Println("After adding it, your agent can call list_ready_tasks / claim_task / submit_for_review.")
	fmt.Println("There is no approve/done method — completion stays human-only.")
	return nil
}
