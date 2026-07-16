package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"os"
	"slices"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"

	"github.com/kclejeune/nimbus/internal/api"
	"github.com/kclejeune/nimbus/internal/config"
)

func tokenCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "token",
		Short: "Manage API tokens on a server",
	}
	cmd.AddCommand(tokenCreateCmd())
	cmd.AddCommand(tokenListCmd())
	cmd.AddCommand(tokenRevokeCmd())
	return cmd
}

// registerServerFlag adds the -s/--server flag shared by the token
// subcommands, which address a server rather than a cache.
func registerServerFlag(cmd *cobra.Command, server *string) {
	cmd.Flags().
		StringVarP(server, "server", "s", "", "server name (default: the config's default server)")
}

// resolveTokenServer resolves a --server value (empty = default server) and
// requires a configured token: token self-service acts as the user behind
// the presented token, so it can never work anonymously.
func resolveTokenServer(name string) (string, *api.Client, error) {
	cfg, err := loadConfig()
	if err != nil {
		return "", nil, err
	}
	serverName, server, err := cfg.ResolveServer(name)
	if err != nil {
		return "", nil, err
	}
	if strings.TrimSpace(server.Token) == "" {
		return "", nil, fmt.Errorf(
			"no auth token for server %q (%s); run `nimbus login` or set %s",
			serverName, server.Endpoint, config.TokenEnv,
		)
	}
	return serverName, api.New(server.Endpoint, server.Token), nil
}

func tokenCreateCmd() *cobra.Command {
	var server, cache string
	var pull, push, del, configure, destroy, gc, ct bool
	var expiryDays int
	cmd := &cobra.Command{
		Use:   "create NAME",
		Short: "Mint a scoped API token (the plaintext is shown only once)",
		Long: `Mints a token scoped to a cache name or pattern with the requested
permission bits, bounded by your own grants. The plaintext token goes to
stdout on its own line (script-friendly); everything else goes to stderr.

--gc and --ct request the admin-only server-wide claims (garbage collection
and trust-affecting cache settings).`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			serverName, client, err := resolveTokenServer(server)
			if err != nil {
				return err
			}
			var permissions []string
			for _, bit := range []struct {
				set  bool
				name string
			}{
				{pull, "pull"},
				{push, "push"},
				{del, "delete"},
				{configure, "configure_cache"},
				{destroy, "destroy_cache"},
			} {
				if bit.set {
					permissions = append(permissions, bit.name)
				}
			}
			created, err := client.CreateToken(cmd.Context(), &api.TokenCreateRequest{
				Name:        args[0],
				Cache:       cache,
				Permissions: permissions,
				GC:          gc,
				CT:          ct,
				ExpiryDays:  expiryDays,
			})
			if err != nil {
				return err
			}
			expires := time.Unix(created.ExpiresAt, 0).Local().Format("2006-01-02")
			fmt.Fprintf(
				os.Stderr,
				"✅ Created token %q (id %s) on %q, expires %s.\n",
				created.Name, created.ID, serverName, expires,
			)
			fmt.Fprintln(
				os.Stderr,
				"   The plaintext token follows on stdout; it is shown only once — store it now:",
			)
			fmt.Println(created.Token)
			return nil
		},
	}
	registerServerFlag(cmd, &server)
	cmd.Flags().StringVar(&cache, "cache", "*", "cache name or pattern the token is scoped to")
	cmd.Flags().BoolVar(&pull, "pull", false, "grant pull")
	cmd.Flags().BoolVar(&push, "push", false, "grant push")
	cmd.Flags().BoolVar(&del, "delete", false, "grant path deletion")
	cmd.Flags().BoolVar(&configure, "configure", false, "grant cache configuration")
	cmd.Flags().BoolVar(&destroy, "destroy", false, "grant cache destruction")
	cmd.Flags().BoolVar(&gc, "gc", false, "include the server-wide gc claim (admin-only)")
	cmd.Flags().BoolVar(&ct, "ct", false, "include the trust-admin claim (admin-only)")
	cmd.Flags().IntVar(&expiryDays, "expiry-days", 90, "token lifetime in days")
	return cmd
}

func tokenListCmd() *cobra.Command {
	var server string
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List your API tokens (plaintexts are never shown again)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			serverName, client, err := resolveTokenServer(server)
			if err != nil {
				return err
			}
			tokens, err := client.ListTokens(cmd.Context())
			if err != nil {
				return err
			}
			if len(tokens) == 0 {
				fmt.Printf("No tokens on %q.\n", serverName)
				return nil
			}
			fmt.Print(formatTokens(tokens))
			return nil
		},
	}
	registerServerFlag(cmd, &server)
	return cmd
}

func formatTokens(tokens []api.TokenInfo) string {
	var b strings.Builder
	w := tabwriter.NewWriter(&b, 2, 0, 2, ' ', 0)
	fmt.Fprintln(w, "ID\tNAME\tSTATUS\tCREATED\tEXPIRES\tSCOPE")
	for _, token := range tokens {
		expires := "never"
		if token.ExpiresAt != nil {
			expires = dateDesc(*token.ExpiresAt)
		}
		fmt.Fprintf(
			w,
			"%s\t%s\t%s\t%s\t%s\t%s\n",
			token.ID,
			token.Name,
			token.Status,
			dateDesc(token.CreatedAt),
			expires,
			compactScope(token.Scope),
		)
	}
	_ = w.Flush()
	return b.String()
}

func dateDesc(epoch int64) string {
	return time.Unix(epoch, 0).Local().Format("2006-01-02")
}

// compactScope renders a token's stored scope JSON ({pattern: {bit: 1}}) as
// space-separated pattern=bit,bit entries, e.g. `*=r,w`. The bit keys are the
// attic short names (see permissionBits in whoami.go). An unparseable scope
// is returned verbatim rather than hidden.
func compactScope(scope string) string {
	var caches map[string]map[string]any
	if err := json.Unmarshal([]byte(scope), &caches); err != nil || len(caches) == 0 {
		return scope
	}
	var entries []string
	for _, pattern := range slices.Sorted(maps.Keys(caches)) {
		var bits []string
		for _, bit := range permissionBits {
			if claimFlag(caches[pattern][bit.key]) {
				bits = append(bits, bit.key)
			}
		}
		if len(bits) == 0 {
			entries = append(entries, pattern+"=-")
			continue
		}
		entries = append(entries, pattern+"="+strings.Join(bits, ","))
	}
	return strings.Join(entries, " ")
}

func tokenRevokeCmd() *cobra.Command {
	var server string
	cmd := &cobra.Command{
		Use:   "revoke ID",
		Short: "Revoke one of your API tokens by id",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			serverName, client, err := resolveTokenServer(server)
			if err != nil {
				return err
			}
			if err := client.RevokeToken(cmd.Context(), args[0]); err != nil {
				var apiErr *api.Error
				if errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound {
					return fmt.Errorf(
						"no token with id %q on server %q (see `nimbus token list`)",
						args[0], serverName,
					)
				}
				return err
			}
			fmt.Printf("✅ Revoked token %s on %q\n", args[0], serverName)
			return nil
		},
	}
	registerServerFlag(cmd, &server)
	return cmd
}
