package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"

	"github.com/kclejeune/nimbus/internal/api"
	"github.com/kclejeune/nimbus/internal/nix"
	"github.com/kclejeune/nimbus/internal/push"
)

func cacheCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "cache",
		Short: "Manage caches on a server",
	}
	cmd.AddCommand(cacheListCmd())
	cmd.AddCommand(cacheCreateCmd())
	cmd.AddCommand(cacheInfoCmd())
	cmd.AddCommand(cacheRmCmd())
	cmd.AddCommand(cacheConfigureCmd())
	cmd.AddCommand(cacheDestroyCmd())
	cmd.AddCommand(cacheRenameCmd())
	cmd.AddCommand(cachePinCmd())
	cmd.AddCommand(cachePinsCmd())
	cmd.AddCommand(cacheUnpinCmd())
	return cmd
}

// cacheFlags collects the settings shared by create and configure.
type cacheFlags struct {
	public            bool
	private           bool
	priority          int
	compression       string
	retentionDays     int
	retentionMaxBytes int64
	upstreamKeyNames  []string
	regenKeypair      bool
}

func (f *cacheFlags) register(cmd *cobra.Command, includeKeypair bool) {
	cmd.Flags().BoolVar(&f.public, "public", false, "make the cache publicly readable")
	cmd.Flags().BoolVar(&f.private, "private", false, "require a token to pull")
	cmd.MarkFlagsMutuallyExclusive("public", "private")
	cmd.Flags().IntVar(&f.priority, "priority", 0, "substituter priority (lower wins)")
	cmd.Flags().StringVar(&f.compression, "compression", "", "NAR compression: zstd, gzip, or none")
	cmd.Flags().
		IntVar(&f.retentionDays, "retention-days", 0, "expire unused paths after this many days (-1 to disable)")
	cmd.Flags().
		Int64Var(&f.retentionMaxBytes, "retention-max-bytes", 0, "cap the cache's compressed storage in bytes (-1 to disable)")
	cmd.Flags().
		StringSliceVar(&f.upstreamKeyNames, "upstream-cache-key-name", nil, "signing key names of upstream caches (repeatable; clients skip re-uploading paths signed by them)")
	if includeKeypair {
		cmd.Flags().
			BoolVar(&f.regenKeypair, "regenerate-keypair", false, "generate a new signing keypair")
	}
}

func (f *cacheFlags) options(cmd *cobra.Command) map[string]any {
	opts := map[string]any{}
	if cmd.Flags().Changed("public") {
		opts["is_public"] = true
	}
	if cmd.Flags().Changed("private") {
		opts["is_public"] = false
	}
	if cmd.Flags().Changed("priority") {
		opts["priority"] = f.priority
	}
	if cmd.Flags().Changed("compression") {
		opts["compression"] = f.compression
	}
	if cmd.Flags().Changed("retention-days") {
		if f.retentionDays >= 0 {
			opts["retention_period"] = f.retentionDays
		} else {
			// Explicit null clears retention.
			opts["retention_period"] = nil
		}
	}
	if cmd.Flags().Changed("retention-max-bytes") {
		if f.retentionMaxBytes >= 0 {
			opts["retention_max_bytes"] = f.retentionMaxBytes
		} else {
			opts["retention_max_bytes"] = nil
		}
	}
	if cmd.Flags().Changed("upstream-cache-key-name") {
		opts["upstream_cache_key_names"] = f.upstreamKeyNames
	}
	if f.regenKeypair {
		opts["keypair"] = map[string]string{"type": "generate"}
	}
	return opts
}

func cacheListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list [SERVER]",
		Short: "List caches visible to you on a server",
		Long: `Lists the caches the server lets you discover: public caches plus, when a
token is configured, any cache the token carries an explicit permission for.
Works without a token (public caches only).`,
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
			// Deliberately no requireToken: anonymous listing shows public
			// caches. The token rides along whenever one is configured.
			client := api.New(server.Endpoint, server.Token)
			caches, err := client.ListCaches(cmd.Context())
			if err != nil {
				return err
			}
			if len(caches) == 0 {
				fmt.Printf("No caches visible on %q.\n", serverName)
				return nil
			}
			fmt.Print(formatCacheList(caches))
			return nil
		},
	}
}

