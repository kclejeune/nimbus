package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/kclejeune/nimbus/internal/api"
	"github.com/kclejeune/nimbus/internal/config"
)

func doctorFixture(
	t *testing.T,
	closureStatus int,
	closureHTML bool,
	page api.IntegrityPage,
) cacheDoctor {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodGet {
			t.Errorf("doctor made a mutating request: %s %s", req.Method, req.URL.Path)
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if req.Header.Get("Authorization") != "Bearer secret-token" {
			t.Error("missing auth")
		}
		switch req.URL.Path {
		case "/test/attic-cache-info":
			_ = json.NewEncoder(w).
				Encode(api.CacheInfo{SubstituterEndpoint: "https://cache.test/test", PublicKey: "test:key", StoreDir: "/nix/store"})
		case "/_api/v1/caches":
			_ = json.NewEncoder(w).
				Encode(map[string]any{"caches": []api.CacheListEntry{{Name: "test", Permissions: api.CachePermissions{Pull: true, Push: true}}}})
		case "/_api/v1/cache-integrity/test":
			if closureHTML {
				w.Header().Set("Content-Type", "text/html")
			}
			w.WriteHeader(closureStatus)
			if closureStatus != http.StatusOK {
				// The reporter must never echo a server response containing secrets.
				if closureHTML {
					_, _ = fmt.Fprint(w, "<!DOCTYPE html> secret-token")
				} else {
					_, _ = fmt.Fprint(w, `{"error":"secret-token"}`)
				}
				return
			}
			_ = json.NewEncoder(w).Encode(page)
		default:
			t.Errorf("unexpected request %s", req.URL)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	return cacheDoctor{
		ref: &config.CacheRef{
			ServerName: "prod",
			Cache:      "test",
			Server:     config.Server{Endpoint: server.URL, Token: "secret-token"},
		},
		client: api.New(server.URL, "secret-token"),
		settings: func(context.Context) (*doctorNixSettings, error) {
			return &doctorNixSettings{
				Substituters: []string{"https://cache.test/test/"},
				Keys:         []string{"test:key"},
				Netrc:        "/netrc",
			}, nil
		},
		local: func(context.Context, []string) ([]string, []string, error) {
			t.Error("unexpected local store query")
			return nil, nil, nil
		},
		readFile: func(path string) ([]byte, error) {
			if path != "/netrc" {
				t.Errorf("unexpected file read %q", path)
			}
			return []byte("machine cache.test\n login ignored\n password secret-token\n"), nil
		},
	}
}

func checkDoctor(t *testing.T, d cacheDoctor) (doctorReport, string) {
	t.Helper()
	p := newMaintenanceProgress(io.Discard)
	defer p.close()
	report := d.check(t.Context(), p)
	var out bytes.Buffer
	if err := report.write(&out, false); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "secret-token") {
		t.Fatal("doctor exposed token")
	}
	var machine bytes.Buffer
	if err := report.write(&machine, true); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(machine.String(), "secret-token") {
		t.Fatal("JSON report exposed token")
	}
	var parsed doctorReport
	if err := json.Unmarshal(
		machine.Bytes(),
		&parsed,
	); err != nil ||
		len(parsed.Findings) != len(report.Findings) {
		t.Fatalf("invalid JSON report: %v", err)
	}
	return report, out.String()
}

func TestDoctorHealthyCacheOnlyReads(t *testing.T) {
	r, out := checkDoctor(t, doctorFixture(t, 200, false, api.IntegrityPage{}))
	if r.Warnings != 0 || r.Errors != 0 || !strings.Contains(out, "maintenance endpoint accepted") {
		t.Fatalf("unexpected findings: %s", out)
	}
}

func TestDoctorClassifiesDeniedOrUnavailableChecks(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		html   bool
		want   string
		errors int
	}{
		{"token", 401, false, "Server rejected the token", 1},
		{"scope", 403, false, "select the required cache scopes", 0},
		{"waf", 403, true, "Cloudflare Access/WAF", 1},
		{"old-worker", 404, false, "maintenance support", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, out := checkDoctor(t, doctorFixture(t, tc.status, tc.html, api.IntegrityPage{}))
			if r.Errors != tc.errors || !strings.Contains(out, tc.want) ||
				strings.Contains(out, "No unresolved dependencies") {
				t.Fatalf("wrong diagnosis: %s", out)
			}
		})
	}
}

