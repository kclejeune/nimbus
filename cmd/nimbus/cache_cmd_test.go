package main

import (
	"strings"
	"testing"

	"github.com/kclejeune/nimbus/internal/api"
)

func intPtr(v int) *int       { return &v }
func int64Ptr(v int64) *int64 { return &v }
func strPtr(v string) *string { return &v }

func TestRetentionDesc(t *testing.T) {
	tests := []struct {
		name     string
		days     *int64
		maxBytes *int64
		want     string
	}{
		{"none", nil, nil, "none"},
		{"days only", int64Ptr(30), nil, "30d"},
		{"bytes only", nil, int64Ptr(50 << 30), "50.0 GiB"},
		{"both", int64Ptr(30), int64Ptr(50 << 30), "30d, 50.0 GiB"},
		{"small bytes", nil, int64Ptr(512), "512 B"},
		{"mebibytes", nil, int64Ptr(1536 << 10), "1.5 MiB"},
	}
	for _, tt := range tests {
		if got := retentionDesc(tt.days, tt.maxBytes); got != tt.want {
			t.Errorf("%s: retentionDesc() = %q, want %q", tt.name, got, tt.want)
		}
	}
}

func TestAccessDesc(t *testing.T) {
	tests := []struct {
		name string
		perm api.CachePermissions
		want string
	}{
		{"none", api.CachePermissions{}, "-"},
		{"pull only", api.CachePermissions{Pull: true}, "pull"},
		{
			"full",
			api.CachePermissions{
				Pull: true, Push: true, Delete: true,
				ConfigureCache: true, ConfigureCacheRetention: true, DestroyCache: true,
			},
			"pull,push,delete,configure,destroy",
		},
		{
			// configure_cache subsumes the retention sub-permission.
			"configure without retention bit",
			api.CachePermissions{ConfigureCache: true},
			"configure",
		},
		{
			"retention only",
			api.CachePermissions{ConfigureCacheRetention: true},
			"retention",
		},
	}
	for _, tt := range tests {
		if got := accessDesc(tt.perm); got != tt.want {
			t.Errorf("%s: accessDesc() = %q, want %q", tt.name, got, tt.want)
		}
	}
}

func TestFormatCacheList(t *testing.T) {
	caches := []api.CacheListEntry{
		{
			Name:              "nixos",
			Public:            true,
			Priority:          40,
			Compression:       "zstd",
			RetentionPeriod:   int64Ptr(30),
			RetentionMaxBytes: int64Ptr(50 << 30),
			Permissions:       api.CachePermissions{Pull: true, Push: true},
		},
		{
			Name:        "private",
			Priority:    41,
			Compression: "gzip",
			Permissions: api.CachePermissions{Pull: true},
		},
	}
	out := formatCacheList(caches)
	for _, want := range []string{
		"NAME", "VISIBILITY", "PRIORITY", "COMPRESSION", "RETENTION", "ACCESS",
		"nixos", "public", "40", "zstd", "30d, 50.0 GiB", "pull,push",
		"private", "41", "gzip", "none",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q:\n%s", want, out)
		}
	}
}

func TestFormatPins(t *testing.T) {
	pins := []api.Pin{
		{
			Name:          "deploy",
			KeepRevisions: intPtr(5),
			KeepDays:      intPtr(30),
			Revisions: []api.PinRevision{
				{
					Hash:      strings.Repeat("a", 32),
					CreatedAt: "2026-07-01T00:00:00Z",
					Note:      strPtr("prod"),
				},
				{Hash: strings.Repeat("b", 32), CreatedAt: "2026-06-01T00:00:00Z"},
			},
		},
		{Name: "empty"},
		{
			// Anonymous quick pin, should the server ever include them.
			Revisions: []api.PinRevision{
				{
					Hash:      strings.Repeat("c", 32),
					CreatedAt: "2026-05-01T00:00:00Z",
					Note:      strPtr("keep me"),
				},
			},
		},
	}

	out := formatPins(pins)
	for _, want := range []string{
		"NAME", "CURRENT", "REVISIONS", "KEEP", "NOTE",
		"deploy", strings.Repeat("a", 32), "5 revisions, 30 days", "prod",
		"Anonymous pins:", strings.Repeat("c", 32), "# keep me",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q:\n%s", want, out)
		}
	}
	// A named pin with no revisions renders placeholders instead of crashing.
	if !strings.Contains(out, "empty") {
		t.Errorf("output missing revision-less pin:\n%s", out)
	}
	// The current revision's hash appears once (older revisions are counted,
	// not listed).
	if strings.Contains(out, strings.Repeat("b", 32)) {
		t.Errorf("output lists non-current revision:\n%s", out)
	}
}