func formatCacheList(caches []api.CacheListEntry) string {
	var b strings.Builder
	w := tabwriter.NewWriter(&b, 2, 0, 2, ' ', 0)
	fmt.Fprintln(w, "NAME\tVISIBILITY\tPRIORITY\tCOMPRESSION\tRETENTION\tACCESS")
	for _, cache := range caches {
		visibility := "private"
		if cache.Public {
			visibility = "public"
		}
		fmt.Fprintf(
			w,
			"%s\t%s\t%d\t%s\t%s\t%s\n",
			cache.Name,
			visibility,
			cache.Priority,
			cache.Compression,
			retentionDesc(cache.RetentionPeriod, cache.RetentionMaxBytes),
			accessDesc(cache.Permissions),
		)
	}
	_ = w.Flush()
	return b.String()
}

// retentionDesc renders a cache's retention policy: an age budget in days
// and/or a compressed-size budget, or "none".
func retentionDesc(days, maxBytes *int64) string {
	var parts []string
	if days != nil {
		parts = append(parts, fmt.Sprintf("%dd", *days))
	}
	if maxBytes != nil {
		parts = append(parts, push.FormatBytes(*maxBytes))
	}
	if len(parts) == 0 {
		return "none"
	}
	return strings.Join(parts, ", ")
}

// accessDesc compacts a permission set into short verbs. configure implies
// the retention sub-permission, so "retention" appears only when it stands
// alone.
func accessDesc(p api.CachePermissions) string {
	var verbs []string
	if p.Pull {
		verbs = append(verbs, "pull")
	}
	if p.Push {
		verbs = append(verbs, "push")
	}
	if p.Delete {
		verbs = append(verbs, "delete")
	}
	if p.ConfigureCache {
		verbs = append(verbs, "configure")
	} else if p.ConfigureCacheRetention {
		verbs = append(verbs, "retention")
	}
	if p.DestroyCache {
		verbs = append(verbs, "destroy")
	}
	if len(verbs) == 0 {
		return "-"
	}
	return strings.Join(verbs, ",")
}

func cacheCreateCmd() *cobra.Command {
	flags := &cacheFlags{}
	cmd := &cobra.Command{
		Use:   "create [SERVER:]CACHE",
		Short: "Create a cache with a fresh signing keypair",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref, client, err := resolveCache(args[0])
			if err != nil {
				return err
			}
			publicKey, err := client.CreateCache(cmd.Context(), ref.Cache, flags.options(cmd))
			if err != nil {
				return err
			}
			fmt.Printf("✅ Created cache %q\n", ref.Cache)
			fmt.Printf("   public key %s\n", publicKey)
			fmt.Printf("   run `nimbus use %s` to pull from it\n", args[0])
			return nil
		},
	}
	flags.register(cmd, false)
	return cmd
}

func cacheInfoCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "info [SERVER:]CACHE",
		Short: "Show cache configuration",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref, client, err := resolveCache(args[0])
			if err != nil {
				return err
			}
			info, err := client.GetCacheInfo(cmd.Context(), ref.Cache)
			if err != nil {
				return err
			}
			visibility := "private"
			if info.IsPublic {
				visibility = "public"
			}
			fmt.Printf("%-13s %s\n", "Cache:", ref.Cache)
			fmt.Printf("%-13s %s\n", "Visibility:", visibility)
			fmt.Printf(
				"%-13s %s\n",
				"Substituter:",
				strings.TrimRight(info.SubstituterEndpoint, "/"),
			)
			fmt.Printf("%-13s %s\n", "Public key:", info.PublicKey)
			fmt.Printf("%-13s %s\n", "Store dir:", info.StoreDir)
			fmt.Printf("%-13s %d\n", "Priority:", info.Priority)
			fmt.Printf("%-13s %s\n", "Compression:", info.Compression)
			return nil
		},
	}
}

func cacheConfigureCmd() *cobra.Command {
	flags := &cacheFlags{}
	cmd := &cobra.Command{
		Use:   "configure [SERVER:]CACHE",
		Short: "Update cache settings",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref, client, err := resolveCache(args[0])
			if err != nil {
				return err
			}
			opts := flags.options(cmd)
			publicKey, err := client.ConfigureCache(cmd.Context(), ref.Cache, opts)
			if err != nil {
				return err
			}
			fmt.Printf("✅ Updated cache %q\n", ref.Cache)
			if publicKey != "" {
				fmt.Printf("   new public key %s\n", publicKey)
				fmt.Printf("   re-run `nimbus use %s` on machines that pull from it\n", args[0])
			}
			return nil
		},
	}
	flags.register(cmd, true)
	return cmd
}