func TestDoctorReportsSnapshotAndBatchesLocalChecks(t *testing.T) {
	page := api.IntegrityPage{NextCursor: strings.Repeat("z", 32)}
	for i := range 205 {
		hash := fmt.Sprintf("%032d", i)
		page.References = append(
			page.References,
			api.UncoveredReference{Hash: hash, StorePath: "/nix/store/" + hash + "-path"},
		)
	}
	d := doctorFixture(t, 200, false, page)
	calls := 0
	d.local = func(_ context.Context, paths []string) ([]string, []string, error) {
		calls++
		if len(paths) > 100 {
			t.Errorf("unbounded local argv: %d", len(paths))
		}
		return paths[:1], paths[1:], nil
	}
	r, out := checkDoctor(t, d)
	for _, want := range []string{"at least 205", "Upstream availability has not been rechecked", "3/205", "nimbus repair 'prod:test'", "nimbus purge 'prod:test'"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in %s", want, out)
		}
	}
	if r.Warnings != 1 || r.Errors != 0 || calls != 3 {
		t.Fatalf("report=%+v calls=%d", r, calls)
	}
}

func TestDoctorRejectsInvalidReferenceAndContinuesWithoutNix(t *testing.T) {
	page := api.IntegrityPage{
		References: []api.UncoveredReference{
			{Hash: strings.Repeat("0", 32), StorePath: "--malicious"},
		},
	}
	d := doctorFixture(t, 200, false, page)
	r, out := checkDoctor(t, d)
	if r.Errors != 1 || !strings.Contains(out, "invalid dependency path") {
		t.Fatal(out)
	}
	d.settings = func(context.Context) (*doctorNixSettings, error) { return nil, errors.New("missing Nix") }
	r, out = checkDoctor(t, d)
	if r.Warnings != 2 || !strings.Contains(out, "effective Nix settings") {
		t.Fatal(out)
	}
}

func TestDoctorEffectiveSettingsAndPrivateCredentials(t *testing.T) {
	d := doctorFixture(t, 200, false, api.IntegrityPage{})
	d.settings = func(context.Context) (*doctorNixSettings, error) { return &doctorNixSettings{Netrc: "/netrc"}, nil }
	d.readFile = func(string) ([]byte, error) { return []byte("machine other.test password secret-token"), nil }
	r, out := checkDoctor(t, d)
	if r.Warnings != 2 || !strings.Contains(out, "nimbus use 'prod:test'") ||
		!strings.Contains(out, "netrc-file overrides") {
		t.Fatal(out)
	}
	// A different root-proxy key must not be mistaken for a missing cache key.
	d.settings = func(context.Context) (*doctorNixSettings, error) {
		return &doctorNixSettings{
			Substituters: []string{d.ref.Server.Endpoint},
			Netrc:        "/netrc",
		}, nil
	}
	_, out = checkDoctor(t, d)
	if !strings.Contains(out, "separate signing key") ||
		strings.Contains(out, "cache signing key is missing") {
		t.Fatal(out)
	}
}

func TestDoctorNetrcFields(t *testing.T) {
	for _, tc := range []struct {
		data string
		want bool
	}{
		{"machine cache.test\nlogin user\npassword jwt", true},
		{`machine "cache.test" password "jwt"`, true},
		{"# machine cache.test password jwt\nmachine other.test password jwt", false},
		{"machine cache.test login password\nmachine other.test password jwt", false},
		{`machine cache.test password ""`, false},
		{"default login user password jwt", true},
		{"default\n login user\n password \"jwt\"", true},
		{"machine other.test password other\ndefault login user password jwt", true},
		{`default login user password ""`, false},
		{"default password jwt\nmachine cache.test login user", false},
		{"machine cache.test login user\ndefault password jwt", false},
		{"default password jwt\nmachine cache.test password \"\"", false},
		{"default password \"\"\nmachine cache.test password jwt", true},
	} {
		if got := doctorNetrcHasPassword(tc.data, "cache.test"); got != tc.want {
			t.Errorf("netrc match=%t want=%t", got, tc.want)
		}
	}
	if doctorNetrcHasPassword(
		"default password jwt\nmachine cache.test login user",
		"cache.test",
		"cache.test:8788",
	) {
		t.Fatal("default credential bypassed an explicit host stanza through a port alias")
	}
}

