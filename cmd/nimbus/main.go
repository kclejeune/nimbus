// Package main is the CLI entry point for nimbus.
package main

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/charmbracelet/fang"
	"github.com/spf13/cobra"

	"github.com/kclejeune/nimbus/internal/api"
	"github.com/kclejeune/nimbus/internal/config"
)

var (
	cfgFile string

	// Set via -ldflags at build time by goreleaser.
	version = "dev"
	commit  = "none"
)

func main() {
	root := &cobra.Command{
		Use:   "nimbus",
		Short: "Client for nimbus, a self-hostable Nix binary cache",
		Long: `nimbus pushes store paths to and configures caches on a nimbus server
(attic-compatible protocol on Cloudflare Workers).

Servers come from the config file (nimbus login), overlaid with environment
variables mirroring its shape: NIMBUS_DEFAULT_SERVER,
NIMBUS_SERVERS_<NAME>_ENDPOINT, and NIMBUS_SERVERS_<NAME>_TOKEN. For CI,
the shortcuts NIMBUS_ENDPOINT (server when none is named) and
NIMBUS_AUTH_TOKEN (token override) skip naming a server entirely.`,
		SilenceUsage: true,
	}

	root.PersistentFlags().
		StringVarP(&cfgFile, "config", "c", "", "config file (default: ~/.config/nimbus/config.toml)")

	root.AddCommand(loginCmd())
	root.AddCommand(useCmd())
	root.AddCommand(pushCmd())
	root.AddCommand(cacheCmd())
	root.AddCommand(watchStoreCmd())
	root.AddCommand(watchExecCmd())
	root.AddCommand(gcCmd())

	if err := fang.Execute(
		context.Background(),
		root,
		fang.WithVersion(version),
		fang.WithCommit(commit),
	); err != nil {
		os.Exit(1)
	}
}

func loadConfig() (*config.Config, error) {
	return config.Load(cfgFile)
}

// resolveCache parses [server:]cache against the config and returns an API
// client for its server.
func resolveCache(ref string) (*config.CacheRef, *api.Client, error) {
	cfg, err := loadConfig()
	if err != nil {
		return nil, nil, err
	}
	resolved, err := cfg.ResolveCache(ref)
	if err != nil {
		return nil, nil, err
	}
	return resolved, api.New(resolved.Server.Endpoint, resolved.Server.Token), nil
}

// requireToken guards commands that cannot work anonymously (pushes), so a
// missing token fails up front instead of as an opaque 401 mid-run — e.g. CI
// where the secret resolved to an empty NIMBUS_AUTH_TOKEN.
func requireToken(ref *config.CacheRef) error {
	if strings.TrimSpace(ref.Server.Token) == "" {
		return fmt.Errorf(
			"no auth token for server %q (%s); run `nimbus login` or set %s",
			ref.ServerName, ref.Server.Endpoint, config.TokenEnv,
		)
	}
	return nil
}
