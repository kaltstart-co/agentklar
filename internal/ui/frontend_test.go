package ui

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"testing/fstest"
)

func TestSupportFrontendEntry(t *testing.T) {
	s, err := newServer()
	if err != nil {
		t.Fatal(err)
	}
	launch, err := s.LaunchURL("http://127.0.0.1:7681/app/")
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(launch)
	if u.Query().Get("next") != "/app/" {
		t.Fatal("support interface launch lost its destination")
	}
	bootstrap := httptest.NewRecorder()
	s.handleBootstrap(bootstrap, httptest.NewRequest(http.MethodGet, launch, nil))
	if bootstrap.Code != http.StatusSeeOther || bootstrap.Header().Get("Location") != "/app/" {
		t.Fatalf("bootstrap status=%d destination=%s", bootstrap.Code, bootstrap.Header().Get("Location"))
	}
	page := httptest.NewRecorder()
	s.handleFrontend(page, httptest.NewRequest(http.MethodGet, "http://127.0.0.1:7681/app/", nil))
	if page.Code == http.StatusOK {
		if !strings.Contains(page.Body.String(), `<div id="root"></div>`) {
			t.Fatal("built interface has no React mount")
		}
	} else if page.Code != http.StatusServiceUnavailable || !strings.Contains(page.Body.String(), "build:local") {
		t.Fatalf("unbuilt frontend should explain build: status=%d body=%s", page.Code, page.Body.String())
	}
}

func TestDefaultFrontendPath(t *testing.T) {
	marker := fstest.MapFS{"frontend/BUILD_REQUIRED": &fstest.MapFile{Data: []byte("build first")}}
	if got := frontendPath(marker); got != "/" {
		t.Fatalf("Go-only install default=%q, want existing interface", got)
	}
	marker["frontend/index.html"] = &fstest.MapFile{Data: []byte(`<div id="root"></div>`)}
	if got := frontendPath(marker); got != "/app/" {
		t.Fatalf("packaged install default=%q, want support interface", got)
	}
}
