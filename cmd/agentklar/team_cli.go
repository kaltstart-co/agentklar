package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/kaltstart-co/agentklar/internal/team"
)

func cmdTeam(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: agentklar team show|save <config.json>|recommend <request.json>")
	}
	repo := repoRoot()
	if args[0] == "show" && len(args) == 1 {
		c, err := team.Load(repo)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(c)
	}
	if len(args) != 2 {
		return errors.New("usage: agentklar team save <config.json>|recommend <request.json>")
	}
	f, err := os.Open(args[1])
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if info.Size() > 1<<20 {
		return errors.New("team input exceeds 1 MiB")
	}
	dec := json.NewDecoder(io.LimitReader(f, (1<<20)+1))
	dec.DisallowUnknownFields()
	var value any
	switch args[0] {
	case "save":
		value = &team.Config{}
	case "recommend":
		value = &team.Request{}
	default:
		return fmt.Errorf("unknown team command %q", args[0])
	}
	if err := dec.Decode(value); err != nil {
		return err
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("input must contain one JSON value")
	}
	if c, ok := value.(*team.Config); ok {
		if err := team.Save(repo, *c); err != nil {
			return err
		}
		fmt.Println("Saved .agentklar/team.toml; native permissions and credentials stay authoritative")
		return nil
	}
	c, err := team.Load(repo)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(team.Recommend(c, *value.(*team.Request)))
}
