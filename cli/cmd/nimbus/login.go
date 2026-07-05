package main

import (
	"fmt"
	"time"

	"github.com/spf13/cobra"

	"github.com/kclejeune/nimbus/cli/internal/api"
	"github.com/kclejeune/nimbus/cli/internal/config"
)

func loginCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "login NAME ENDPOINT [TOKEN]",
		Short: "Configure a server, authenticating via browser if no token is given",
		Args:  cobra.RangeArgs(2, 3),
		RunE: func(cmd *cobra.Command, args []string) error {
			name, endpoint := args[0], args[1]

			var token string
			if len(args) == 3 {
				token = args[2]
			} else {
				var err error
				if token, err = deviceLogin(cmd, endpoint); err != nil {
					return err
				}
			}

			cfg, err := loadConfig()
			if err != nil {
				return err
			}
			cfg.Servers[name] = config.Server{Endpoint: endpoint, Token: token}
			if cfg.DefaultServer == "" {
				cfg.DefaultServer = name
			}
			if err := cfg.Save(cfgFile); err != nil {
				return err
			}

			fmt.Printf("✅ Logged in to %q (%s)\n", name, endpoint)
			return nil
		},
	}
	return cmd
}

// deviceLogin runs the RFC 8628 device-authorization flow: the user approves
// the grant in a browser on the admin app while the CLI polls for the token.
func deviceLogin(cmd *cobra.Command, endpoint string) (string, error) {
	client := api.New(endpoint, "")
	grant, err := client.StartDeviceAuth(cmd.Context())
	if err != nil {
		return "", fmt.Errorf("starting device authorization: %w", err)
	}

	fmt.Printf("To authorize this device, visit:\n\n    %s\n\nand confirm the code %s\n\n",
		grant.VerificationURIComplete, grant.UserCode)

	interval := time.Duration(max(grant.Interval, 1)) * time.Second
	deadline := time.Now().Add(time.Duration(grant.ExpiresIn) * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-cmd.Context().Done():
			return "", cmd.Context().Err()
		case <-time.After(interval):
		}
		token, err := client.PollDeviceToken(cmd.Context(), grant.DeviceCode)
		if err != nil {
			return "", err
		}
		if token != "" {
			return token, nil
		}
	}
	return "", fmt.Errorf("device authorization timed out")
}
