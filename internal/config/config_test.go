package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNormalizeEndpoint(t *testing.T) {
	cases := map[string]string{
		"https://cache.kclj.io":   "https://cache.kclj.io",
		"https://cache.kclj.io/":  "https://cache.kclj.io",
		"cache.kclj.io":           "https://cache.kclj.io",
		"cache.kclj.io/":          "https://cache.kclj.io",
		"localhost:8788":          "https://localhost:8788",
		"http://localhost:8788":   "http://localhost:8788",
		" cache.kclj.io ":         "https://cache.kclj.io",
		"https://cache.kclj.io//": "https://cache.kclj.io",
	}
	for in, want := range cases {
		got, err := NormalizeEndpoint(in)
		if err != nil {
			t.Errorf("NormalizeEndpoint(%q): %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("NormalizeEndpoint(%q) = %q, want %q", in, got, want)
		}
	}
	for _, bad := range []string{"", "   ", "ftp://cache.kclj.io", "https://"} {
		if got, err := NormalizeEndpoint(bad); err == nil {
			t.Errorf("NormalizeEndpoint(%q) = %q, want error", bad, got)
		}
	}
}

func TestResolveServerEnvOverrides(t *testing.T) {
	cfg := &Config{
		DefaultServer: "prod",
		Servers: map[string]Server{
			"prod": {Endpoint: "cache.kclj.io", Token: "config-token"},
		},
	}

	// Bare-hostname endpoints from the config file are normalized.
	name, server, err := cfg.ResolveServer("")
	if err != nil {
		t.Fatal(err)
	}
	if name != "prod" || server.Endpoint != "https://cache.kclj.io" ||
		server.Token != "config-token" {
		t.Fatalf("config resolution: got %q %+v", name, server)
	}

	// NIMBUS_ENDPOINT defines the server when none is named...
	t.Setenv(EndpointEnv, "other.example.com")
	t.Setenv(TokenEnv, "env-token")
	name, server, err = cfg.ResolveServer("")
	if err != nil {
		t.Fatal(err)
	}
	if name != "env" || server.Endpoint != "https://other.example.com" ||
		server.Token != "env-token" {
		t.Fatalf("env resolution: got %q %+v", name, server)
	}

	// ...but an explicitly named server wins over NIMBUS_ENDPOINT, with
	// NIMBUS_AUTH_TOKEN still overriding its token.
	name, server, err = cfg.ResolveServer("prod")
	if err != nil {
		t.Fatal(err)
	}
	if name != "prod" || server.Endpoint != "https://cache.kclj.io" || server.Token != "env-token" {
		t.Fatalf("named resolution: got %q %+v", name, server)
	}

	// With no config at all, the env endpoint alone is enough.
	empty := &Config{Servers: map[string]Server{}}
	if _, server, err = empty.ResolveServer(""); err != nil || server.Token != "env-token" {
		t.Fatalf("zero-config resolution: %+v, %v", server, err)
	}
}

func TestLoadEnvLayers(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/config.toml"
	fileCfg := &Config{
		DefaultServer: "prod",
		Servers: map[string]Server{
			"prod": {Endpoint: "https://cache.kclj.io", Token: "file-token"},
		},
	}
	if err := fileCfg.Save(path); err != nil {
		t.Fatal(err)
	}

	// Config-shaped env vars override fields and define new servers.
	t.Setenv("NIMBUS_SERVERS_PROD_TOKEN", "env-token")
	t.Setenv("NIMBUS_SERVERS_CI_ENDPOINT", "ci.example.com")
	t.Setenv("NIMBUS_SERVERS_CI_TOKEN", "ci-token")
	t.Setenv("NIMBUS_DEFAULT_SERVER", "ci")
	// Shortcuts and unrelated variables are not part of the config shape.
	t.Setenv("NIMBUS_AUTH_TOKEN", "shortcut-token")
	t.Setenv("NIMBUS_UNRELATED", "x")

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DefaultServer != "ci" {
		t.Errorf("DefaultServer = %q, want %q", cfg.DefaultServer, "ci")
	}
	if got := cfg.Servers["prod"]; got.Token != "env-token" ||
		got.Endpoint != "https://cache.kclj.io" {
		t.Errorf("prod = %+v, want file endpoint with env token", got)
	}
	if got := cfg.Servers["ci"]; got.Endpoint != "ci.example.com" || got.Token != "ci-token" {
		t.Errorf("ci = %+v, want env-defined server", got)
	}

	// The env-defined default resolves end to end, normalized.
	name, server, err := cfg.ResolveServer("")
	if err != nil {
		t.Fatal(err)
	}
	// NIMBUS_AUTH_TOKEN (set above) still wins the token as the most specific.
	if name != "ci" || server.Endpoint != "https://ci.example.com" ||
		server.Token != "shortcut-token" {
		t.Errorf("resolution: got %q %+v", name, server)
	}

	// The file itself is untouched by env overlays.
	onDisk, err := LoadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if onDisk.DefaultServer != "prod" || onDisk.Servers["prod"].Token != "file-token" {
		t.Errorf("file layer polluted: %+v", onDisk)
	}
	if _, ok := onDisk.Servers["ci"]; ok {
		t.Error("env-defined server leaked into file layer")
	}
}

func writeTokenFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestResolveServerTokenFile(t *testing.T) {
	tokenPath := writeTokenFile(t, "file-token\n")
	cfg := &Config{
		DefaultServer: "prod",
		Servers: map[string]Server{
			"prod": {Endpoint: "cache.kclj.io", TokenFile: tokenPath},
		},
	}

	// token_file is read with trailing whitespace trimmed.
	_, server, err := cfg.ResolveServer("")
	if err != nil {
		t.Fatal(err)
	}
	if server.Token != "file-token" {
		t.Errorf("Token = %q, want %q", server.Token, "file-token")
	}

	// NIMBUS_AUTH_TOKEN still overrides a token_file-configured server.
	t.Setenv(TokenEnv, "env-token")
	if _, server, err = cfg.ResolveServer(""); err != nil || server.Token != "env-token" {
		t.Errorf("TokenEnv override: %q, %v", server.Token, err)
	}
	t.Setenv(TokenEnv, "")

	// NIMBUS_AUTH_TOKEN_FILE overrides via a file.
	t.Setenv(TokenFileEnv, writeTokenFile(t, "shortcut-token\t\n"))
	if _, server, err = cfg.ResolveServer(""); err != nil || server.Token != "shortcut-token" {
		t.Errorf("TokenFileEnv override: %q, %v", server.Token, err)
	}
}

func TestResolveServerTokenFileErrors(t *testing.T) {
	// Both token and token_file set is a config error.
	both := &Config{
		DefaultServer: "prod",
		Servers: map[string]Server{
			"prod": {Endpoint: "cache.kclj.io", Token: "x", TokenFile: "/some/file"},
		},
	}
	if _, _, err := both.ResolveServer(""); err == nil ||
		!strings.Contains(err.Error(), "both token and token_file") {
		t.Errorf("both set: err = %v, want both-set error", err)
	}

	// An unreadable token file reports its path.
	missing := filepath.Join(t.TempDir(), "nope")
	unreadable := &Config{
		DefaultServer: "prod",
		Servers: map[string]Server{
			"prod": {Endpoint: "cache.kclj.io", TokenFile: missing},
		},
	}
	if _, _, err := unreadable.ResolveServer(""); err == nil ||
		!strings.Contains(err.Error(), missing) {
		t.Errorf("unreadable file: err = %v, want error naming %s", err, missing)
	}
}

func TestLoadTokenFileEnvLayers(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/config.toml"
	fileCfg := &Config{
		DefaultServer: "prod",
		Servers: map[string]Server{
			"prod": {Endpoint: "https://cache.kclj.io"},
		},
	}
	if err := fileCfg.Save(path); err != nil {
		t.Fatal(err)
	}

	tokenPath := writeTokenFile(t, "env-file-token\n")
	t.Setenv("NIMBUS_SERVERS_PROD_TOKEN_FILE", tokenPath)

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := cfg.Servers["prod"].TokenFile; got != tokenPath {
		t.Fatalf("TokenFile = %q, want %q", got, tokenPath)
	}
	if _, server, err := cfg.ResolveServer(""); err != nil || server.Token != "env-file-token" {
		t.Errorf("resolution: %q, %v", server.Token, err)
	}
}

func TestTokenFileRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/config.toml"
	saved := &Config{
		DefaultServer: "prod",
		Servers: map[string]Server{
			"prod": {Endpoint: "https://cache.kclj.io", TokenFile: "/run/secrets/nimbus"},
		},
	}
	if err := saved.Save(path); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := loaded.Servers["prod"]; got.TokenFile != "/run/secrets/nimbus" || got.Token != "" {
		t.Errorf("round trip: %+v", got)
	}
}
