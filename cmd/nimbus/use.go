package main

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/spf13/cobra"

	"github.com/kclejeune/nimbus/internal/api"
	"github.com/kclejeune/nimbus/internal/config"
)

func useCmd() *cobra.Command {
	var remove bool
	cmd := &cobra.Command{
		Use:   "use [SERVER:]CACHE",
		Short: "Configure Nix to pull from a cache",
		Long: `Adds the cache to extra-substituters and its public key to
extra-trusted-public-keys in ~/.config/nix/nix.conf. Private caches also get
the server token written to ~/.config/nix/netrc.

With --remove, undoes that: the cache's substituter and trusted key are
removed from nix.conf (other entries and comments are preserved), and its
netrc entry is dropped once no remaining substituter points at that host.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref, client, err := resolveCache(args[0])
			if err != nil {
				return err
			}
			if remove {
				return runUseRemove(cmd, ref, client)
			}
			info, err := client.GetCacheInfo(cmd.Context(), ref.Cache)
			if err != nil {
				return err
			}

			nixDir, err := nixConfigDir()
			if err != nil {
				return err
			}
			substituter := strings.TrimRight(info.SubstituterEndpoint, "/")

			needNetrc := !info.IsPublic && ref.Server.Token != ""
			netrcPath := filepath.Join(nixDir, "netrc")
			if needNetrc {
				host, err := hostOf(substituter)
				if err != nil {
					return err
				}
				if err := upsertNetrc(netrcPath, host, ref.Server.Token); err != nil {
					return err
				}
			}

			confPath := filepath.Join(nixDir, "nix.conf")
			edits := []confEdit{
				{key: "extra-substituters", value: substituter},
				{key: "extra-trusted-public-keys", value: info.PublicKey},
			}
			if needNetrc {
				edits = append(edits, confEdit{key: "netrc-file", value: netrcPath, replace: true})
			}
			if err := editNixConf(confPath, edits); err != nil {
				return err
			}

			fmt.Printf("✅ Configured Nix to use %q:\n", ref.Cache)
			fmt.Printf("   substituter %s\n", substituter)
			fmt.Printf("   trusted key %s\n", info.PublicKey)
			if needNetrc {
				fmt.Printf("   token in    %s\n", netrcPath)
			}
			return nil
		},
	}
	cmd.Flags().
		BoolVar(&remove, "remove", false, "remove the cache's substituter, trusted key, and netrc entry")
	return cmd
}

// runUseRemove undoes `nimbus use`: it learns the cache's substituter URL and
// public key from the server (falling back to pattern matching against the
// server's host when the call fails) and removes them from nix.conf, plus the
// netrc entry once nothing else pulls from that host.
func runUseRemove(cmd *cobra.Command, ref *config.CacheRef, client *api.Client) error {
	nixDir, err := nixConfigDir()
	if err != nil {
		return err
	}
	confPath := filepath.Join(nixDir, "nix.conf")

	var subMatch func(string) bool
	var keyMatch func(string) bool
	var host string
	if info, err := client.GetCacheInfo(cmd.Context(), ref.Cache); err == nil {
		substituter := strings.TrimRight(info.SubstituterEndpoint, "/")
		if host, err = hostOf(substituter); err != nil {
			return err
		}
		subMatch = func(v string) bool { return strings.TrimRight(v, "/") == substituter }
		keyMatch = func(v string) bool { return v == info.PublicKey }
	} else {
		fmt.Printf("⚠️  Could not fetch cache info (%v); removing entries by pattern.\n", err)
		if host, err = hostOf(ref.Server.Endpoint); err != nil {
			return err
		}
		subMatch = func(v string) bool {
			u, err := url.Parse(v)
			return err == nil && u.Host == host &&
				strings.HasSuffix(strings.TrimRight(u.Path, "/"), "/"+ref.Cache)
		}
		keyMatch = func(v string) bool { return strings.HasPrefix(v, ref.Cache+":") }
	}

	var removals []confEdit
	for _, key := range []string{"substituters", "extra-substituters"} {
		for _, v := range nixConfValues(confPath, key) {
			if subMatch(v) {
				removals = append(removals, confEdit{key: key, value: v})
			}
		}
	}
	var removedSubs []string
	for _, r := range removals {
		removedSubs = append(removedSubs, r.value)
	}
	for _, key := range []string{"trusted-public-keys", "extra-trusted-public-keys"} {
		for _, v := range nixConfValues(confPath, key) {
			if keyMatch(v) {
				removals = append(removals, confEdit{key: key, value: v})
			}
		}
	}
	removed, err := removeFromNixConf(confPath, removals)
	if err != nil {
		return err
	}

	// The netrc entry stays as long as any remaining substituter still points
	// at the same host (another cache on the server may need the token).
	netrcRemoved := false
	if !substituterHostInUse(confPath, host) {
		netrcRemoved, err = removeNetrc(filepath.Join(nixDir, "netrc"), host)
		if err != nil {
			return err
		}
	}

	if len(removed) == 0 && !netrcRemoved {
		fmt.Printf("Nothing to remove for cache %q.\n", ref.Cache)
		return nil
	}
	fmt.Printf("✅ Removed cache %q from Nix config:\n", ref.Cache)
	for _, v := range removed {
		label := "trusted key"
		if slices.Contains(removedSubs, v) {
			label = "substituter"
		}
		fmt.Printf("   %-11s %s\n", label, v)
	}
	if netrcRemoved {
		fmt.Printf("   netrc entry for %s\n", host)
	}
	return nil
}

// substituterHostInUse reports whether any substituter left in nix.conf
// points at host.
func substituterHostInUse(confPath, host string) bool {
	for _, key := range []string{"substituters", "extra-substituters"} {
		for _, v := range nixConfValues(confPath, key) {
			if u, err := url.Parse(v); err == nil && u.Host == host {
				return true
			}
		}
	}
	return false
}

func nixConfigDir() (string, error) {
	base, err := config.XDGConfigHome()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, "nix")
	return dir, os.MkdirAll(dir, 0o755)
}

func hostOf(endpoint string) (string, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return "", err
	}
	return u.Host, nil
}

type confEdit struct {
	key   string
	value string
	// replace swaps the whole value instead of appending to a list.
	replace bool
}

// editNixConf idempotently merges values into nix.conf. Repeated keys
// override each other in Nix, so list values must be merged into one line.
func editNixConf(path string, edits []confEdit) error {
	var lines []string
	if data, err := os.ReadFile(path); err == nil {
		lines = strings.Split(strings.TrimRight(string(data), "\n"), "\n")
		if len(lines) == 1 && lines[0] == "" {
			lines = nil
		}
	} else if !os.IsNotExist(err) {
		return err
	}

	for _, edit := range edits {
		found := false
		for i, line := range lines {
			key, rest, ok := strings.Cut(line, "=")
			if !ok || strings.TrimSpace(key) != edit.key {
				continue
			}
			found = true
			// Split off any trailing inline comment before tokenizing so that
			// comment tokens are never treated as real values.
			valueStr, comment, hasComment := strings.Cut(rest, "#")
			values := strings.Fields(valueStr)
			var newLine string
			if edit.replace {
				newLine = fmt.Sprintf("%s = %s", edit.key, edit.value)
			} else {
				if !slices.Contains(values, edit.value) {
					values = append(values, edit.value)
				}
				newLine = fmt.Sprintf("%s = %s", edit.key, strings.Join(values, " "))
			}
			if hasComment {
				newLine += " #" + comment
			}
			lines[i] = newLine
			break
		}
		if !found {
			lines = append(lines, fmt.Sprintf("%s = %s", edit.key, edit.value))
		}
	}

	return os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644)
}

// nixConfValues returns the list values of key in nix.conf, with inline
// comments excluded.
func nixConfValues(path, key string) []string {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var values []string
	for line := range strings.SplitSeq(strings.TrimRight(string(data), "\n"), "\n") {
		k, rest, ok := strings.Cut(line, "=")
		if !ok || strings.TrimSpace(k) != key {
			continue
		}
		valueStr, _, _ := strings.Cut(rest, "#")
		values = append(values, strings.Fields(valueStr)...)
	}
	return values
}

// removeFromNixConf is the inverse of editNixConf's list merge: it deletes
// the given values from their keys' lists, preserving other entries and
// comments. A line whose list empties out is dropped entirely unless an
// inline comment keeps it. Returns the values actually removed.
func removeFromNixConf(path string, removals []confEdit) ([]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")

	var removed, kept []string
	for _, line := range lines {
		key, rest, ok := strings.Cut(line, "=")
		trimmedKey := strings.TrimSpace(key)
		if !ok {
			kept = append(kept, line)
			continue
		}
		// Split off any trailing inline comment before tokenizing, matching
		// editNixConf, so comment tokens are never removed as values.
		valueStr, comment, hasComment := strings.Cut(rest, "#")
		values := strings.Fields(valueStr)
		changed := false
		for _, removal := range removals {
			if removal.key != trimmedKey {
				continue
			}
			if i := slices.Index(values, removal.value); i >= 0 {
				values = slices.Delete(values, i, i+1)
				removed = append(removed, removal.value)
				changed = true
			}
		}
		if !changed {
			kept = append(kept, line)
			continue
		}
		if len(values) == 0 && !hasComment {
			continue
		}
		newLine := trimmedKey + " ="
		if len(values) > 0 {
			newLine += " " + strings.Join(values, " ")
		}
		if hasComment {
			newLine += " #" + comment
		}
		kept = append(kept, newLine)
	}
	if len(removed) == 0 {
		return nil, nil
	}
	return removed, os.WriteFile(path, []byte(strings.Join(kept, "\n")+"\n"), 0o644)
}

// removeNetrc deletes the machine entry for host; reports whether one
// existed. The file is kept (possibly empty) so a netrc-file line in
// nix.conf never dangles.
func removeNetrc(path, host string) (bool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	var kept []string
	removed := false
	for line := range strings.SplitSeq(strings.TrimRight(string(data), "\n"), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[0] == "machine" && fields[1] == host {
			removed = true
			continue
		}
		if line != "" {
			kept = append(kept, line)
		}
	}
	if !removed {
		return false, nil
	}
	content := ""
	if len(kept) > 0 {
		content = strings.Join(kept, "\n") + "\n"
	}
	return true, os.WriteFile(path, []byte(content), 0o600)
}

// upsertNetrc replaces or appends the machine entry for host.
func upsertNetrc(path, host, token string) error {
	var kept []string
	if data, err := os.ReadFile(path); err == nil {
		for line := range strings.SplitSeq(strings.TrimRight(string(data), "\n"), "\n") {
			fields := strings.Fields(line)
			if len(fields) >= 2 && fields[0] == "machine" && fields[1] == host {
				continue
			}
			if line != "" {
				kept = append(kept, line)
			}
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	kept = append(kept, fmt.Sprintf("machine %s password %s", host, token))
	return os.WriteFile(path, []byte(strings.Join(kept, "\n")+"\n"), 0o600)
}
