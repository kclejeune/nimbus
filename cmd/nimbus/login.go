package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"time"

	"github.com/spf13/cobra"

	"github.com/kclejeune/nimbus/internal/api"
	"github.com/kclejeune/nimbus/internal/config"
)

func loginCmd() *cobra.Command {
	var web, device, setDefault bool

	cmd := &cobra.Command{
		Use:   "login NAME ENDPOINT [TOKEN]",
		Short: "Configure a server, authenticating interactively if no token is given",
		Long: `Saves a server under NAME. With a TOKEN argument it is stored as-is;
otherwise nimbus authenticates interactively — via the browser when one is
available (local graphical session), or the device-code flow when not
(SSH, headless). Force a flow with --web or --device.

The first configured server becomes the default; --set-default makes this
one the default even when others already exist.`,
		Args: cobra.RangeArgs(2, 3),
		RunE: func(cmd *cobra.Command, args []string) error {
			name := args[0]
			endpoint, err := config.NormalizeEndpoint(args[1])
			if err != nil {
				return err
			}

			var token string
			if len(args) == 3 {
				token = args[2]
			} else {
				var err error
				if token, err = interactiveLogin(cmd.Context(), endpoint, web, device); err != nil {
					return err
				}
			}

			// File-only load: environment overlays must not be saved back.
			cfg, err := config.LoadFile(cfgFile)
			if err != nil {
				return err
			}
			// A fresh login supersedes a token_file entry: the new token is
			// written and token_file dropped (login never writes token_file).
			replacedTokenFile := cfg.Servers[name].TokenFile
			cfg.Servers[name] = config.Server{Endpoint: endpoint, Token: token}
			if cfg.DefaultServer == "" || setDefault {
				cfg.DefaultServer = name
			}
			if err := cfg.Save(cfgFile); err != nil {
				return err
			}

			fmt.Printf("✅ Logged in to %q (%s)\n", name, endpoint)
			if replacedTokenFile != "" {
				fmt.Printf(
					"   note: replaced the token_file entry (%s) with the new token\n",
					replacedTokenFile,
				)
			}
			return nil
		},
	}

	cmd.Flags().BoolVar(&web, "web", false, "authenticate in a local browser")
	cmd.Flags().BoolVar(&device, "device", false, "authenticate with a device code (headless)")
	cmd.Flags().
		BoolVar(&setDefault, "set-default", false, "make this server the default even when others exist")
	cmd.MarkFlagsMutuallyExclusive("web", "device")
	return cmd
}

// interactiveLogin picks between the browser (loopback) and device-code
// flows: an explicit flag wins, otherwise the browser is used whenever this
// looks like a local graphical session. A browser flow that cannot start
// falls back to the device flow.
func interactiveLogin(
	ctx context.Context,
	endpoint string,
	forceWeb, forceDevice bool,
) (string, error) {
	useWeb := forceWeb || (!forceDevice && canOpenBrowser())

	if useWeb {
		token, err := webLogin(ctx, endpoint)
		if err == nil || forceWeb || !errors.Is(err, errWebUnavailable) {
			return token, err
		}
		fmt.Printf("Browser login unavailable (%v); falling back to a device code.\n\n", err)
	}
	return deviceLogin(ctx, endpoint)
}

// canOpenBrowser reports whether this session can plausibly show a browser.
func canOpenBrowser() bool {
	if os.Getenv("SSH_CONNECTION") != "" || os.Getenv("SSH_TTY") != "" {
		return false
	}
	switch runtime.GOOS {
	case "darwin", "windows":
		return true
	default:
		return os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != ""
	}
}

// errWebUnavailable wraps failures that should degrade to the device flow
// rather than abort the login.
var errWebUnavailable = errors.New("web login unavailable")

// webLogin runs the loopback flow: a local listener receives the token from
// the admin app after the user authorizes in their browser.
func webLogin(ctx context.Context, endpoint string) (string, error) {
	authCfg, err := api.New(endpoint, "").GetAuthConfig(ctx)
	if err != nil {
		return "", fmt.Errorf("%w: %v", errWebUnavailable, err)
	}
	if authCfg.AuthorizeURL == "" {
		return "", fmt.Errorf("%w: server advertises no browser login", errWebUnavailable)
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", fmt.Errorf("%w: %v", errWebUnavailable, err)
	}
	defer func() { _ = listener.Close() }()
	port := listener.Addr().(*net.TCPAddr).Port

	stateBytes := make([]byte, 16)
	if _, err := rand.Read(stateBytes); err != nil {
		return "", err
	}
	state := hex.EncodeToString(stateBytes)

	hostname, _ := os.Hostname()
	query := url.Values{
		"port":     {fmt.Sprint(port)},
		"state":    {state},
		"label":    {"nimbus CLI"},
		"hostname": {hostname},
	}
	authorizeURL := authCfg.AuthorizeURL + "?" + query.Encode()

	tokens := make(chan string, 1)
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/callback" || r.URL.Query().Get("state") != state {
			http.Error(w, "unexpected callback", http.StatusBadRequest)
			return
		}
		token := r.URL.Query().Get("token")
		if token == "" {
			http.Error(w, "missing token", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "text/html")
		_, _ = fmt.Fprint(
			w,
			"<html><body><p>✅ nimbus is authorized — you can close this tab.</p></body></html>",
		)
		tokens <- token
	})}
	go func() { _ = server.Serve(listener) }()
	defer func() { _ = server.Close() }()

	if err := openBrowser(authorizeURL); err != nil {
		return "", fmt.Errorf("%w: opening browser: %v", errWebUnavailable, err)
	}
	fmt.Printf(
		"Opened your browser to authorize this device:\n\n    %s\n\nWaiting for authorization (rerun with --device for a headless login)…\n\n",
		authorizeURL,
	)

	select {
	case token := <-tokens:
		return token, nil
	case <-ctx.Done():
		return "", ctx.Err()
	case <-time.After(10 * time.Minute):
		return "", errors.New("browser authorization timed out")
	}
}

// openBrowser honors $BROWSER before the platform default opener.
func openBrowser(target string) error {
	if browser := os.Getenv("BROWSER"); browser != "" {
		return exec.Command(browser, target).Start()
	}
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", target).Start()
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", target).Start()
	default:
		return exec.Command("xdg-open", target).Start()
	}
}

// deviceLogin runs the RFC 8628 device-authorization flow: the user approves
// the grant in a browser on the admin app while the CLI polls for the token.
func deviceLogin(ctx context.Context, endpoint string) (string, error) {
	client := api.New(endpoint, "")
	grant, err := client.StartDeviceAuth(ctx)
	if err != nil {
		return "", fmt.Errorf("starting device authorization: %w", err)
	}

	fmt.Printf("To authorize this device, visit:\n\n    %s\n\nand confirm the code %s\n\n",
		grant.VerificationURIComplete, grant.UserCode)

	interval := time.Duration(max(grant.Interval, 1)) * time.Second
	deadline := time.Now().Add(time.Duration(grant.ExpiresIn) * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(interval):
		}
		token, err := client.PollDeviceToken(ctx, grant.DeviceCode)
		if err != nil {
			return "", err
		}
		if token != "" {
			return token, nil
		}
	}
	return "", errors.New("device authorization timed out")
}
