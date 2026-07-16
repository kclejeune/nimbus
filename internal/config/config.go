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

	"github.com/nil-go/konf"
	"github.com/nil-go/konf/provider/env"
	toml "github.com/pelletier/go-toml/v2"
)

// Environment configuration. Any config field can be set or overridden with
// NIMBUS_-prefixed variables mirroring the file's shape:
//
//	NIMBUS_DEFAULT_SERVER              default-server
//	NIMBUS_SERVERS_<NAME>_ENDPOINT     servers.<name>.endpoint
//	NIMBUS_SERVERS_<NAME>_TOKEN        servers.<name>.token
//	NIMBUS_SERVERS_<NAME>_TOKEN_FILE   servers.<name>.token_file
//
// Shortcuts cover the common CI case without naming a server: EndpointEnv
// defines the server whenever the cache reference does not name one
// explicitly, and TokenEnv (or TokenFileEnv, pointing at a file holding the
// token) overrides whichever token resolution found.
const (
	EndpointEnv  = "NIMBUS_ENDPOINT"
	TokenEnv     = "NIMBUS_AUTH_TOKEN"
	TokenFileEnv = "NIMBUS_AUTH_TOKEN_FILE"
	envPrefix    = "NIMBUS_"
)

type Server struct {
	Endpoint string `toml:"endpoint"        konf:"endpoint"`
	Token    string `toml:"token,omitempty" konf:"token"`
	// TokenFile holds the token out of the config file (e.g. an agenix/sops
	// secret path). Mutually exclusive with Token.
	TokenFile string `toml:"token_file,omitempty" konf:"token_file"`
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
	DefaultServer string            `toml:"default-server,omitempty" konf:"default-server"`
	Servers       map[string]Server `toml:"servers,omitempty"        konf:"servers"`
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

// LoadFile reads the config file alone — the layer Save writes back. Flows
// that mutate and persist config (login) use this so environment overlays
// never end up baked into the file.
func LoadFile(path string) (*Config, error) {
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

// mapLoader adapts an already-parsed config map to konf's Loader interface.
type mapLoader map[string]any

func (m mapLoader) Load() (map[string]any, error) { return m, nil }

// splitEnvName maps a NIMBUS_ variable name onto the config's key shape;
// names that mirror no config field (including the EndpointEnv/TokenEnv
// shortcuts, handled in ResolveServer) are ignored.
func splitEnvName(name string) []string {
	name = strings.TrimPrefix(name, envPrefix)
	if name == "DEFAULT_SERVER" {
		return []string{"default-server"}
	}
	parts := strings.Split(name, "_")
	// NIMBUS_SERVERS_<NAME>_ENDPOINT|TOKEN|TOKEN_FILE; underscores inside
	// <NAME> are kept (server names cannot contain the field being set anyway).
	if len(parts) >= 4 && parts[0] == "SERVERS" &&
		parts[len(parts)-2] == "TOKEN" && parts[len(parts)-1] == "FILE" {
		server := strings.ToLower(strings.Join(parts[1:len(parts)-2], "_"))
		return []string{"servers", server, "token_file"}
	}
	if len(parts) >= 3 && parts[0] == "SERVERS" {
		field := strings.ToLower(parts[len(parts)-1])
		if field == "endpoint" || field == "token" {
			server := strings.ToLower(strings.Join(parts[1:len(parts)-1], "_"))
			return []string{"servers", server, field}
		}
	}
	return nil
}

// Load returns the effective configuration: the file overlaid with NIMBUS_
// environment variables (which win).
func Load(path string) (*Config, error) {
	fileCfg, err := LoadFile(path)
	if err != nil {
		return nil, err
	}

	// Round-trip the typed file config through its TOML shape so konf merges
	// maps with the same keys the env splitter produces.
	fileData, err := toml.Marshal(fileCfg)
	if err != nil {
		return nil, err
	}
	fileMap := map[string]any{}
	if err := toml.Unmarshal(fileData, &fileMap); err != nil {
		return nil, err
	}

	var k konf.Config
	if err := k.Load(mapLoader(fileMap)); err != nil {
		return nil, err
	}
	if err := k.Load(
		env.New(env.WithPrefix(envPrefix), env.WithNameSplitter(splitEnvName)),
	); err != nil {
		return nil, err
	}

	cfg := &Config{}
	if err := k.Unmarshal("", cfg); err != nil {
		return nil, fmt.Errorf("merging config: %w", err)
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

// readTokenFile returns the file's contents with trailing whitespace trimmed
// (secret files conventionally end with a newline).
func readTokenFile(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("reading token file %s: %w", path, err)
	}
	return strings.TrimRight(string(data), " \t\r\n"), nil
}

// ResolveServer returns the named server, falling back to NIMBUS_ENDPOINT,
// then the default (or only) configured server when name is empty. A set
// NIMBUS_AUTH_TOKEN (or NIMBUS_AUTH_TOKEN_FILE) overrides the resolved token
// either way; otherwise a server's token_file is read in place of token.
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
	if server.Token != "" && server.TokenFile != "" {
		return "", Server{}, fmt.Errorf(
			"server %q sets both token and token_file; remove one", name,
		)
	}
	if server.Token == "" && server.TokenFile != "" {
		token, err := readTokenFile(server.TokenFile)
		if err != nil {
			return "", Server{}, fmt.Errorf("server %q: %w", name, err)
		}
		server.Token = token
	}
	if token := os.Getenv(TokenEnv); token != "" {
		server.Token = token
	} else if file := os.Getenv(TokenFileEnv); file != "" {
		token, err := readTokenFile(file)
		if err != nil {
			return "", Server{}, fmt.Errorf("%s: %w", TokenFileEnv, err)
		}
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
