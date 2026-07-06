package main

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/spf13/cobra"

	"github.com/kclejeune/nimbus/internal/config"
)

func useCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "use [SERVER:]CACHE",
		Short: "Configure Nix to pull from a cache",
		Long: `Adds the cache to extra-substituters and its public key to
extra-trusted-public-keys in ~/.config/nix/nix.conf. Private caches also get
the server token written to ~/.config/nix/netrc.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref, client, err := resolveCache(args[0])
			if err != nil {
				return err
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
			if edit.replace {
				lines[i] = fmt.Sprintf("%s = %s", edit.key, edit.value)
				break
			}
			values := strings.Fields(rest)
			merged := slices.Contains(values, edit.value)
			if !merged {
				values = append(values, edit.value)
			}
			lines[i] = fmt.Sprintf("%s = %s", edit.key, strings.Join(values, " "))
			break
		}
		if !found {
			lines = append(lines, fmt.Sprintf("%s = %s", edit.key, edit.value))
		}
	}

	return os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644)
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
