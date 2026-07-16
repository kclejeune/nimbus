package main

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

// unsignedJWT builds a structurally valid JWT with a junk signature —
// whoami never verifies it.
func unsignedJWT(payload string) string {
	enc := base64.RawURLEncoding.EncodeToString
	return enc([]byte(`{"alg":"HS256","typ":"JWT"}`)) + "." + enc([]byte(payload)) + ".sig"
}

func TestDecodeJWTClaims(t *testing.T) {
	token := unsignedJWT(`{
		"sub": "alice",
		"jti": "tok-1",
		"exp": 1800000000,
		"https://jwt.attic.rs/v1": {"caches": {
			"mycache": {"r": 1, "w": 1},
			"team-*": {"r": 1, "d": 1, "cc": 1, "cr": 1, "cq": 1, "cd": 1}
		}},
		"https://nimbus.kclj.io/v1": {"gc": 1, "ct": 1}
	}`)
	claims, err := decodeJWTClaims(token)
	if err != nil {
		t.Fatalf("decodeJWTClaims: %v", err)
	}
	if claims.Sub != "alice" || claims.Jti != "tok-1" || claims.Exp == nil ||
		*claims.Exp != 1800000000 {
		t.Errorf("claims = %+v", claims)
	}

	now := time.Unix(1700000000, 0)
	out := formatClaims(claims, now)
	for _, want := range []string{
		"Subject:  alice",
		"Token ID: tok-1",
		"expires in",
		"mycache",
		"pull, push",
		"pull, delete, create-cache, configure-cache, configure-retention, destroy-cache",
		"gc, ct",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q:\n%s", want, out)
		}
	}
}

func TestDecodeJWTClaimsRejectsOpaque(t *testing.T) {
	for _, token := range []string{"not-a-jwt", "a.b", "x.####.z"} {
		if _, err := decodeJWTClaims(token); err == nil {
			t.Errorf("decodeJWTClaims(%q): expected error", token)
		}
	}
}

func TestExpiryDesc(t *testing.T) {
	now := time.Unix(1700000000, 0)
	if got := expiryDesc(nil, now); got != "never" {
		t.Errorf("nil exp: %q", got)
	}
	past := now.Add(-72 * time.Hour).Unix()
	if got := expiryDesc(&past, now); !strings.Contains(got, "expired 3 days ago") {
		t.Errorf("past exp: %q", got)
	}
	future := now.Add(30 * time.Minute).Unix()
	if got := expiryDesc(&future, now); !strings.Contains(got, "expires in 30m") {
		t.Errorf("future exp: %q", got)
	}
}