func TestDoctorSuggestionsPreserveSelectedConfig(t *testing.T) {
	page := api.IntegrityPage{References: []api.UncoveredReference{{
		Hash: strings.Repeat("0", 32), StorePath: "/nix/store/" + strings.Repeat("0", 32) + "-path",
	}}}
	d := doctorFixture(t, 200, false, page)
	d.configFile = "/tmp/nimbus configs/owner's.toml"
	d.ref.Server.Token = unsignedJWT(`{"exp":1}`)
	d.settings = func(context.Context) (*doctorNixSettings, error) {
		return &doctorNixSettings{Netrc: "/netrc"}, nil
	}
	d.local = func(_ context.Context, paths []string) ([]string, []string, error) { return paths, nil, nil }
	_, out := checkDoctor(t, d)
	const prefix = `nimbus --config '/tmp/nimbus configs/owner'"'"'s.toml'`
	for _, command := range []string{"login", "use", "repair", "purge"} {
		if !strings.Contains(out, prefix+" "+command+" ") {
			t.Errorf("missing config-preserving %s suggestion: %s", command, out)
		}
		if strings.Contains(out, "nimbus "+command+" ") {
			t.Errorf("unqualified %s suggestion: %s", command, out)
		}
	}
}

func TestDoctorAcceptsPrivateCacheDefaultNetrc(t *testing.T) {
	d := doctorFixture(t, 200, false, api.IntegrityPage{})
	d.readFile = func(string) ([]byte, error) {
		return []byte("machine other.test password other\ndefault login user password jwt"), nil
	}
	r, out := checkDoctor(t, d)
	if r.Warnings != 0 || r.Errors != 0 {
		t.Fatal(out)
	}
}

func TestDoctorTokenExpiry(t *testing.T) {
	for _, tc := range []struct {
		name             string
		expires          time.Duration
		warnings, errors int
	}{
		{"expired", -time.Hour, 0, 1},
		{"soon", time.Hour, 1, 0},
		{"healthy", 30 * 24 * time.Hour, 0, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := doctorFixture(t, 200, false, api.IntegrityPage{})
			d.ref.Server.Token = unsignedJWT(
				fmt.Sprintf(`{"exp":%d}`, time.Now().Add(tc.expires).Unix()),
			)
			r, out := checkDoctor(t, d)
			if r.Warnings != tc.warnings || r.Errors != tc.errors {
				t.Fatal(out)
			}
		})
	}
}

func TestDoctorTimeoutStillProducesReport(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, req *http.Request) {
		<-req.Context().Done()
	}))
	defer server.Close()
	d := doctorFixture(t, 200, false, api.IntegrityPage{})
	d.client = api.New(server.URL, "secret-token")
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancel()
	p := newMaintenanceProgress(io.Discard)
	defer p.close()
	r := d.check(ctx, p)
	var out bytes.Buffer
	if err := r.write(&out, true); err != nil {
		t.Fatal(err)
	}
	if r.Errors == 0 || !strings.Contains(out.String(), "timed out") {
		t.Fatal(out.String())
	}
}

func TestDoctorPreservesEnvironmentCacheReference(t *testing.T) {
	page := api.IntegrityPage{
		References: []api.UncoveredReference{
			{
				Hash:      strings.Repeat("0", 32),
				StorePath: "/nix/store/" + strings.Repeat("0", 32) + "-path",
			},
		},
	}
	d := doctorFixture(t, 200, false, page)
	d.ref.ServerName, d.target = "env", "test"
	d.local = func(_ context.Context, paths []string) ([]string, []string, error) { return paths, nil, nil }
	_, out := checkDoctor(t, d)
	if !strings.Contains(out, "nimbus repair 'test'") ||
		strings.Contains(out, "nimbus repair 'env:test'") {
		t.Fatal(out)
	}
}
