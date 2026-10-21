package main

import (
	"context"
	"crypto/rand"
	"fmt"
	"io"

	"github.com/spf13/cobra"

	"github.com/kclejeune/nimbus/internal/api"
	"github.com/kclejeune/nimbus/internal/nix"
)

func purgeCmd() *cobra.Command {
	var apply bool
	cmd := &cobra.Command{
		Use:   "purge [SERVER:]CACHE",
		Short: "Plan removal of paths with confirmed missing closure dependencies",
		Long: `Shows cached paths and their dependents whose dependencies are confirmed
absent locally on the server and from every configured upstream. Unverified
dependencies are excluded. Pins and recent uploads protect their closures.
Planning is the default; --apply removes only the reviewed, still-broken paths.
Requires pull and delete permission. NAR/chunk storage is reclaimed by GC.
Upstream verification may refresh the server's verdict cache while planning.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref, client, err := resolveCache(args[0])
			if err != nil {
				return err
			}
			if err := requireToken(ref); err != nil {
				return err
			}
			return (closurePurger{client: client, cache: ref.Cache, out: cmd.OutOrStdout(), progress: cmd.ErrOrStderr()}).run(
				cmd.Context(),
				apply,
			)
		},
	}
	cmd.Flags().
		BoolVar(&apply, "apply", false, "remove the still-broken, unprotected paths in the plan")
	return cmd
}

type closurePurger struct {
	client        *api.Client
	cache         string
	out, progress io.Writer
}
type purgeGroup struct {
	hashes  []string
	targets []api.PurgeTarget
}

const maxPurgeTargets = 10_000

func (r closurePurger) planGroups(
	ctx context.Context,
	hashes []string,
	p *maintenanceProgress,
) ([]purgeGroup, error) {
	if len(hashes) == 0 {
		return nil, nil
	}
	group := purgeGroup{hashes: hashes}
	after := int64(0)
	eligibleCount := 0
	for {
		p.update(
			"Planning purge: %d dependencies, %d affected paths examined",
			len(hashes),
			len(group.targets),
		)
		page, err := r.client.PlanPurge(ctx, r.cache, hashes, after)
		if err != nil {
			return nil, err
		}
		for _, obj := range page.Objects {
			match := repairPath.FindStringSubmatch(obj.StorePath)
			if obj.ID <= 0 || obj.NarID <= 0 || match == nil || match[1] != obj.Hash ||
				obj.ID <= after ||
				(obj.Blocked != 0 && obj.Blocked != 1) {
				return nil, fmt.Errorf("server returned an invalid purge target")
			}
			group.targets = append(group.targets, obj)
			if obj.Blocked == 0 {
				eligibleCount++
			}
		}
		if eligibleCount > maxPurgeTargets {
			if len(hashes) == 1 {
				return nil, fmt.Errorf(
					"dependency %s affects more than %d paths; purge requires a smaller reviewed operation",
					hashes[0],
					maxPurgeTargets,
				)
			}
			left, err := r.planGroups(ctx, hashes[:len(hashes)/2], p)
			if err != nil {
				return nil, err
			}
			right, err := r.planGroups(ctx, hashes[len(hashes)/2:], p)
			return append(left, right...), err
		}
		if page.NextCursor == 0 {
			break
		}
		if page.NextCursor <= after {
			return nil, fmt.Errorf("server returned a non-advancing purge cursor")
		}
		after = page.NextCursor
	}
	return []purgeGroup{group}, nil
}

func (r closurePurger) run(ctx context.Context, apply bool) error {
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
	hashes := make([]string, len(missing))
	for i, path := range missing {
		hashes[i] = nix.HashPart(path)
	}
	var groups []purgeGroup
	for start := 0; start < len(hashes); start += 100 {
		planned, err := r.planGroups(ctx, hashes[start:min(start+100, len(hashes))], p)
		if err != nil {
			return err
		}
		groups = append(groups, planned...)
	}
	p.close()
	seen := make(map[int64]bool)
	removable, blocked := 0, 0
	fmt.Fprintf(
		r.out,
		"Purge plan: %d confirmed missing dependencies; %d unverified dependencies excluded.\n",
		len(missing),
		len(unverified),
	)
	for i := range groups {
		var eligible []api.PurgeTarget
		for _, obj := range groups[i].targets {
			if !seen[obj.ID] {
				label := "remove"
				if obj.Blocked != 0 {
					label = "protected"
					blocked++
				} else {
					removable++
				}
				fmt.Fprintf(r.out, "%s\t%s\n", label, obj.StorePath)
				seen[obj.ID] = true
			}
			if obj.Blocked == 0 {
				eligible = append(eligible, obj)
			}
		}
		groups[i].targets = eligible
	}
	fmt.Fprintf(
		r.out,
		"%d paths to remove; %d protected by pins or recent uploads.\n",
		removable,
		blocked,
	)
	if !apply {
		fmt.Fprintln(r.out, "Plan only. Pass --apply to remove these paths.")
		return nil
	}
	work := newMaintenanceProgress(progressOut)
	defer work.close()
	work.update("Retrying pending edge invalidations")
	pending, err := r.client.ReplayPathPurges(ctx, r.cache)
	if err != nil {
		return err
	}
	removed := 0
	totalGroups, completedGroups := 0, 0
	for _, group := range groups {
		if len(group.targets) > 0 {
			totalGroups++
		}
	}
	for _, group := range groups {
		if len(group.targets) == 0 {
			continue
		}
		work.counted(
			completedGroups,
			totalGroups,
			"Applying purge group %d/%d (%d reviewed paths; %d removed)",
			completedGroups+1,
			totalGroups,
			len(group.targets),
			removed,
		)
		var raw [16]byte
		if _, err := rand.Read(raw[:]); err != nil {
			return err
		}
		id := fmt.Sprintf("%x-%x-%x-%x-%x", raw[:4], raw[4:6], raw[6:8], raw[8:10], raw[10:])
		result, err := r.client.ApplyPurge(ctx, r.cache, id, group.hashes, group.targets)
		if err != nil {
			return err
		}
		removed += result.Removed
		completedGroups++
		work.counted(
			completedGroups,
			totalGroups,
			"Applied purge group %d/%d (%d paths removed)",
			completedGroups,
			totalGroups,
			removed,
		)
		if result.PendingPurge {
			pending++
		}
	}
	work.close()
	fmt.Fprintf(
		r.out,
		"Purge applied: %d paths removed; %d reviewed paths retained or changed. Shared NARs and chunks are reclaimed by GC.\n",
		removed,
		max(0, removable-removed),
	)
	if pending > 0 {
		fmt.Fprintf(
			r.out,
			"%d edge invalidation operations are durably queued and continue automatically.\n",
			pending,
		)
	}
	return nil
}
