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
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/kclejeune/nimbus/internal/api"
)

func TestRepairRechecksPagesAndUploadsAvailableClosures(t *testing.T) {
	for _, dryRun := range []bool{true, false} {
		t.Run(map[bool]string{true: "dry run", false: "repair"}[dryRun], func(t *testing.T) {
			hashes := []string{
				strings.Repeat("1", 32),
				strings.Repeat("2", 32),
				strings.Repeat("3", 32),
			}
			paths := []string{
				"/nix/store/" + hashes[0] + "-one",
				"/nix/store/" + hashes[1] + "-two",
				"/nix/store/" + hashes[2] + "-three",
			}
			pages := 0
			queries := 0
			server := httptest.NewServer(
				http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
					if req.Header.Get("Authorization") != "Bearer secret" {
						t.Error("missing auth")
					}
					switch req.URL.Path {
					case "/_api/v1/cache-integrity/test":
						pages++
						page := api.IntegrityPage{}
						if pages == 1 {
							page.References = []api.UncoveredReference{
								{Hash: hashes[0], StorePath: paths[0]},
								{Hash: hashes[1], StorePath: paths[1]},
							}
							page.NextCursor = hashes[1]
						} else {
							if req.URL.Query().Get("after") != hashes[1] {
								t.Error("lost pagination cursor")
							}
							page.References = []api.UncoveredReference{
								{Hash: hashes[2], StorePath: paths[2]},
							}
						}
						_ = json.NewEncoder(w).Encode(page)
					case "/_api/v1/cache-integrity/test/check":
						queries++
						var body struct {
							Hashes []string `json:"hashes"`
						}
						_ = json.NewDecoder(req.Body).Decode(&body)
						// The first dependency is now upstream-covered. The others need repair.
						var missing []string
						for _, h := range body.Hashes {
							if h != hashes[0] {
								missing = append(missing, h)
							}
						}
						_ = json.NewEncoder(w).Encode(map[string]any{"missing": missing})
					default:
						t.Errorf("unexpected request %s", req.URL.Path)
						w.WriteHeader(404)
					}
				}),
			)
			defer server.Close()
			var out bytes.Buffer
			var pushed []string
			r := closureRepair{
				client: api.New(server.URL, "secret"), cache: "test", out: &out,
				local: func(_ context.Context, got []string) ([]string, []string, error) {
					if !reflect.DeepEqual(got, paths[1:]) {
						t.Errorf("checking unexpected paths: %v", got)
					}
					return paths[1:2], paths[2:], nil
				},
				push: func(_ context.Context, got []string) error {
					pushed = got
					return nil
				},
			}
			err := r.run(t.Context(), dryRun)
			if dryRun {
				if err != nil || len(pushed) != 0 {
					t.Fatalf("dry run uploaded or failed: %v, %v", pushed, err)
				}
			} else if err == nil || !strings.Contains(err.Error(), "1 dependencies unavailable") || !reflect.DeepEqual(pushed, paths[1:2]) {
				t.Fatalf("partial repair: pushed %v, err %v", pushed, err)
			}
			if pages != 2 || queries != 2 ||
				!strings.Contains(out.String(), "unavailable\t"+paths[2]) {
				t.Fatalf(
					"incomplete scan or report: pages %d queries %d output %s",
					pages,
					queries,
					out.String(),
				)
			}
		})
	}
}

func TestRepairRejectsUnsafeServerPaths(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(api.IntegrityPage{References: []api.UncoveredReference{
			{
				Hash:      strings.Repeat("1", 32),
				StorePath: "/nix/store/" + strings.Repeat("1", 32) + "-../../secret",
			},
		}})
	}))
	defer server.Close()
	r := closureRepair{client: api.New(server.URL, ""), out: &bytes.Buffer{}}
	if err := r.run(
		t.Context(),
		false,
	); err == nil ||
		!strings.Contains(err.Error(), "invalid dependency") {
		t.Fatalf("accepted unsafe dependency: %v", err)
	}
}

func TestRepairLargeBacklogBatchesUploads(t *testing.T) {
	const total = 30_001 // Enough ordinary store paths to overflow an unbounded argv.
	paths := make([]string, total)
	for i := range paths {
		paths[i] = fmt.Sprintf("/nix/store/%032d-dependency", i+1)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch req.URL.Path {
		case "/_api/v1/cache-integrity/test":
			start, _ := strconv.Atoi(req.URL.Query().Get("after"))
			end := min(start+100, total)
			page := api.IntegrityPage{}
			for i := start; i < end; i++ {
				page.References = append(page.References, api.UncoveredReference{
					Hash: fmt.Sprintf("%032d", i+1), StorePath: paths[i],
				})
			}
			if end < total {
				page.NextCursor = fmt.Sprintf("%032d", end)
			}
			_ = json.NewEncoder(w).Encode(page)
		case "/_api/v1/cache-integrity/test/check":
			var body struct {
				Hashes []string `json:"hashes"`
			}
			_ = json.NewDecoder(req.Body).Decode(&body)
			_ = json.NewEncoder(w).Encode(map[string]any{"missing": body.Hashes})
		default:
			t.Errorf("unexpected request %s", req.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	pushErr := errors.New("upload failed")
	for _, mode := range []string{"repair", "dry run", "upload failure"} {
		t.Run(mode, func(t *testing.T) {
			var pushed []string
			calls := 0
			r := closureRepair{
				client: api.New(server.URL, ""), cache: "test", out: io.Discard,
				local: func(_ context.Context, got []string) ([]string, []string, error) {
					if len(got) > 100 {
						t.Fatalf("validity check received %d paths", len(got))
					}
					return got, nil, nil
				},
				push: func(_ context.Context, got []string) error {
					if len(got) > 100 {
						t.Fatalf("push received %d paths; subprocess argv would overflow", len(got))
					}
					calls++
					if mode == "upload failure" && calls == 2 {
						return pushErr
					}
					pushed = append(pushed, got...)
					return nil
				},
			}
			err := r.run(t.Context(), mode == "dry run")
			switch mode {
			case "repair":
				if err != nil || !reflect.DeepEqual(pushed, paths) {
					t.Fatalf("repair lost or reordered paths: pushed %d, err %v", len(pushed), err)
				}
			case "dry run":
				if err != nil || calls != 0 {
					t.Fatalf("dry run uploaded or failed: calls %d, err %v", calls, err)
				}
			case "upload failure":
				if !errors.Is(err, pushErr) || calls != 2 ||
					!reflect.DeepEqual(pushed, paths[:100]) {
					t.Fatalf("repair did not stop at failed batch: calls %d, err %v", calls, err)
				}
			}
		})
	}
}
