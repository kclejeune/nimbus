// Package config manages the nimbus CLI configuration: named servers with
// endpoints and tokens, and a default server, stored as TOML under the XDG
// config directory (compatible in shape with attic's client config).
package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	toml "github.com/pelletier/go-toml/v2"
)

// Environment overrides, for CI and one-off use without a config file:
// EndpointEnv defines the server whenever the cache reference does not name
// one explicitly, and TokenEnv overrides whichever token resolution found.
const (
	EndpointEnv = "NIMBUS_ENDPOINT"
	TokenEnv    = "NIMBUS_AUTH_TOKEN"
)

type Server struct {
	Endpoint string `toml:"endpoint"`
	Token    string `toml:"token,omitempty"`
}

// NormalizeEndpoint accepts a full http(s) URL or a bare host[:port] (which
// gets https://) and strips trailing slashes.
func NormalizeEndpoint(endpoint string) (string, error) {
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		return "", errors.New("empty endpoint")
	}
	if !strings.Contains(endpoint, "://") {
		endpoint = "https://" + endpoint
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Hostname() == "" {
		return "", fmt.Errorf("invalid endpoint %q", endpoint)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("endpoint %q must be http(s)", endpoint)
	}
	return strings.TrimRight(endpoint, "/"), nil
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

// ResolveServer returns the named server, falling back to NIMBUS_ENDPOINT,
// then the default (or only) configured server when name is empty. A set
// NIMBUS_AUTH_TOKEN overrides the resolved token either way.
func (c *Config) ResolveServer(name string) (string, Server, error) {
	var server Server
	if name == "" && os.Getenv(EndpointEnv) != "" {
		name = "env"
		server = Server{Endpoint: os.Getenv(EndpointEnv)}
	} else {
		if name == "" {
			name = c.DefaultServer
			if name == "" {
				if len(c.Servers) == 1 {
					for only := range c.Servers {
						name = only
					}
				} else {
					return "", Server{}, errors.New(
						"no default server configured; name one explicitly, run `nimbus login`, or set " + EndpointEnv,
					)
				}
			}
		}
		var ok bool
		if server, ok = c.Servers[name]; !ok {
			return "", Server{}, fmt.Errorf(
				"unknown server %q; run `nimbus login %s <endpoint>` first",
				name,
				name,
			)
		}
	}

	endpoint, err := NormalizeEndpoint(server.Endpoint)
	if err != nil {
		return "", Server{}, fmt.Errorf("server %q: %w", name, err)
	}
	server.Endpoint = endpoint
	if token := os.Getenv(TokenEnv); token != "" {
		server.Token = token
	}
	return name, server, nil
}

// ResolveCache parses a cache reference against the configured servers.
func (c *Config) ResolveCache(ref string) (*CacheRef, error) {
	serverName, cache, explicit := strings.Cut(ref, ":")
	if !explicit {
		cache = ref
		serverName = ""
	}
	resolvedName, server, err := c.ResolveServer(serverName)
	if err != nil {
		return nil, err
	}
	if cache == "" {
		return nil, fmt.Errorf("missing cache name in %q", ref)
	}
	return &CacheRef{ServerName: resolvedName, Server: server, Cache: cache}, nil
}
