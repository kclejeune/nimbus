package nix

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Regression test for pushing paths with entries whose names start with "..".
// go-nix's NAR writer choked on Mercurial's bin/..hg-wrapped-wrapped; DumpPath
// defers to nix-store --dump, which must both succeed and produce bytes whose
// hash matches Nix's own NAR hash of the path.
func TestDumpPathDoubleDotEntryName(t *testing.T) {
	for _, bin := range []string{"nix-store", "nix-hash"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skipf("%s not available", bin)
		}
	}

	// nix-store --dump refuses symlinked ancestors (macOS /var -> /private/var).
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"bin/..hg-wrapped-wrapped": "#!/bin/sh\nexec hg \"$@\"\n",
		"bin/.hg-wrapped":          "wrapper\n",
		"bin/hg":                   "outer\n",
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	var buf bytes.Buffer
	if err := DumpPath(context.Background(), &buf, dir); err != nil {
		t.Fatalf("DumpPath: %v", err)
	}

	sum := sha256.Sum256(buf.Bytes())
	got := hex.EncodeToString(sum[:])

	out, err := exec.Command("nix-hash", "--type", "sha256", "--base16", dir).Output()
	if err != nil {
		t.Fatalf("nix-hash: %v", err)
	}
	want := strings.TrimSpace(string(out))
	if got != want {
		t.Errorf("NAR hash mismatch: DumpPath output %s, nix-hash reports %s", got, want)
	}
}
