package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"slices"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/kclejeune/nimbus/internal/api"
	"github.com/kclejeune/nimbus/internal/config"
	"github.com/kclejeune/nimbus/internal/nix"
)

func doctorCmd() *cobra.Command {
	var asJSON bool
	var timeout time.Duration
	cmd := &cobra.Command{
		Use:     "doctor [SERVER:]CACHE",
		Aliases: []string{"dr"},
		Short:   "Check cache access, Nix configuration, and closure warnings",
		Long: `Checks token expiry, server access and permissions, effective Nix settings,
and one page of unresolved dependencies recorded by GC. Suggests commands to
resolve warnings without applying fixes. Uses GET requests and local inspection;
does not probe upstreams, refresh verdicts, upload, delete, or run GC.
Closure warnings are a GC snapshot, not proof of current upstream absence.
Returns 1 for warnings/errors, 0 when all performed checks pass. --json emits
the report on stdout; progress goes to stderr.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if timeout <= 0 {
				return errors.New("--timeout must be positive")
			}
			ref, client, err := resolveCache(args[0])
			if err != nil {
				return err
			}
			ctx, cancel := context.WithTimeout(cmd.Context(), timeout)
			defer cancel()
			p := newMaintenanceProgress(cmd.ErrOrStderr())
			defer p.close()
			d := cacheDoctor{
				target:     args[0],
				configFile: cfgFile,
				ref:        ref,
				client:     client,
				settings:   readDoctorNixSettings,
				local:      nix.SplitValid,
				readFile:   os.ReadFile,
			}
			report := d.check(ctx, p)
			p.close()
			if err := report.write(cmd.OutOrStdout(), asJSON); err != nil {
				return err
			}
			if report.Warnings > 0 || report.Errors > 0 {
				return fmt.Errorf(
					"doctor found %d warnings and %d errors",
					report.Warnings,
					report.Errors,
				)
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "output a structured diagnostic report")
	cmd.Flags().DurationVar(&timeout, "timeout", 30*time.Second, "total time limit for checks")
	return cmd
}

type doctorFinding struct {
	Check       string   `json:"check"`
	Status      string   `json:"status"`
	Message     string   `json:"message"`
	Suggestions []string `json:"suggestions,omitempty"`
}

type doctorReport struct {
	Server   string          `json:"server"`
	Cache    string          `json:"cache"`
	Findings []doctorFinding `json:"findings"`
	Warnings int             `json:"warnings"`
	Errors   int             `json:"errors"`
}

func (r *doctorReport) add(check, status, message string, suggestions ...string) {
	r.Findings = append(r.Findings, doctorFinding{check, status, message, suggestions})
	switch status {
	case "warn":
		r.Warnings++
	case "error":
		r.Errors++
	}
}

func (r doctorReport) write(out io.Writer, asJSON bool) error {
	if asJSON {
		enc := json.NewEncoder(out)
		enc.SetIndent("", "  ")
		return enc.Encode(r)
	}
	fmt.Fprintf(out, "Doctor: %s:%s\n", r.Server, r.Cache)
	for _, finding := range r.Findings {
		fmt.Fprintf(
			out,
			"%s [%s] %s\n",
			strings.ToUpper(finding.Status),
			finding.Check,
			finding.Message,
		)
		for _, suggestion := range finding.Suggestions {
			fmt.Fprintf(out, "  → %s\n", suggestion)
		}
	}
	_, err := fmt.Fprintf(out, "Checks complete: %d warnings, %d errors.\n", r.Warnings, r.Errors)
	return err
}

// Only the effective values are retained; Nix settings can include credentials.
type doctorNixSettings struct {
	Substituters []string
	Keys         []string
	Netrc        string
}

func readDoctorNixSettings(ctx context.Context) (*doctorNixSettings, error) {
	// show-config also works on Nix versions predating `nix config show`.
	data, err := exec.CommandContext(ctx, "nix", "--extra-experimental-features", "nix-command", "show-config", "--json").
		Output()
	if err != nil {
		// ExitError's stderr can contain config secrets; don't include it.
		return nil, fmt.Errorf("reading effective Nix settings: %w", err)
	}
	var values map[string]struct {
		Value json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(data, &values); err != nil {
		return nil, errors.New("nix returned an unreadable configuration document")
	}
	settings := &doctorNixSettings{}
	for name, dest := range map[string]any{"substituters": &settings.Substituters, "trusted-public-keys": &settings.Keys, "netrc-file": &settings.Netrc} {
		if err := json.Unmarshal(values[name].Value, dest); err != nil {
			return nil, fmt.Errorf("nix returned an unreadable %s setting", name)
		}
	}
	return settings, nil
}

type cacheDoctor struct {
	target     string
	configFile string
	ref        *config.CacheRef
	client     *api.Client
	settings   func(context.Context) (*doctorNixSettings, error)
	local      func(context.Context, []string) ([]string, []string, error)
	readFile   func(string) ([]byte, error)
}

func (d cacheDoctor) check(ctx context.Context, p *maintenanceProgress) doctorReport {
	r := doctorReport{Server: d.ref.ServerName, Cache: d.ref.Cache}
	cacheRef := d.ref.ServerName + ":" + d.ref.Cache
	if d.target != "" {
		// Preserve bare references for NIMBUS_ENDPOINT's virtual "env" server,
		// which cannot be resolved as an explicitly named server.
		cacheRef = d.target
	}
	// Quote shell arguments even though suggestions are never executed here.
	command := "nimbus"
	if d.configFile != "" {
		command += " --config " + doctorShellArg(d.configFile)
	}
	cacheArg := doctorShellArg(cacheRef)
	loginURL, _ := url.Parse(d.ref.Server.Endpoint)
	loginURL.User, loginURL.RawQuery, loginURL.Fragment = nil, "", ""
	login := command + " login " + doctorShellArg(
		d.ref.ServerName,
	) + " " + doctorShellArg(
		loginURL.String(),
	)
	use := command + " use " + cacheArg
	whoami := command + " whoami"
	if d.ref.ServerName != "env" || strings.Contains(d.target, ":") {
		whoami += " " + doctorShellArg(d.ref.ServerName)
	}
	p.update("Checking token and effective Nix configuration")
	if d.ref.Server.Token == "" {
		r.add("token", "warn", "No token configured; only public cache discovery can work.", login)
	} else if claims, err := decodeJWTClaims(d.ref.Server.Token); err != nil {
		r.add(
			"token",
			"info",
			"Token claims cannot be decoded locally; server validation is required.",
		)
	} else if claims.Exp != nil {
		remaining := time.Until(time.Unix(*claims.Exp, 0))
		switch {
		case remaining <= 0:
			r.add("token", "error", "Configured token claims are expired.", login)
		case remaining < 7*24*time.Hour:
			r.add("token", "warn", "Configured token claims expire within seven days.", login)
		default:
			r.add(
				"token",
				"ok",
				"Token claims are not expired; signature validation is performed by the server.",
			)
		}
	} else {
		r.add("token", "info", "Token claims have no expiry; server validation is still required.")
	}
	settings, nixErr := d.settings(ctx)
	if nixErr != nil {
		r.add(
			"nix",
			"warn",
			"Cannot read effective Nix settings; local configuration checks skipped.",
			"Check that Nix is installed and `nix --extra-experimental-features nix-command show-config --json` succeeds.",
		)
	} else {
		r.add("nix", "ok", "Effective Nix configuration is readable.")
	}
	p.update("Checking cache discovery and permissions")
	info, err := d.client.GetCacheInfo(ctx, d.ref.Cache)
	if err != nil {
		d.apiFailure(&r, "cache", err, login)
	} else {
		r.add("cache", "ok", "Cache discovery is reachable and readable.")
		if info.StoreDir != nix.StoreDir {
			r.add(
				"store",
				"warn",
				"Cache store directory differs from this CLI's /nix/store.",
				"Use a cache configured for /nix/store.",
			)
		}
		if settings != nil {
			d.checkNix(&r, settings, info, use)
		}
	}
	entries, err := d.client.ListCaches(ctx)
	if err != nil {
		d.apiFailure(&r, "permissions", err, login)
	} else {
		found := false
		for _, entry := range entries {
			if entry.Name == d.ref.Cache {
				found = true
				perm := entry.Permissions
				r.add(
					"permissions",
					"info",
					fmt.Sprintf(
						"Server reports pull=%t, push=%t, delete=%t. Public discovery alone does not validate the token.",
						perm.Pull,
						perm.Push,
						perm.Delete,
					),
				)
			}
		}
		if !found {
			r.add(
				"permissions",
				"warn",
				"Target cache is absent from the server's visible cache list.",
				"Check the cache name and token scopes with `"+whoami+"`.",
			)
		}
	}
	if d.ref.Server.Token == "" {
		r.add(
			"closures",
			"warn",
			"Closure inspection requires a token with Pull and either Push or Delete.",
			login,
		)
		return r
	}
	p.update("Reading GC-recorded closure warnings (one page)")
	page, err := d.client.UncoveredReferences(ctx, d.ref.Cache, "")
	if err != nil {
		d.apiFailure(&r, "closures", err, login)
		return r
	}
	r.add("authentication", "ok", "The maintenance endpoint accepted the configured token.")
	if len(page.References) == 0 && page.NextCursor == "" {
		r.add(
			"closures",
			"ok",
			"No unresolved dependencies in the GC reference graph; this is not a full cache audit.",
		)
		return r
	}
	count := fmt.Sprintf("%d", len(page.References))
	if page.NextCursor != "" {
		count = "at least " + count
	}
	r.add(
		"closures",
		"warn",
		count+" GC-recorded dependencies have unresolved coverage. Upstream availability has not been rechecked.",
		command+" repair "+cacheArg+" (requires Pull and Push; verifies coverage and plans uploads)",
		command+" purge "+cacheArg+" (requires Pull and Delete; preview removal of obsolete broken paths)",
	)
	if nixErr != nil {
		return r
	}
	paths := make([]string, 0, len(page.References))
	for _, ref := range page.References {
		match := repairPath.FindStringSubmatch(ref.StorePath)
		if match == nil || match[1] != ref.Hash {
			r.add(
				"local-repair",
				"error",
				"Server returned an invalid dependency path; local inspection skipped.",
				"Check the Worker version and server logs.",
			)
			return r
		}
		paths = append(paths, ref.StorePath)
	}
	available := 0
	for start := 0; start < len(paths); start += repairBatchSize {
		p.update(
			"Inspecting local dependencies: %d/%d",
			min(start+repairBatchSize, len(paths)),
			len(paths),
		)
		valid, _, err := d.local(ctx, paths[start:min(start+repairBatchSize, len(paths))])
		if err != nil {
			r.add(
				"local-repair",
				"warn",
				"Cannot inspect the local Nix store.",
				"Check that nix-store can access your local store.",
			)
			return r
		}
		available += len(valid)
	}
	r.add(
		"local-repair",
		"info",
		fmt.Sprintf(
			"%d/%d dependencies on this page are available locally; this does not confirm they need uploading.",
			available,
			len(paths),
		),
		"Run repair on the original build machine or rebuild missing outputs if needed.",
	)
	return r
}

func (d cacheDoctor) apiFailure(r *doctorReport, check string, err error, login string) {
	var apiErr *api.Error
	if errors.As(err, &apiErr) {
		switch {
		case apiErr.HTMLResponse:
			r.add(
				check,
				"error",
				"Received an HTML response instead of the cache API.",
				"Check the cache-host endpoint and Cloudflare Access/WAF rules for /_api/v1/cache-integrity/.",
			)
		case apiErr.Status == http.StatusUnauthorized:
			r.add(check, "error", "Server rejected the token: missing, expired, or revoked.", login)
		case apiErr.Status == http.StatusForbidden:
			r.add(
				check,
				"warn",
				"Check denied by token permissions; closure inspection requires Pull and either Push or Delete.",
				login+" (select the required cache scopes)",
			)
		case apiErr.Status == http.StatusNotFound && check == "closures":
			r.add(
				check,
				"warn",
				"Closure endpoint unavailable: cache may be missing or Worker may lack maintenance support.",
				"Check the cache name and deploy a Worker with cache-integrity support.",
			)
		default:
			r.add(
				check,
				"error",
				fmt.Sprintf("Cache API returned HTTP %d.", apiErr.Status),
				"Check server logs, connectivity, and rate limits; then retry doctor.",
			)
		}
		return
	}
	// Transport errors can contain credential-bearing URLs; keep them off stdout.
	r.add(
		check,
		"error",
		"Request failed or timed out; the API response could not be read.",
		"Check connectivity, endpoint, and Worker logs; retry with a longer --timeout if needed.",
	)
}

func (d cacheDoctor) checkNix(
	r *doctorReport,
	settings *doctorNixSettings,
	info *api.CacheInfo,
	use string,
) {
	normalize := func(raw string) string {
		u, err := url.Parse(raw)
		if err != nil {
			return raw
		}
		u.RawQuery, u.Fragment = "", ""
		return strings.TrimRight(u.String(), "/")
	}
	exact, root := false, false
	for _, sub := range settings.Substituters {
		exact = exact || normalize(sub) == normalize(info.SubstituterEndpoint)
		root = root || normalize(sub) == normalize(d.ref.Server.Endpoint)
	}
	switch {
	case exact:
		r.add("substituter", "ok", "The cache is enabled in Nix's effective substituters.")
	case root:
		r.add("substituter", "info", "The server's unified root substituter is configured.")
	default:
		r.add(
			"substituter",
			"warn",
			"Neither the cache nor the server's unified root is enabled as a substituter.",
			use,
		)
	}
	if exact {
		if info.PublicKey != "" && slices.Contains(settings.Keys, info.PublicKey) {
			r.add(
				"signing-key",
				"ok",
				"The cache signing key is trusted by the local Nix configuration.",
			)
		} else {
			r.add(
				"signing-key",
				"warn",
				"The cache signing key is missing from trusted-public-keys.",
				use,
			)
		}
	} else if root {
		r.add(
			"signing-key",
			"warn",
			"Unified root uses a separate signing key; this per-cache diagnostic cannot verify it.",
			"Verify the root proxy key from the Nimbus dashboard against Nix's trusted-public-keys.",
		)
	}
	if !info.IsPublic {
		u, err := url.Parse(info.SubstituterEndpoint)
		if err != nil || u.Host == "" {
			r.add("netrc", "error", "Server returned an invalid substituter endpoint.")
			return
		}
		data, err := d.readFile(settings.Netrc)
		if err != nil || !doctorNetrcHasPassword(string(data), u.Hostname(), u.Host) {
			r.add(
				"netrc",
				"warn",
				"Nix's effective netrc-file has no readable password entry for the cache host.",
				use,
				"Check netrc-file overrides in system Nix configuration and NIX_CONFIG.",
			)
		} else {
			r.add(
				"netrc",
				"info",
				"A netrc credential exists for the private cache host; its server authorization is not checked here.",
			)
		}
	}
}

// Nimbus uses JWT passwords (no whitespace). Accept standard multiline and
// quoted machine/password fields without ever displaying file contents. Default
// credentials are a fallback only when no matching machine stanza exists.
func doctorNetrcHasPassword(data string, hosts ...string) bool {
	var words []string
	for line := range strings.SplitSeq(data, "\n") {
		line, _, _ = strings.Cut(line, "#")
		words = append(words, strings.Fields(line)...)
	}
	current := ""
	inDefault := false
	matchedMachine, matchedPassword, defaultPassword := false, false, false
	for i := 0; i < len(words); i++ {
		word := strings.Trim(words[i], `"`)
		if word == "default" {
			current = ""
			inDefault = true
		}
		if slices.Contains([]string{"machine", "login", "password", "account"}, word) &&
			i+1 < len(words) {
			i++
			value := strings.Trim(words[i], `"`)
			if word == "machine" {
				current = value
				inDefault = false
				matchedMachine = matchedMachine || slices.Contains(hosts, current)
			} else if word == "password" && value != "" {
				if inDefault {
					defaultPassword = true
				} else if slices.Contains(hosts, current) {
					matchedPassword = true
				}
			}
		}
	}
	return matchedPassword || (!matchedMachine && defaultPassword)
}

func doctorShellArg(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}
