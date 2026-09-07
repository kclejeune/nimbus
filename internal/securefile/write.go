// Package securefile atomically replaces files containing credentials.
package securefile

import (
	"fmt"
	"os"
	"path/filepath"
)

// Write replaces path with data: a fresh 0600 temporary file in the target's
// directory, synced, then renamed over the target. A pre-existing permissive
// mode is repaired because the inode is replaced, and a reader never sees a
// truncated file. Symlinks are followed (a netrc or config kept in a dotfiles
// repo is the common case) and the link itself is left in place; the final
// target must be a regular file in a writable directory, so a link into an
// immutable tree such as the Nix store fails with a clear error rather than
// silently writing a secret somewhere unexpected.
func Write(path string, data []byte) error {
	target, err := filepath.EvalSymlinks(path)
	switch {
	case err == nil:
		info, err := os.Lstat(target)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("credential destination %s is not a regular file", target)
		}
	case os.IsNotExist(err):
		// A dangling link or a missing file: write the file the link names,
		// or path itself when there is no link.
		if resolved, linkErr := os.Readlink(path); linkErr == nil {
			if !filepath.IsAbs(resolved) {
				resolved = filepath.Join(filepath.Dir(path), resolved)
			}
			target = resolved
		} else {
			target = path
		}
	default:
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(target), ".nimbus-secret-*")
	if err != nil {
		return fmt.Errorf("credential destination %s: %w", target, err)
	}
	defer func() { _ = os.Remove(f.Name()) }()
	if _, err = f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), target)
}
