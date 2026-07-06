package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/spf13/cobra"

	"github.com/kclejeune/nimbus/internal/nix"
	"github.com/kclejeune/nimbus/internal/push"
)

// Store paths appear atomically via rename, but registration in the Nix
// database lags; debounce and let path-info decide validity.
const watchDebounce = 2 * time.Second

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
			fmt.Printf("👀 Watching %s; pushing new paths to %q\n", nix.StoreDir, ref.Cache)
			return watchAndPush(cmd.Context(), pusher, nil)
		},
	}

	cmd.Flags().IntVarP(&jobs, "jobs", "j", 5, "parallel upload jobs")
	return cmd
}

func watchExecCmd() *cobra.Command {
	var jobs int

	cmd := &cobra.Command{
		Use:   "watch-exec [SERVER:]CACHE COMMAND [ARGS...]",
		Short: "Run a command, pushing new store paths as they appear",
		Long: `Runs COMMAND while watching the Nix store, pushing new paths to the cache
as they settle. Paths still pending when the command exits are flushed
before returning.`,
		Args: cobra.MinimumNArgs(2),
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
			fmt.Printf("👀 Watching %s; pushing new paths to %q\n", nix.StoreDir, ref.Cache)

			stop := make(chan struct{})
			done := make(chan error, 1)
			go func() { done <- watchAndPush(cmd.Context(), pusher, stop) }()

			child := exec.CommandContext(cmd.Context(), args[1], args[2:]...)
			child.Stdin = os.Stdin
			child.Stdout = os.Stdout
			child.Stderr = os.Stderr
			runErr := child.Run()

			// Give fsnotify one debounce window to deliver events for the
			// command's final store writes, then flush.
			time.Sleep(watchDebounce)
			close(stop)
			if err := <-done; err != nil && runErr == nil {
				return err
			}
			return runErr
		},
	}

	cmd.Flags().IntVarP(&jobs, "jobs", "j", 5, "parallel upload jobs")
	return cmd
}

// watchAndPush pushes new store paths as they settle until stop closes (any
// still-pending paths are flushed) or ctx is cancelled.
func watchAndPush(ctx context.Context, pusher *push.Pusher, stop <-chan struct{}) error {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	defer func() { _ = watcher.Close() }()
	if err := watcher.Add(nix.StoreDir); err != nil {
		return err
	}

	pending := map[string]time.Time{}
	record := func(event fsnotify.Event) {
		if !event.Has(fsnotify.Create) {
			return
		}
		path := event.Name
		if filepath.Dir(path) != nix.StoreDir || ignoredStoreName(filepath.Base(path)) {
			return
		}
		pending[path] = time.Now()
	}

	ticker := time.NewTicker(watchDebounce)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-stop:
			// Drain any queued events, then flush everything pending.
			for {
				select {
				case event := <-watcher.Events:
					record(event)
					continue
				default:
				}
				break
			}
			for path := range pending {
				pushIfValid(ctx, pusher, path)
			}
			return nil
		case event, ok := <-watcher.Events:
			if !ok {
				return nil
			}
			record(event)
		case err, ok := <-watcher.Errors:
			if !ok {
				return nil
			}
			fmt.Fprintf(os.Stderr, "watch error: %v\n", err)
		case <-ticker.C:
			for path, seen := range pending {
				if time.Since(seen) < watchDebounce {
					continue
				}
				delete(pending, path)
				pushIfValid(ctx, pusher, path)
			}
		}
	}
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
