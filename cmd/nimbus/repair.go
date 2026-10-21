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
	var apply, dryRun bool
	var jobs int
	cmd := &cobra.Command{
		Use:   "repair [SERVER:]CACHE",
		Short: "Restore missing closure dependencies from the local Nix store",
		Long: `Finds unresolved references recorded by server GC, rechecks their upstream
coverage, and pushes missing dependencies and their closures from this machine.
Requires pull and push permission. Run it on machines that built the affected
paths; unavailable dependencies are listed and cause a nonzero exit status.
Planning is the default. --apply uploads the locally available dependencies.
It does not build, download, or delete paths. Upstream verification can refresh
the server's verdict cache even while planning. Unanswered upstream probes are
reported separately from confirmed missing dependencies.
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
				client:   client,
				cache:    ref.Cache,
				out:      cmd.OutOrStdout(),
				progress: cmd.ErrOrStderr(),
				local:    nix.SplitValid,
				push:     pusher.Push,
			}
			return r.run(cmd.Context(), !apply)
		},
	}
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "list missing dependencies without uploading")
	cmd.Flags().
		BoolVar(&apply, "apply", false, "upload the locally available dependencies in the plan")
	cmd.MarkFlagsMutuallyExclusive("apply", "dry-run")
	_ = cmd.Flags().MarkDeprecated("dry-run", "planning is now the default; use --apply to upload")
	cmd.Flags().IntVarP(&jobs, "jobs", "j", 5, "parallel upload jobs")
	return cmd
}

type closureRepair struct {
	client   *api.Client
	cache    string
	out      io.Writer
	progress io.Writer
	local    func(context.Context, []string) ([]string, []string, error)
	push     func(context.Context, []string) error
}

const repairBatchSize = 100

var repairPath = regexp.MustCompile(
	`^/nix/store/([0123456789abcdfghijklmnpqrsvwxyz]{32})-[A-Za-z0-9+._?=-]+$`,
)

func (r closureRepair) run(ctx context.Context, dryRun bool) error {
	progressOut := r.progress
	if progressOut == nil {
		progressOut = r.out
	}
	p := newMaintenanceProgress(progressOut)
	defer p.close()
	missing, unverified, err := scanReferences(ctx, r.client, r.cache, p)
	if err != nil {
		return err
	}
	paths := append(append([]string{}, missing...), unverified...)
	unknown := make(map[string]bool, len(unverified))
	for _, path := range unverified {
		unknown[path] = true
	}
	if len(paths) == 0 {
		p.close()
		fmt.Fprintln(r.out, "No uncovered dependencies in the GC reference graph.")
		return nil
	}
	var available, unavailable []string
	// Bound nix-store argv size even for a large repair backlog.
	for start := 0; start < len(paths); start += repairBatchSize {
		p.counted(
			start,
			len(paths),
			"Checking local store: %d/%d dependencies",
			start,
			len(paths),
		)
		valid, invalid, err := r.local(ctx, paths[start:min(start+repairBatchSize, len(paths))])
		if err != nil {
			return err
		}
		available = append(available, valid...)
		unavailable = append(unavailable, invalid...)
		p.counted(
			min(start+repairBatchSize, len(paths)),
			len(paths),
			"Checked local store: %d/%d dependencies",
			min(start+repairBatchSize, len(paths)),
			len(paths),
		)
	}
	p.close()
	fmt.Fprintf(
		r.out,
		"Repair plan: %d confirmed missing, %d unverified; %d available locally.\n",
		len(missing),
		len(unverified),
		len(available),
	)
	for _, path := range available {
		fmt.Fprintf(r.out, "upload\t%s\n", path)
	}
	confirmedUnavailable := 0
	for _, path := range unavailable {
		label := "unavailable"
		if unknown[path] {
			label = "unverified"
		} else {
			confirmedUnavailable++
		}
		fmt.Fprintf(r.out, "%s\t%s\n", label, path)
	}
	if dryRun {
		fmt.Fprintln(r.out, "Plan only. Pass --apply to upload the available dependencies.")
		return nil
	}
	for start := 0; start < len(available); start += repairBatchSize {
		batch := available[start:min(start+repairBatchSize, len(available))]
		fmt.Fprintf(
			progressOut,
			"Uploading repair batch %d/%d (%d/%d dependencies)\n",
			start/repairBatchSize+1,
			(len(available)+repairBatchSize-1)/repairBatchSize,
			min(start+repairBatchSize, len(available)),
			len(available),
		)
		if err := r.push(ctx, batch); err != nil {
			return err
		}
	}
	unknownUnavailable := len(unavailable) - confirmedUnavailable
	fmt.Fprintf(
		r.out,
		"Repair applied: %d dependencies submitted; %d confirmed missing dependencies unavailable locally; %d unavailable locally with unverified upstream coverage.\n",
		len(available),
		confirmedUnavailable,
		unknownUnavailable,
	)
	if len(unavailable) > 0 {
		return fmt.Errorf(
			"repair incomplete: %d dependencies unavailable locally (confirmed missing); %d still unverified; try another build machine or rerun verification",
			confirmedUnavailable,
			unknownUnavailable,
		)
	}
	fmt.Fprintln(r.out, "The dashboard refreshes after the next GC run.")
	return nil
}

func scanReferences(
	ctx context.Context,
	client *api.Client,
	cache string,
	p *maintenanceProgress,
) (missingPaths, unverifiedPaths []string, err error) {
	after := ""
	pages, examined := 0, 0
	for {
		p.update("Reading reference page %d (%d dependencies examined)", pages+1, examined)
		page, err := client.UncoveredReferences(ctx, cache, after)
		if err != nil {
			return nil, nil, fmt.Errorf(
				"reading closure references (requires a Worker with cache-integrity support): %w",
				err,
			)
		}
		hashes := make([]string, 0, len(page.References))
		byHash := make(map[string]string, len(page.References))
		for _, ref := range page.References {
			match := repairPath.FindStringSubmatch(ref.StorePath)
			if match == nil || match[1] != ref.Hash {
				return nil, nil, fmt.Errorf("server returned invalid dependency %q", ref.StorePath)
			}
			hashes = append(hashes, ref.Hash)
			byHash[ref.Hash] = ref.StorePath
		}
		p.update("Verifying upstream coverage: page %d, %d dependencies", pages+1, len(hashes))
		status, err := client.CheckReferences(ctx, cache, hashes)
		if err != nil {
			return nil, nil, fmt.Errorf(
				"verifying reference coverage (requires a Worker with maintenance support): %w",
				err,
			)
		}
		for _, hash := range status.Missing {
			if path, ok := byHash[hash]; ok {
				missingPaths = append(missingPaths, path)
			}
		}
		for _, hash := range status.Unverified {
			if path, ok := byHash[hash]; ok {
				unverifiedPaths = append(unverifiedPaths, path)
			}
		}
		pages++
		examined += len(hashes)
		if page.NextCursor == "" {
			break
		}
		if page.NextCursor <= after || len(page.NextCursor) != 32 {
			return nil, nil, fmt.Errorf("server returned a non-advancing reference cursor")
		}
		after = page.NextCursor
	}
	return missingPaths, unverifiedPaths, nil
}
