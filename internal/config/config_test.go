package config

import "testing"

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
