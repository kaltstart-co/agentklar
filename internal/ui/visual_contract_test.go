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
	for _, want := range []string{"#f5f7fb", "#101828", "#315efb", "border-radius: 8px"} {
		if !strings.Contains(body, want) {
			t.Errorf("control-center CSS missing Precision Ops token %q", want)
		}
	}
	for _, forbidden := range []string{"#f5f1e8", "#fffdf8", "Iowan Old Style", "var(--display)"} {
		if strings.Contains(body, forbidden) {
			t.Errorf("control-center CSS retained editorial token %q", forbidden)
		}
	}
}

func TestPrecisionOpsProductSiteVisualContract(t *testing.T) {
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(source), "..", ".."))
	for _, name := range []string{"index.html", "features.html", "usage.html"} {
		path := filepath.Join(root, "docs", "site", name)
		page, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		body := string(page)
		for _, want := range []string{"#f5f7fb", "#101828", "#315efb"} {
			if !strings.Contains(body, want) {
				t.Errorf("%s missing Precision Ops token %q", name, want)
			}
		}
		for _, forbidden := range []string{"#f5f1e8", "#fffdf8", "Iowan Old Style", "Palatino Linotype"} {
			if strings.Contains(body, forbidden) {
				t.Errorf("%s retained editorial token %q", name, forbidden)
			}
		}
	}
}
