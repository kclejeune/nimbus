package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/kclejeune/nimbus/internal/api"
)

func TestPurgePlansByDefaultAndExcludesUnverifiedAndProtectedPaths(t *testing.T) {
	for _, apply := range []bool{false, true} {
		t.Run(fmt.Sprint("apply=", apply), func(t *testing.T) {
			missing, unknown := strings.Repeat("9", 32), strings.Repeat("8", 32)
			target := func(id int64, blocked int) api.PurgeTarget {
				return api.PurgeTarget{
					ID:        id,
					Hash:      fmt.Sprintf("%032d", id),
					StorePath: fmt.Sprintf("/nix/store/%032d-path", id),
					NarID:     id,
					CreatedAt: "2026-07-01T00:00:00Z",
					Blocked:   blocked,
				}
			}
			applications, replays := 0, 0
			server := httptest.NewServer(
				http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					switch r.URL.Path {
					case "/_api/v1/cache-integrity/test":
						_ = json.NewEncoder(w).
							Encode(api.IntegrityPage{References: []api.UncoveredReference{{Hash: missing, StorePath: "/nix/store/" + missing + "-missing"}, {Hash: unknown, StorePath: "/nix/store/" + unknown + "-unknown"}}})
					case "/_api/v1/cache-integrity/test/check":
						var body struct {
							Hashes []string `json:"hashes"`
						}
						_ = json.NewDecoder(r.Body).Decode(&body)
						result := api.ReferenceStatus{}
						for _, h := range body.Hashes {
							if h == missing {
								result.Missing = append(result.Missing, h)
							} else {
								result.Unverified = append(result.Unverified, h)
							}
						}
						_ = json.NewEncoder(w).Encode(result)
					case "/_api/v1/cache-integrity/test/purge-plan":
						var body struct {
							Hashes []string `json:"hashes"`
							After  int64    `json:"after"`
						}
						_ = json.NewDecoder(r.Body).Decode(&body)
						if !reflect.DeepEqual(body.Hashes, []string{missing}) {
							t.Errorf("unverified hash entered purge plan: %v", body.Hashes)
						}
						page := api.PurgePlan{
							Objects:    []api.PurgeTarget{target(1, 0)},
							NextCursor: 1,
						}
						if body.After == 1 {
							page = api.PurgePlan{Objects: []api.PurgeTarget{target(2, 1)}}
						}
						_ = json.NewEncoder(w).Encode(page)
					case "/_api/v1/cache-integrity/test/purge-replay":
						replays++
						_ = json.NewEncoder(w).Encode(map[string]int{"pending": 0})
					case "/_api/v1/cache-integrity/test/purge-apply":
						applications++
						var body struct {
							ID      string            `json:"id"`
							Hashes  []string          `json:"hashes"`
							Targets []api.PurgeTarget `json:"targets"`
						}
						_ = json.NewDecoder(r.Body).Decode(&body)
						if len(body.ID) != 36 ||
							!reflect.DeepEqual(body.Hashes, []string{missing}) ||
							len(body.Targets) != 1 ||
							body.Targets[0].ID != 1 ||
							body.Targets[0].StorePath != "" {
							t.Errorf("unsafe application body: %+v", body)
						}
						_ = json.NewEncoder(w).
							Encode(api.PurgeResult{Removed: 1, PendingPurge: true})
					default:
						t.Errorf("unexpected request %s", r.URL.Path)
						w.WriteHeader(404)
					}
				}),
			)
			defer server.Close()
			var out, progress bytes.Buffer
			err := (closurePurger{client: api.New(server.URL, "token"), cache: "test", out: &out, progress: &progress}).run(
				t.Context(),
				apply,
			)
			if err != nil {
				t.Fatal(err)
			}
			want := 0
			if apply {
				want = 1
			}
			if applications != want || replays != want {
				t.Fatalf("mutation counts: apply=%d, replay=%d", applications, replays)
			}
			for _, text := range []string{"1 unverified dependencies excluded", "1 paths to remove; 1 protected"} {
				if !strings.Contains(out.String(), text) {
					t.Fatalf("missing plan detail %q: %s", text, out.String())
				}
			}
			if apply && !strings.Contains(out.String(), "durably queued") {
				t.Fatalf("lost pending invalidation status: %s", out.String())
			}
			if !apply && !strings.Contains(out.String(), "Plan only") {
				t.Fatalf("default mode did not show plan: %s", out.String())
			}
			if !strings.Contains(progress.String(), "Verifying upstream coverage") ||
				strings.Contains(progress.String(), "\x1b") {
				t.Fatalf("invalid piped progress: %q", progress.String())
			}
		})
	}
}
