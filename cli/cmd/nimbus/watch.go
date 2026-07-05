package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/spf13/cobra"

	"github.com/kclejeune/nimbus/cli/internal/nix"
	"github.com/kclejeune/nimbus/cli/internal/push"
)

func watchStoreCmd() *cobra.Command {
	var jobs int

	cmd := &cobra.Command{
		Use:   "watch-store [SERVER:]CACHE",
		Short: "Watch the Nix store and push new paths as they appear",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref, client, err := resolveCache(args[0])
			if err != nil {
				return err
			}
			pusher := &push.Pusher{
				Client: client,
				Cache:  ref.Cache,
				Jobs:   jobs,
				Out:    os.Stdout,
			}

			watcher, err := fsnotify.NewWatcher()
			if err != nil {
				return err
			}
			defer func() { _ = watcher.Close() }()
			if err := watcher.Add(nix.StoreDir); err != nil {
				return err
			}
			fmt.Printf("👀 Watching %s; pushing new paths to %q\n", nix.StoreDir, ref.Cache)

			// Store paths appear atomically via rename, but registration in the
			// Nix database lags; debounce and let path-info decide validity.
			pending := map[string]time.Time{}
			ticker := time.NewTicker(2 * time.Second)
			defer ticker.Stop()

			for {
				select {
				case <-cmd.Context().Done():
					return nil
				case event, ok := <-watcher.Events:
					if !ok {
						return nil
					}
					if !event.Has(fsnotify.Create) {
						continue
					}
					path := event.Name
					if filepath.Dir(path) != nix.StoreDir || ignoredStoreName(filepath.Base(path)) {
						continue
					}
					pending[path] = time.Now()
				case err, ok := <-watcher.Errors:
					if !ok {
						return nil
					}
					fmt.Fprintf(os.Stderr, "watch error: %v\n", err)
				case <-ticker.C:
					for path, seen := range pending {
						if time.Since(seen) < 2*time.Second {
							continue
						}
						delete(pending, path)
						pushIfValid(cmd.Context(), pusher, path)
					}
				}
			}
		},
	}

	cmd.Flags().IntVarP(&jobs, "jobs", "j", 5, "parallel upload jobs")
	return cmd
}

func ignoredStoreName(name string) bool {
	return strings.HasPrefix(name, ".") ||
		strings.HasSuffix(name, ".drv") ||
		strings.HasSuffix(name, ".lock") ||
		strings.Contains(name, ".tmp")
}

// pushIfValid pushes a path if it registered as valid; unfinished builds and
// GC casualties are silently skipped.
func pushIfValid(ctx context.Context, pusher *push.Pusher, path string) {
	if _, err := nix.PathInfoFor(ctx, []string{path}); err != nil {
		return
	}
	if err := pusher.Push(ctx, []string{path}); err != nil {
		fmt.Fprintf(os.Stderr, "push %s: %v\n", filepath.Base(path), err)
	}
}
