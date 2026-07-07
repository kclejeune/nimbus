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
