package securefile

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWriteRepairsModeAndReplacesAtomically(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials")
	if err := os.WriteFile(path, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	old, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close()
	if err := Write(path, []byte("new")); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode: %o", info.Mode().Perm())
	}
	b := make([]byte, 3)
	if _, err := old.Read(b); err != nil {
		t.Fatal(err)
	}
	if string(b) != "old" {
		t.Fatal("modified original inode")
	}
	b, err = os.ReadFile(path)
	if err != nil || string(b) != "new" {
		t.Fatalf("new file: %q %v", b, err)
	}
}

func TestWriteFollowsSymlinkAndKeepsLink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "dotfiles", "netrc")
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.WriteFile(target, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if err := Write(link, []byte("new")); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Lstat(link); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("link replaced: %v %v", info, err)
	}
	b, err := os.ReadFile(target)
	if err != nil || string(b) != "new" {
		t.Fatalf("target: %q %v", b, err)
	}
	if info, err := os.Stat(target); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("target mode not repaired: %v %v", info, err)
	}
}

func TestWriteRejectsImmutableOrNonRegularTarget(t *testing.T) {
	dir := t.TempDir()
	ro := filepath.Join(dir, "store")
	if err := os.MkdirAll(ro, 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(ro, "netrc")
	if err := os.WriteFile(target, []byte("old"), 0o444); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(ro, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(ro, 0o755) })
	link := filepath.Join(dir, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if err := Write(link, []byte("new")); err == nil {
		t.Fatal("wrote into a read-only directory")
	}
	if b, err := os.ReadFile(target); err != nil || string(b) != "old" {
		t.Fatalf("target: %q %v", b, err)
	}
	dirLink := filepath.Join(dir, "dirlink")
	if err := os.Symlink(dir, dirLink); err != nil {
		t.Fatal(err)
	}
	if err := Write(dirLink, []byte("new")); err == nil {
		t.Fatal("accepted a directory")
	}
}
