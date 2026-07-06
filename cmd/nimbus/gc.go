package main

import (
	"encoding/json"
	"fmt"

	"github.com/spf13/cobra"

	"github.com/kclejeune/nimbus/internal/api"
)

func gcCmd() *cobra.Command {
	var dryRun bool
	cmd := &cobra.Command{
		Use:   "gc [SERVER]",
		Short: "Trigger server-side garbage collection",
		Long: `Runs a GC pass on the server (retention, size budgets, orphan cleanup).
Requires a token with delete permission.`,
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
			client := api.New(server.Endpoint, server.Token)
			stats, err := client.RunGc(cmd.Context(), dryRun)
			if err != nil {
				return err
			}
			if dryRun {
				fmt.Printf("🧹 GC dry run on %q:\n", serverName)
			} else {
				fmt.Printf("🧹 GC complete on %q:\n", serverName)
			}
			pretty, err := json.MarshalIndent(stats, "", "  ")
			if err != nil {
				return err
			}
			fmt.Println(string(pretty))
			return nil
		},
	}
	cmd.Flags().
		BoolVar(&dryRun, "dry-run", false, "report what retention would delete without deleting")
	return cmd
}
