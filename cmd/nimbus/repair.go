package main

import (
	"context"
	"fmt"
	"io"
	"regexp"

	"github.com/spf13/cobra"

	"github.com/kclejeune/nimbus/internal/api"
	"github.com/kclejeune/nimbus/internal/nix"
)

func repairCmd() *cobra.Command {
	var dryRun bool
	var jobs int
	cmd := &cobra.Command{
		Use:   "repair [SERVER:]CACHE",
		Short: "Restore missing closure dependencies from the local Nix store",
		Long: `Finds unresolved references recorded by server GC, rechecks their upstream
coverage, and pushes missing dependencies and their closures from this machine.
Requires pull and push permission. Run it on machines that built the affected
paths; unavailable dependencies are listed and cause a nonzero exit status.
It does not build, download, or delete paths. --dry-run lists the repair plan
without uploading (upstream checks may refresh the server's verdict cache).
The dashboard warning refreshes on the next GC run.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if jobs < 1 {
				return fmt.Errorf("--jobs must be at least 1")
			}
			ref, client, err := resolveCache(args[0])
			if err != nil {
				return err
			}
			if err := requireToken(ref); err != nil {
				return err
			}
			pusher := newPusher(client, ref.Cache, jobs)
			r := closureRepair{
				client: client, cache: ref.Cache, out: cmd.OutOrStdout(),
				local: nix.SplitValid, push: pusher.Push,
			}
			return r.run(cmd.Context(), dryRun)
		},
	}
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "list missing dependencies without uploading")
	cmd.Flags().IntVarP(&jobs, "jobs", "j", 5, "parallel upload jobs")
	return cmd
}

type closureRepair struct {
	client *api.Client
	cache  string
	out    io.Writer
	local  func(context.Context, []string) ([]string, []string, error)
	push   func(context.Context, []string) error
}

const repairBatchSize = 100

var repairPath = regexp.MustCompile(
	`^/nix/store/([0123456789abcdfghijklmnpqrsvwxyz]{32})-[A-Za-z0-9+._?=-]+$`,
)

func (r closureRepair) run(ctx context.Context, dryRun bool) error {
	fmt.Fprintf(r.out, "Checking unresolved references in %q (recorded by GC)...\n", r.cache)
	var paths []string
	after := ""
	// Read every page before uploading: new paths must not shift pagination.
	for {
		page, err := r.client.UncoveredReferences(ctx, r.cache, after)
		if err != nil {
			return fmt.Errorf(
				"reading closure references (requires a Worker with cache-integrity support): %w",
				err,
			)
		}
		hashes := make([]string, 0, len(page.References))
		byHash := make(map[string]string, len(page.References))
		for _, ref := range page.References {
			match := repairPath.FindStringSubmatch(ref.StorePath)
			if match == nil || match[1] != ref.Hash {
				return fmt.Errorf("server returned invalid dependency %q", ref.StorePath)
			}
			hashes = append(hashes, ref.Hash)
			byHash[ref.Hash] = ref.StorePath
		}
		missing, err := r.client.GetMissingPaths(ctx, r.cache, hashes, false)
		if err != nil {
			return fmt.Errorf("rechecking reference coverage: %w", err)
		}
		for _, hash := range missing {
			if path, ok := byHash[hash]; ok {
				paths = append(paths, path)
			}
		}
		if page.NextCursor == "" {
			break
		}
		if page.NextCursor <= after || len(page.NextCursor) != 32 {
			return fmt.Errorf("server returned a non-advancing reference cursor")
		}
		after = page.NextCursor
	}
	if len(paths) == 0 {
		fmt.Fprintln(
			r.out,
			"No uncovered dependencies in the GC reference graph. The dashboard refreshes after the next GC run.",
		)
		return nil
	}
	var available, unavailable []string
	// Bound nix-store argv size even for a large repair backlog.
	for start := 0; start < len(paths); start += repairBatchSize {
		valid, invalid, err := r.local(ctx, paths[start:min(start+repairBatchSize, len(paths))])
		if err != nil {
			return err
		}
		available = append(available, valid...)
		unavailable = append(unavailable, invalid...)
	}
	fmt.Fprintf(r.out, "%d dependencies still uncovered: %d available locally, %d unavailable.\n",
		len(paths), len(available), len(unavailable))
	for _, path := range available {
		fmt.Fprintf(r.out, "upload\t%s\n", path)
	}
	for _, path := range unavailable {
		fmt.Fprintf(r.out, "unavailable\t%s\n", path)
	}
	if dryRun {
		return nil
	}
	if len(available) > 0 {
		// Push revalidates its inputs and queries their closures via Nix.
		// Keep those subprocess argument lists bounded as well.
		for start := 0; start < len(available); start += repairBatchSize {
			batch := available[start:min(start+repairBatchSize, len(available))]
			if err := r.push(ctx, batch); err != nil {
				return err
			}
		}
		fmt.Fprintln(r.out, "Repair push complete. The dashboard refreshes after the next GC run.")
	}
	if len(unavailable) > 0 {
		return fmt.Errorf(
			"%d dependencies unavailable locally; run repair on a machine that still has them, or rebuild their original outputs and push those closures",
			len(unavailable),
		)
	}
	return nil
}
