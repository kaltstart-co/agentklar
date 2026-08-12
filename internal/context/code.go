package ctx

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// maxCodeFiles bounds how many source files a single IndexCode pass will
// index, keeping walk runtime predictable even on very large repos.
const maxCodeFiles = 20000

// codeBodyLimit is the most bytes of a file used as a doc body.
const codeBodyLimit = 16 * 1024

// codeSniffLimit is the leading byte window examined for binary detection.
const codeSniffLimit = 8000

// codeSizeLimit is the largest file (in bytes) eligible for indexing.
const codeSizeLimit = 256 * 1024

// skipCodeDirs are pruned outright (by exact directory name) during the code
// walk: build outputs, dependency trees, VCS state, and editor caches.
var skipCodeDirs = map[string]bool{
	".git": true, "node_modules": true, "vendor": true, "dist": true,
	"build": true, "out": true, "target": true, ".next": true,
	".cache": true, "__pycache__": true, ".idea": true, ".vscode": true,
	"testdata": true,
}

// errCodeIndexLimit is a walk sentinel that stops WalkDir once maxCodeFiles
// docs have been collected; it is swallowed by IndexCode rather than surfaced.
var errCodeIndexLimit = errors.New("ctx: code index file limit reached")

// IndexCode walks the repo (bounded, text-only) and indexes source files as
// SourceCode docs (Ref = path relative to repoRoot; Title = base name; Body =
// first ~16KB of the file). It skips heavy/irrelevant directories, respects a
// basic ignore set, skips binaries and oversized files, and upserts via the
// existing Index() path (so FTS stays consistent). Returns the number of files
// indexed. It must never panic on a bad file or permission error — log/skip.
func (s *Store) IndexCode(repoRoot string) (int, error) {
	docs, err := CollectCode(repoRoot)
	if err != nil {
		return 0, err
	}
	return s.Index(docs)
}

// CollectCode reads the bounded source corpus without changing the index.
func CollectCode(repoRoot string) ([]Doc, error) {
	var docs []Doc
	walkErr := filepath.WalkDir(repoRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if path == repoRoot {
				return err
			}
			// Permission fault, entry deleted mid-walk, etc.: skip this
			// entry rather than abort the whole index over one bad file.
			return nil
		}
		if d.IsDir() {
			name := d.Name()
			if skipCodeDirs[name] {
				return filepath.SkipDir
			}
			// .agentklar/evidence holds attested run logs, not source —
			// skip that subtree wherever a .agentklar dir occurs.
			if name == "evidence" && filepath.Base(filepath.Dir(path)) == ".agentklar" {
				return filepath.SkipDir
			}
			return nil
		}

		// Only regular files; symlinks are ignored so a link can't pull
		// files from outside the repo into the index.
		if !d.Type().IsRegular() {
			return nil
		}
		// Bound total work before doing any I/O on this file.
		if len(docs) >= maxCodeFiles {
			return errCodeIndexLimit
		}

		info, err := d.Info()
		if err != nil {
			return nil
		}
		if info.Size() > codeSizeLimit {
			return nil
		}

		body, ok := readTextHead(path)
		if !ok || len(body) == 0 {
			return nil
		}

		rel, err := filepath.Rel(repoRoot, path)
		if err != nil {
			return nil
		}

		docs = append(docs, Doc{
			Source: SourceCode,
			Ref:    forwardSlash(rel),
			Title:  d.Name(),
			Body:   body,
		})
		return nil
	})
	if walkErr != nil && !errors.Is(walkErr, errCodeIndexLimit) {
		return nil, fmt.Errorf("walk %s: %w", repoRoot, walkErr)
	}
	return docs, nil
}

// readTextHead reads up to codeBodyLimit bytes of path and returns the text
// body. It reports ok=false when the file is binary (a NUL byte or invalid
// UTF-8 in its leading codeSniffLimit bytes) or unreadable; a bad file is
// reported as not-ok rather than as an error so the walk keeps going.
func readTextHead(path string) (string, bool) {
	f, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer f.Close()

	var buf [codeBodyLimit]byte
	n, err := io.ReadFull(f, buf[:])
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return "", false
	}
	data := buf[:n]

	sniffLen := len(data)
	if sniffLen > codeSniffLimit {
		sniffLen = codeSniffLimit
	}
	sniff := data[:sniffLen]
	if bytes.IndexByte(sniff, 0) >= 0 || !utf8.Valid(sniff) {
		return "", false
	}
	return string(data), true
}

// forwardSlash returns p with OS-specific separators normalized to '/', so
// Refs are stable across Linux/macOS/Windows.
func forwardSlash(p string) string {
	if os.PathSeparator == '/' {
		return p
	}
	return strings.ReplaceAll(p, string(os.PathSeparator), "/")
}
