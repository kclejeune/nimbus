// Package main is the CLI entry point for nimbus.
package main

import (
	"context"
	"os"

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
(attic-compatible protocol on Cloudflare Workers).`,
		SilenceUsage: true,
	}

	root.PersistentFlags().
		StringVarP(&cfgFile, "config", "c", "", "config file (default: ~/.config/nimbus/config.toml)")

	root.AddCommand(loginCmd())
	root.AddCommand(useCmd())
	root.AddCommand(pushCmd())
	root.AddCommand(cacheCmd())
	root.AddCommand(watchStoreCmd())
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
