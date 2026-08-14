package ui

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestPrecisionOpsControlCenterVisualContract(t *testing.T) {
	css, err := assetsFS.ReadFile("assets/static/app.css")
	if err != nil {
		t.Fatal(err)
	}
	body := string(css)
	for _, want := range []string{"#f5f7fb", "#101828", "#315efb", "--rail: 216px", "border-radius: 8px", "font: 650 12px var(--sans)"} {
		if !strings.Contains(body, want) {
			t.Errorf("control-center CSS missing Precision Ops token %q", want)
		}
	}
	for _, forbidden := range []string{"#f5f1e8", "#fffdf8", "Iowan Old Style", "var(--display)", ".editorial-head", "clamp(44px", ".eyebrow { margin: 0 0 7px"} {
		if strings.Contains(body, forbidden) {
			t.Errorf("control-center CSS retained editorial token %q", forbidden)
		}
	}

	board, err := assetsFS.ReadFile("assets/board.html")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`class="board-summary"`, `class="board-filters"`, "Active tasks", "Needs review", "Human approval"} {
		if !strings.Contains(string(board), want) {
			t.Errorf("board template missing compact SaaS structure %q", want)
		}
	}
	for _, name := range []string{"overview.html", "approvals.html"} {
		page, err := assetsFS.ReadFile("assets/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(page), "editorial-head") {
			t.Errorf("%s retained editorial page hierarchy", name)
		}
	}
}

func TestPrecisionOpsProductSiteVisualContract(t *testing.T) {
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(source), "..", ".."))
	shared, err := os.ReadFile(filepath.Join(root, "docs", "site", "site.css"))
	if err != nil {
		t.Fatal(err)
	}
	css := string(shared)
	for _, want := range []string{"#f5f7fb", "#101828", "#315efb", "--hero-size: clamp(2.75rem, 5vw, 4.5rem)"} {
		if !strings.Contains(css, want) {
			t.Errorf("shared site CSS missing Precision Ops token %q", want)
		}
	}
	for _, name := range []string{"index.html", "features.html", "usage.html"} {
		path := filepath.Join(root, "docs", "site", name)
		page, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		body := string(page)
		if !strings.Contains(body, `<link rel="stylesheet" href="site.css">`) {
			t.Errorf("%s does not use the shared SaaS stylesheet", name)
		}
		for _, forbidden := range []string{"#f5f1e8", "#fffdf8", "Iowan Old Style", "Palatino Linotype", "7.8rem", "7.4rem", "7rem", "letter-spacing:.13em", "letter-spacing: .13em"} {
			if strings.Contains(body, forbidden) {
				t.Errorf("%s retained editorial token %q", name, forbidden)
			}
		}
	}
}