func cacheDestroyCmd() *cobra.Command {
	var yes bool
	cmd := &cobra.Command{
		Use:   "destroy [SERVER:]CACHE",
		Short: "Delete a cache (paths become unreachable; storage is reclaimed by GC)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref, client, err := resolveCache(args[0])
			if err != nil {
				return err
			}
			if !yes {
				fmt.Printf("Type the cache name %q to confirm destruction: ", ref.Cache)
				line, err := bufio.NewReader(os.Stdin).ReadString('\n')
				if err != nil {
					return err
				}
				if strings.TrimSpace(line) != ref.Cache {
					return fmt.Errorf("confirmation did not match; aborting")
				}
			}
			if err := client.DestroyCache(cmd.Context(), ref.Cache); err != nil {
				return err
			}
			fmt.Printf("✅ Destroyed cache %q\n", ref.Cache)
			return nil
		},
	}
	cmd.Flags().BoolVar(&yes, "yes", false, "skip the confirmation prompt")
	return cmd
}

// pathHashArg accepts a full /nix/store path or a bare 32-character hash.
func pathHashArg(arg string) (string, error) {
	hash := arg
	if strings.HasPrefix(arg, "/") {
		hash = nix.HashPart(arg)
	}
	if len(hash) != 32 {
		return "", fmt.Errorf("expected a store path or 32-character path hash, got %q", arg)
	}
	return hash, nil
}

func cacheRmCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "rm [SERVER:]CACHE PATH_OR_HASH...",
		Short: "Remove store paths from a cache",
		Long: `Removes store paths from a cache, addressed by full /nix/store path or
32-character path hash. Requires a token with delete permission.

Removal is closure-safe on the server side: each named path stops anchoring
retention immediately, but dependencies shared with other paths stay until
their last dependent is removed.`,
		Args: cobra.MinimumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref, client, err := resolveCache(args[0])
			if err != nil {
				return err
			}
			if err := requireToken(ref); err != nil {
				return err
			}
			// Every path gets its attempt even after a failure, so one bad
			// argument doesn't strand the rest of a batch removal.
			failed := 0
			for _, arg := range args[1:] {
				hash, err := pathHashArg(arg)
				if err != nil {
					failed++
					fmt.Fprintf(os.Stderr, "❌ %s: %v\n", arg, err)
					continue
				}
				result, err := client.DestroyPath(cmd.Context(), ref.Cache, hash)
				if err != nil {
					failed++
					fmt.Fprintf(os.Stderr, "❌ %s: %v\n", hash, err)
					continue
				}
				fmt.Printf(
					"✅ Removed %s from %q (detached %d, reaped %d)\n",
					result.Destroyed, ref.Cache, result.Detached, result.Reaped,
				)
			}
			if failed > 0 {
				return fmt.Errorf("failed to remove %d of %d paths", failed, len(args)-1)
			}
			return nil
		},
	}
}

func cachePinCmd() *cobra.Command {
	var note string
	var keepRevisions, keepDays int
	cmd := &cobra.Command{
		Use:   "pin [SERVER:]CACHE [NAME] STORE_PATH_OR_HASH",
		Short: "Pin a path's closure against garbage collection",
		Long: `Pin a path's closure against garbage collection.

With a NAME (cachix-style), the pin keeps a revision history: re-pinning the
same name protects the new path while old revisions stay pinned too, bounded
by --keep-revisions / --keep-days (the current revision is never pruned).
Without a NAME, a plain single-path pin is created.`,
		Args: cobra.RangeArgs(2, 3),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref, client, err := resolveCache(args[0])
			if err != nil {
				return err
			}
			hash, err := pathHashArg(args[len(args)-1])
			if err != nil {
				return err
			}
			if len(args) == 3 {
				name := args[1]
				if err := client.PinNamed(
					cmd.Context(), ref.Cache, name, hash, keepRevisions, keepDays, note,
				); err != nil {
					return err
				}
				fmt.Printf("📌 Pinned %s as %q in %q\n", hash, name, ref.Cache)
				return nil
			}
			if err := client.PinPath(cmd.Context(), ref.Cache, hash, note); err != nil {
				return err
			}
			fmt.Printf("📌 Pinned %s in %q\n", hash, ref.Cache)
			return nil
		},
	}
	cmd.Flags().StringVar(&note, "note", "", "annotate why the path is pinned")
	cmd.Flags().
		IntVar(&keepRevisions, "keep-revisions", 0, "named pins: keep only the last N revisions")
	cmd.Flags().
		IntVar(&keepDays, "keep-days", 0, "named pins: prune revisions older than N days (current always kept)")
	return cmd
}

func cachePinsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "pins [SERVER:]CACHE",
		Short: "List garbage-collection pins and their revision histories",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref, client, err := resolveCache(args[0])
			if err != nil {
				return err
			}
			pins, err := client.ListPins(cmd.Context(), ref.Cache)
			if err != nil {
				return err
			}
			if len(pins) == 0 {
				fmt.Printf("No pins in cache %q.\n", ref.Cache)
				return nil
			}
			fmt.Print(formatPins(pins))
			return nil
		},
	}
}

// formatPins renders named pins as an aligned table plus, when the server
// reports them (entries without a name), anonymous quick pins.
func formatPins(pins []api.Pin) string {
	var named, anonymous []api.Pin
	for _, pin := range pins {
		if pin.Name == "" {
			anonymous = append(anonymous, pin)
		} else {
			named = append(named, pin)
		}
	}

	var b strings.Builder
	if len(named) > 0 {
		w := tabwriter.NewWriter(&b, 2, 0, 2, ' ', 0)
		fmt.Fprintln(w, "NAME\tCURRENT\tREVISIONS\tKEEP\tNOTE")
		for _, pin := range named {
			current, note := "-", ""
			if len(pin.Revisions) > 0 {
				current = pin.Revisions[0].Hash
				if pin.Revisions[0].Note != nil {
					note = *pin.Revisions[0].Note
				}
			}
			fmt.Fprintf(
				w,
				"%s\t%s\t%d\t%s\t%s\n",
				pin.Name, current, len(pin.Revisions), pinKeepDesc(pin), note,
			)
		}
		_ = w.Flush()
	}
	if len(anonymous) > 0 {
		if b.Len() > 0 {
			b.WriteString("\n")
		}
		b.WriteString("Anonymous pins:\n")
		for _, pin := range anonymous {
			for _, rev := range pin.Revisions {
				b.WriteString("  " + rev.Hash)
				if rev.Note != nil && *rev.Note != "" {
					b.WriteString("  # " + *rev.Note)
				}
				b.WriteString("\n")
			}
		}
	}
	return b.String()
}

func pinKeepDesc(pin api.Pin) string {
	var parts []string
	if pin.KeepRevisions != nil {
		parts = append(parts, fmt.Sprintf("%d revisions", *pin.KeepRevisions))
	}
	if pin.KeepDays != nil {
		parts = append(parts, fmt.Sprintf("%d days", *pin.KeepDays))
	}
	if len(parts) == 0 {
		return "-"
	}
	return strings.Join(parts, ", ")
}

func cacheUnpinCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "unpin [SERVER:]CACHE NAME_OR_PATH",
		Short: "Remove a garbage-collection pin (by pin name, store path, or hash)",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref, client, err := resolveCache(args[0])
			if err != nil {
				return err
			}
			// A valid store path / 32-char hash removes an anonymous pin;
			// anything else is treated as a pin name (with all its revisions).
			if hash, err := pathHashArg(args[1]); err == nil {
				if err := client.UnpinPath(cmd.Context(), ref.Cache, hash); err != nil {
					return err
				}
				fmt.Printf("✅ Unpinned %s in %q\n", hash, ref.Cache)
				return nil
			}
			if err := client.UnpinNamed(cmd.Context(), ref.Cache, args[1]); err != nil {
				return err
			}
			fmt.Printf("✅ Removed pin %q (all revisions) in %q\n", args[1], ref.Cache)
			return nil
		},
	}
}

func cacheRenameCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "rename [SERVER:]CACHE NEW_NAME",
		Short: "Rename a cache, keeping its signing keypair",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref, client, err := resolveCache(args[0])
			if err != nil {
				return err
			}
			if err := client.RenameCache(cmd.Context(), ref.Cache, args[1]); err != nil {
				return err
			}
			fmt.Printf("✅ Renamed cache %q to %q\n", ref.Cache, args[1])
			return nil
		},
	}
}
