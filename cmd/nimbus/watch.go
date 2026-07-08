package main

import (
	"context"
	"fmt"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
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
			if err := requireToken(ref); err != nil {
				return err
			}
			pusher := &push.Pusher{
				Client: client,
				Cache:  ref.Cache,
				Jobs:   jobs,
				Out:    os.Stdout,
				// Unfinished builds and GC casualties are routine while watching;
				// skipping them must not fail the run.
				SkipInvalid: true,
			}
			fmt.Printf("👀 Watching %s; pushing new paths to %q\n", nix.StoreDir, ref.Cache)
			return watchAndPush(cmd.Context(), pusher, nil, false, nil)
		},
	}

	cmd.Flags().IntVarP(&jobs, "jobs", "j", 5, "parallel upload jobs")
	return cmd
}

func watchExecCmd() *cobra.Command {
	var jobs int
	var batch bool

	cmd := &cobra.Command{
		Use:   "watch-exec [SERVER:]CACHE COMMAND [ARGS...]",
		Short: "Run a command, pushing new store paths as they appear",
		Long: `Runs COMMAND while watching the Nix store, collecting new paths and pushing
them to the cache in one shot after it exits (even when COMMAND fails),
deduplicating the closure and the already-present check across the whole run.

With --batch=false, paths are instead pushed individually as they settle
while COMMAND is still running.`,
		Args: cobra.MinimumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref, client, err := resolveCache(args[0])
			if err != nil {
				return err
			}
			if err := requireToken(ref); err != nil {
				return err
			}
			pusher := &push.Pusher{
				Client: client,
				Cache:  ref.Cache,
				Jobs:   jobs,
				Out:    os.Stdout,
				// Unfinished builds and GC casualties are routine while watching;
				// skipping them must not fail the run.
				SkipInvalid: true,
			}
			if batch {
				fmt.Printf("👀 Watching %s; will push new paths to %q after the command exits\n",
					nix.StoreDir, ref.Cache)
			} else {
				fmt.Printf("👀 Watching %s; pushing new paths to %q\n", nix.StoreDir, ref.Cache)
			}

			stop := make(chan struct{})
			done := make(chan error, 1)
			ready := make(chan struct{})
			go func() { done <- watchAndPush(cmd.Context(), pusher, stop, batch, ready) }()

			// Paths created before the watcher is in place are invisible to
			// it, so don't start the command until then.
			select {
			case <-ready:
			case err := <-done:
				return err
			}

			child := exec.CommandContext(cmd.Context(), args[1], args[2:]...)
			child.Stdin = os.Stdin
			child.Stdout = os.Stdout
			child.Stderr = os.Stderr
			runErr := child.Run()

			// Give fsnotify one debounce window to deliver events for the
			// command's final store writes, then flush.
			time.Sleep(watchDebounce)
			close(stop)
			if err := <-done; err != nil {
				if runErr == nil {
					return err
				}
				// The command's failure wins the exit code, but a failed
				// flush must not vanish with it.
				fmt.Fprintf(os.Stderr, "push: %v\n", err)
			}
			return runErr
		},
	}

	cmd.Flags().IntVarP(&jobs, "jobs", "j", 5, "parallel upload jobs")
	cmd.Flags().
		BoolVar(&batch, "batch", true, "push everything in one shot after the command exits (--batch=false streams pushes)")
	// Stop flag parsing at the first positional so COMMAND's own flags (e.g.
	// `sh -c`) aren't claimed by watch-exec.
	cmd.Flags().SetInterspersed(false)
	return cmd
}

