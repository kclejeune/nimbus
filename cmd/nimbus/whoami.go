package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"
)

func whoamiCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "whoami [SERVER]",
		Short: "Show what the configured token claims, without contacting the server",
		Long: `Decodes the configured token as a JWT and prints its subject, expiry, and
cache permissions. The signature is deliberately not verified — that is the
server's job — and no network calls are made.`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := loadConfig()
			if err != nil {
				return err
			}
			name := ""
			if len(args) == 1 {
				name = args[0]
			}
			serverName, server, err := cfg.ResolveServer(name)
			if err != nil {
				return err
			}
			if strings.TrimSpace(server.Token) == "" {
				return fmt.Errorf(
					"no token configured for server %q (%s); run `nimbus login`",
					serverName, server.Endpoint,
				)
			}

			fmt.Printf("%-9s %s (%s)\n", "Server:", serverName, server.Endpoint)
			claims, err := decodeJWTClaims(server.Token)
			if err != nil {
				fmt.Println("Token:    opaque token; cannot introspect")
				return nil
			}
			fmt.Print(formatClaims(claims, time.Now()))
			return nil
		},
	}
}

// jwtClaims is the token payload; the namespaces mirror the server's minting
// side (web/src/lib/server/attic-token.ts). Permission maps stay untyped so
// unknown bits survive for display.
type jwtClaims struct {
	Sub   string `json:"sub"`
	Jti   string `json:"jti"`
	Exp   *int64 `json:"exp"`
	Attic struct {
		Caches map[string]map[string]any `json:"caches"`
	} `json:"https://jwt.attic.rs/v1"`
	Nimbus map[string]any `json:"https://nimbus.kclj.io/v1"`
}

// decodeJWTClaims decodes the payload of a JWS compact serialization without
// verifying the signature.
func decodeJWTClaims(token string) (*jwtClaims, error) {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 3 {
		return nil, errors.New("not a JWT")
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return nil, fmt.Errorf("decoding JWT payload: %w", err)
	}
	claims := &jwtClaims{}
	if err := json.Unmarshal(payload, claims); err != nil {
		return nil, fmt.Errorf("parsing JWT payload: %w", err)
	}
	return claims, nil
}

// permissionBits maps the attic short claim keys to readable names, in
// display order. gc/ct are nimbus extensions (normally server-wide, but
// displayed wherever they appear).
var permissionBits = []struct{ key, name string }{
	{"r", "pull"},
	{"w", "push"},
	{"d", "delete"},
	{"cc", "create-cache"},
	{"cr", "configure-cache"},
	{"cq", "configure-retention"},
	{"cd", "destroy-cache"},
	{"gc", "gc"},
	{"ct", "ct"},
}

// claimFlag mirrors the server's flag(): 1, true, or "1" all count as set.
func claimFlag(v any) bool {
	switch v := v.(type) {
	case bool:
		return v
	case string:
		return v == "1"
	case float64:
		return v == 1
	}
	return false
}

func permissionNames(bits map[string]any) string {
	var names []string
	for _, bit := range permissionBits {
		if claimFlag(bits[bit.key]) {
			names = append(names, bit.name)
		}
	}
	if len(names) == 0 {
		return "(none)"
	}
	return strings.Join(names, ", ")
}

func formatClaims(claims *jwtClaims, now time.Time) string {
	var b strings.Builder
	sub := claims.Sub
	if sub == "" {
		sub = "(none)"
	}
	fmt.Fprintf(&b, "%-9s %s\n", "Subject:", sub)
	if claims.Jti != "" {
		fmt.Fprintf(&b, "%-9s %s\n", "Token ID:", claims.Jti)
	}
	fmt.Fprintf(&b, "%-9s %s\n", "Expires:", expiryDesc(claims.Exp, now))

	if len(claims.Attic.Caches) == 0 {
		b.WriteString("Caches:   (none)\n")
	} else {
		b.WriteString("Caches:\n")
		w := tabwriter.NewWriter(&b, 2, 0, 2, ' ', 0)
		for _, pattern := range slices.Sorted(maps.Keys(claims.Attic.Caches)) {
			fmt.Fprintf(w, "  %s\t%s\n", pattern, permissionNames(claims.Attic.Caches[pattern]))
		}
		_ = w.Flush()
	}

	// Server-wide nimbus extension claims (GlobalClaims on the mint side).
	if names := permissionNames(claims.Nimbus); len(claims.Nimbus) > 0 && names != "(none)" {
		fmt.Fprintf(&b, "%-9s %s\n", "Global:", names)
	}
	return b.String()
}

func expiryDesc(exp *int64, now time.Time) string {
	if exp == nil {
		return "never"
	}
	at := time.Unix(*exp, 0)
	stamp := at.Local().Format("2006-01-02 15:04:05 MST")
	if at.Before(now) {
		return fmt.Sprintf("%s (expired %s ago)", stamp, durationDesc(now.Sub(at)))
	}
	return fmt.Sprintf("%s (expires in %s)", stamp, durationDesc(at.Sub(now)))
}

// durationDesc renders a duration at day granularity once it exceeds a day.
func durationDesc(d time.Duration) string {
	if days := int(d.Hours() / 24); days >= 1 {
		if days == 1 {
			return "1 day"
		}
		return fmt.Sprintf("%d days", days)
	}
	return d.Round(time.Minute).String()
}
