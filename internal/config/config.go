// Package config manages the nimbus CLI configuration: named servers with
// endpoints and tokens, and a default server, stored as TOML under the XDG
// config directory (compatible in shape with attic's client config).
package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	toml "github.com/pelletier/go-toml/v2"
)

type Server struct {
	Endpoint string `toml:"endpoint"`
	Token    string `toml:"token,omitempty"`
}

type Config struct {
	DefaultServer string            `toml:"default-server,omitempty"`
	Servers       map[string]Server `toml:"servers,omitempty"`
}

// Path returns the config file location under the XDG config directory.
func Path() (string, error) {
	base, err := XDGConfigHome()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "nimbus", "config.toml"), nil
}

// XDGConfigHome resolves $XDG_CONFIG_HOME with the ~/.config fallback on
// every platform — deliberately not os.UserConfigDir, which points at
// Application Support on macOS where Nix (and nix.conf) never look.
func XDGConfigHome() (string, error) {
	if base := os.Getenv("XDG_CONFIG_HOME"); base != "" {
		return base, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config"), nil
}

func Load(path string) (*Config, error) {
	if path == "" {
		var err error
		if path, err = Path(); err != nil {
			return nil, err
		}
	}
	cfg := &Config{Servers: map[string]Server{}}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return cfg, nil
	}
	if err != nil {
		return nil, err
	}
	if err := toml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}
	if cfg.Servers == nil {
		cfg.Servers = map[string]Server{}
	}
	return cfg, nil
}

func (c *Config) Save(path string) error {
	if path == "" {
		var err error
		if path, err = Path(); err != nil {
			return err
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := toml.Marshal(c)
	if err != nil {
		return err
	}
	// Tokens live in here; keep it private.
	return os.WriteFile(path, data, 0o600)
}

// CacheRef is a resolved "server:cache" or bare "cache" reference.
type CacheRef struct {
	ServerName string
	Server     Server
	Cache      string
}

// ResolveCache parses a cache reference against the configured servers.
func (c *Config) ResolveCache(ref string) (*CacheRef, error) {
	serverName, cache, explicit := strings.Cut(ref, ":")
	if !explicit {
		cache = ref
		serverName = c.DefaultServer
		if serverName == "" {
			if len(c.Servers) == 1 {
				for name := range c.Servers {
					serverName = name
				}
			} else {
				return nil, errors.New(
					"no default server configured; use server:cache or run `nimbus login` first",
				)
			}
		}
	}
	server, ok := c.Servers[serverName]
	if !ok {
		return nil, fmt.Errorf(
			"unknown server %q; run `nimbus login %s <endpoint>` first",
			serverName,
			serverName,
		)
	}
	if cache == "" {
		return nil, fmt.Errorf("missing cache name in %q", ref)
	}
	return &CacheRef{ServerName: serverName, Server: server, Cache: cache}, nil
}