// watchAndPush pushes new store paths as they settle until stop closes (any
// still-pending paths are flushed) or ctx is cancelled. With batch, settled
// paths only accumulate and the stop flush pushes them as a single batch.
// ready (if non-nil) is closed once new store paths are guaranteed visible.
func watchAndPush(
	ctx context.Context,
	pusher *push.Pusher,
	stop <-chan struct{},
	batch bool,
	ready chan<- struct{},
) error {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	defer func() { _ = watcher.Close() }()
	if err := watcher.Add(nix.StoreDir); err != nil {
		// kqueue (macOS) watches a directory by opening every entry in it and
		// fails on unopenable ones (e.g. sockets in the store); fall back to
		// diffing directory listings.
		fmt.Fprintf(os.Stderr, "watch %s: %v; falling back to polling\n", nix.StoreDir, err)
		return pollAndPush(ctx, pusher, stop, batch, ready)
	}
	if ready != nil {
		close(ready)
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
			return flushPending(ctx, pusher, pending, batch)
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
			if batch {
				continue
			}
			pushSettled(ctx, pusher, pending)
		}
	}
}

// pollAndPush is the fallback watcher for stores fsnotify cannot handle:
// it diffs directory listings on the debounce tick. New entries are complete
// when first seen (store paths appear via rename), so the same debounce
// covers the registration lag.
func pollAndPush(
	ctx context.Context,
	pusher *push.Pusher,
	stop <-chan struct{},
	batch bool,
	ready chan<- struct{},
) error {
	names, err := storeNames()
	if err != nil {
		return err
	}
	known := make(map[string]struct{}, len(names))
	for _, name := range names {
		known[name] = struct{}{}
	}
	if ready != nil {
		close(ready)
	}

	pending := map[string]time.Time{}
	scan := func() {
		names, err := storeNames()
		if err != nil {
			fmt.Fprintf(os.Stderr, "watch error: %v\n", err)
			return
		}
		for _, name := range names {
			if _, seen := known[name]; seen {
				continue
			}
			known[name] = struct{}{}
			if !ignoredStoreName(name) {
				pending[filepath.Join(nix.StoreDir, name)] = time.Now()
			}
		}
	}

	ticker := time.NewTicker(watchDebounce)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-stop:
			scan()
			return flushPending(ctx, pusher, pending, batch)
		case <-ticker.C:
			scan()
			if batch {
				continue
			}
			pushSettled(ctx, pusher, pending)
		}
	}
}

// storeNames lists the store directory, skipping the sort and stat work of
// os.ReadDir — the store can hold hundreds of thousands of entries and this
// runs every tick.
func storeNames() ([]string, error) {
	dir, err := os.Open(nix.StoreDir)
	if err != nil {
		return nil, err
	}
	defer func() { _ = dir.Close() }()
	return dir.Readdirnames(-1)
}

// pushSettled pushes all paths past the debounce window as one batch (Push
// dedupes the closure union and skips paths that never registered), printing
// failures without stopping the watch.
func pushSettled(ctx context.Context, pusher *push.Pusher, pending map[string]time.Time) {
	var due []string
	for path, seen := range pending {
		if time.Since(seen) < watchDebounce {
			continue
		}
		delete(pending, path)
		due = append(due, path)
	}
	if len(due) == 0 {
		return
	}
	slices.Sort(due)
	if err := pusher.Push(ctx, due); err != nil {
		fmt.Fprintf(os.Stderr, "push: %v\n", err)
	}
}

// flushPending pushes everything still pending in one shot. In batch mode the
// error is returned (it decides watch-exec's exit code); in streaming mode it
// is printed like any other push failure, keeping the flush non-fatal.
func flushPending(
	ctx context.Context,
	pusher *push.Pusher,
	pending map[string]time.Time,
	batch bool,
) error {
	if len(pending) == 0 {
		return nil
	}
	err := pusher.Push(ctx, slices.Sorted(maps.Keys(pending)))
	if err != nil && !batch {
		fmt.Fprintf(os.Stderr, "push: %v\n", err)
		return nil
	}
	return err
}

// storeNameRE is nix's base32 hash prefix; anything else in the store
// directory (tmp-* build dirs, .links, lock files) is not a store path and
// would make `nix-store --check-validity` fail the whole flush batch.
var storeNameRE = regexp.MustCompile(`^[0-9a-df-np-sv-z]{32}-`)

func ignoredStoreName(name string) bool {
	return !storeNameRE.MatchString(name) ||
		strings.HasSuffix(name, ".drv") ||
		strings.HasSuffix(name, ".lock") ||
		strings.Contains(name, ".tmp")
}
