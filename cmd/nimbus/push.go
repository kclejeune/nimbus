package main

import (
	"bufio"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/kclejeune/nimbus/internal/push"
)

func pushCmd() *cobra.Command {
	var jobs int
	var stdin bool
	var skipInvalid bool

	cmd := &cobra.Command{
		Use:   "push [SERVER:]CACHE [PATHS...]",
		Short: "Push store path closures to a cache",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref, client, err := resolveCache(args[0])
			if err != nil {
				return err
			}
			if err := requireToken(ref); err != nil {
				return err
			}

			paths := args[1:]
			if stdin {
				scanner := bufio.NewScanner(os.Stdin)
				for scanner.Scan() {
					if line := scanner.Text(); line != "" {
						paths = append(paths, line)
					}
				}
				if err := scanner.Err(); err != nil {
					return err
				}
			}
			if len(paths) == 0 {
				return fmt.Errorf("no paths to push; pass store paths or use --stdin")
			}

			pusher := &push.Pusher{
				Client:      client,
				Cache:       ref.Cache,
				Jobs:        jobs,
				Out:         os.Stdout,
				SkipInvalid: skipInvalid,
			}
			return pusher.Push(cmd.Context(), paths)
		},
	}

	cmd.Flags().IntVarP(&jobs, "jobs", "j", 5, "parallel upload jobs")
	cmd.Flags().BoolVar(&stdin, "stdin", false, "read paths from stdin, one per line")
	cmd.Flags().BoolVar(&skipInvalid, "skip-invalid", false,
		"exit 0 even when paths not valid in the local store were skipped")
	return cmd
}
