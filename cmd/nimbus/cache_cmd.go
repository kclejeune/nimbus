package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/kclejeune/nimbus/internal/nix"
)

func cacheCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "cache",
		Short: "Manage caches on a server",
	}
	cmd.AddCommand(cacheCreateCmd())
	cmd.AddCommand(cacheInfoCmd())
	cmd.AddCommand(cacheConfigureCmd())
	cmd.AddCommand(cacheDestroyCmd())
	cmd.AddCommand(cacheRenameCmd())
	cmd.AddCommand(cachePinCmd())
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

func cachePinCmd() *cobra.Command {
	var note string
	cmd := &cobra.Command{
		Use:   "pin [SERVER:]CACHE STORE_PATH_OR_HASH",
		Short: "Pin a path's closure against garbage collection",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref, client, err := resolveCache(args[0])
			if err != nil {
				return err
			}
			hash, err := pathHashArg(args[1])
			if err != nil {
				return err
			}
			if err := client.PinPath(cmd.Context(), ref.Cache, hash, note); err != nil {
				return err
			}
			fmt.Printf("📌 Pinned %s in %q\n", hash, ref.Cache)
			return nil
		},
	}
	cmd.Flags().StringVar(&note, "note", "", "annotate why the path is pinned")
	return cmd
}

func cacheUnpinCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "unpin [SERVER:]CACHE STORE_PATH_OR_HASH",
		Short: "Remove a garbage-collection pin",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref, client, err := resolveCache(args[0])
			if err != nil {
				return err
			}
			hash, err := pathHashArg(args[1])
			if err != nil {
				return err
			}
			if err := client.UnpinPath(cmd.Context(), ref.Cache, hash); err != nil {
				return err
			}
			fmt.Printf("✅ Unpinned %s in %q\n", hash, ref.Cache)
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
