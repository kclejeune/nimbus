package main

import (
	"strings"
	"testing"

	"github.com/kclejeune/nimbus/internal/api"
)

func TestCompactScope(t *testing.T) {
	tests := []struct {
		name  string
		scope string
		want  string
	}{
		{
			"wildcard read-write",
			`{"*":{"r":1,"w":1}}`,
			"*=r,w",
		},
		{
			// Bits render in canonical order regardless of JSON key order,
			// and boolean/string flag encodings count like numeric ones.
			"all bits mixed encodings",
			`{"ci-*":{"cd":true,"d":"1","w":1,"r":1,"cr":1,"cq":1,"cc":1}}`,
			"ci-*=r,w,d,cc,cr,cq,cd",
		},
		{
			"multiple patterns sorted",
			`{"prod":{"r":1},"dev":{"r":1,"w":1}}`,
			"dev=r,w prod=r",
		},
		{
			"no bits set",
			`{"*":{}}`,
			"*=-",
		},
		{
			// Unset flags (0, false, "0") do not count as granted.
			"explicitly cleared bits",
			`{"*":{"r":1,"w":0,"d":false}}`,
			"*=r",
		},
		{
			// Unparseable scopes surface verbatim instead of vanishing.
			"invalid json",
			`not-json`,
			"not-json",
		},
		{
			"empty object",
			`{}`,
			"{}",
		},
	}
	for _, tt := range tests {
		if got := compactScope(tt.scope); got != tt.want {
			t.Errorf("%s: compactScope(%q) = %q, want %q", tt.name, tt.scope, got, tt.want)
		}
	}
}

func TestFormatTokens(t *testing.T) {
	// 2026-07-01T12:00:00Z / 2026-09-29T12:00:00Z; formatted dates are local,
	// so compare against the same helper rather than hardcoded strings.
	created, expires := int64(1782561600), int64(1790337600)
	tokens := []api.TokenInfo{
		{
			ID:        "abc-123",
			Name:      "laptop",
			Scope:     `{"*":{"r":1,"w":1}}`,
			CreatedAt: created,
			ExpiresAt: &expires,
			Status:    "active",
		},
		{
			ID:        "def-456",
			Name:      "ci",
			Scope:     `{"ci-*":{"r":1}}`,
			CreatedAt: created,
			Status:    "revoked",
		},
	}
	out := formatTokens(tokens)
	for _, want := range []string{
		"ID", "NAME", "STATUS", "CREATED", "EXPIRES", "SCOPE",
		"abc-123", "laptop", "active", dateDesc(created), dateDesc(expires), "*=r,w",
		"def-456", "ci", "revoked", "never", "ci-*=r",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q:\n%s", want, out)
		}
	}
}
