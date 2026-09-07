package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"
)

func TestMissingPathsBatches(t *testing.T) {
	var sizes []int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Cache  string   `json:"cache"`
			Hashes []string `json:"store_path_hashes"`
			Ignore bool     `json:"ignore_upstream_cache_filter"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		if r.URL.Path != "/_api/v1/get-missing-paths" || body.Cache != "test" || !body.Ignore {
			t.Error("batch lost request options")
		}
		sizes = append(sizes, len(body.Hashes))
		if err := json.NewEncoder(w).
			Encode(map[string]any{"missing_paths": body.Hashes}); err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()
	hashes := make([]string, 20_001)
	for i := range hashes {
		hashes[i] = fmt.Sprintf("%032x", i)
	}
	got, err := New(server.URL, "").GetMissingPaths(t.Context(), "test", hashes, true)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(got, hashes) || !slices.Equal(sizes, []int{10_000, 10_000, 1}) {
		t.Fatalf("batching lost paths or exceeded limit: sizes=%v, paths=%d", sizes, len(got))
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestUnsafePostIsNotReplayed(t *testing.T) {
	for _, path := range []string{"/_api/v1/tokens", "/_api/v1/cli/device", "/_api/v1/cache-config/x/rename"} {
		t.Run(path, func(t *testing.T) {
			calls := 0
			c := &Client{
				hc: &http.Client{
					Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
						calls++
						return &http.Response{
							StatusCode: 503,
							Header:     make(http.Header),
							Body:       http.NoBody,
							Request:    r,
						}, nil
					}),
				},
			}
			req, err := http.NewRequestWithContext(
				t.Context(),
				http.MethodPost,
				"https://cache.test"+path,
				nil,
			)
			if err != nil {
				t.Fatal(err)
			}
			res, attempts, err := c.do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			if calls != 1 || attempts != 1 {
				t.Fatalf("unsafe operation replayed %d times", calls)
			}
		})
	}
}

func TestCancelledRetryDoesNotOpenReplacementBody(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	c := &Client{
		hc: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			cancel()
			return &http.Response{
				StatusCode: 503,
				Header:     make(http.Header),
				Body:       http.NoBody,
				Request:    r,
			}, nil
		})},
	}
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPut,
		"https://cache.test/_api/v1/upload-path",
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	opened := 0
	req.GetBody = func() (io.ReadCloser, error) { opened++; return http.NoBody, nil }
	_, _, err = c.do(req)
	if !errors.Is(err, context.Canceled) || opened != 0 {
		t.Fatalf("error=%v replacement bodies=%d", err, opened)
	}
}

func TestRetryAfterFloor(t *testing.T) {
	for _, value := range []string{"60", "999999999999"} {
		got, _ := retryAfter(&http.Response{Header: http.Header{"Retry-After": {value}}})
		if got < time.Minute {
			t.Fatalf("Retry-After %s shortened to %v", value, got)
		}
	}
}

func TestChunkUploadRequiresAndReturnsPossessionReceipt(t *testing.T) {
	for _, proof := range []string{"", "signed-receipt"} {
		t.Run(proof, func(t *testing.T) {
			c := New("https://cache.test", "")
			c.hc.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if r.Method != http.MethodPut || r.URL.Query().Get("cache") != "destination" {
					t.Fatal("chunk upload lost its cache scope")
				}
				body, err := json.Marshal(map[string]string{"proof": proof})
				if err != nil {
					t.Fatal(err)
				}
				return &http.Response{
					StatusCode: 200,
					Header:     make(http.Header),
					Body:       io.NopCloser(bytes.NewReader(body)),
					Request:    r,
				}, nil
			})
			got, err := c.UploadChunk(t.Context(), "destination", "hash", []byte("compressed"))
			if proof == "" {
				if err == nil {
					t.Fatal("accepted missing receipt")
				}
				return
			}
			if err != nil || got != proof {
				t.Fatalf("receipt=%q err=%v", got, err)
			}
		})
	}
}

func TestMarkedPostReplays(t *testing.T) {
	calls := 0
	c := &Client{
		hc: &http.Client{
			Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				calls++
				status := 503
				if calls == 2 {
					status = 200
				}
				return &http.Response{
					StatusCode: status,
					Header:     make(http.Header),
					Body:       http.NoBody,
					Request:    r,
				}, nil
			}),
		},
	}
	req, err := http.NewRequestWithContext(
		withReplay(t.Context()),
		http.MethodPost,
		"https://cache.test/prefix/_api/v1/get-missing-paths",
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	res, attempts, err := c.do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 || attempts != 2 {
		t.Fatalf("status=%d attempts=%d", res.StatusCode, attempts)
	}
}

func TestDeferredPathsAreRequeriedBeforeBeingPushed(t *testing.T) {
	var queries [][]string
	c := New("https://cache.test", "")
	c.hc.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		var body struct {
			Hashes []string `json:"store_path_hashes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		queries = append(queries, body.Hashes)
		var out map[string][]string
		switch len(queries) {
		case 1:
			// b was not probed in time: reported missing for attic clients,
			// deferred for ours.
			out = map[string][]string{"missing_paths": {"a", "b"}, "deferred_paths": {"b"}}
		default:
			out = map[string][]string{"missing_paths": {}}
		}
		data, err := json.Marshal(out)
		if err != nil {
			t.Fatal(err)
		}
		return &http.Response{
			StatusCode: 200,
			Header:     http.Header{"Content-Type": {"application/json"}},
			Body:       io.NopCloser(bytes.NewReader(data)),
			Request:    r,
		}, nil
	})
	missing, err := c.GetMissingPaths(t.Context(), "cache", []string{"a", "b", "c"}, false)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(missing, []string{"a"}) || len(queries) != 2 ||
		!slices.Equal(queries[1], []string{"b"}) {
		t.Fatalf("missing=%v queries=%v", missing, queries)
	}
}

func TestDeferredRetriesRespectBatchLimit(t *testing.T) {
	var sizes []int
	c := New("https://cache.test", "")
	c.hc.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		var body struct {
			Hashes []string `json:"store_path_hashes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		sizes = append(sizes, len(body.Hashes))
		out := map[string][]string{"missing_paths": body.Hashes}
		// The first round defers everything it was asked about.
		if len(sizes) <= 3 {
			out["deferred_paths"] = body.Hashes
		}
		data, err := json.Marshal(out)
		if err != nil {
			t.Fatal(err)
		}
		return &http.Response{
			StatusCode: 200,
			Header:     http.Header{"Content-Type": {"application/json"}},
			Body:       io.NopCloser(bytes.NewReader(data)),
			Request:    r,
		}, nil
	})
	hashes := make([]string, 20_001)
	for i := range hashes {
		hashes[i] = fmt.Sprintf("h%05d", i)
	}
	missing, err := c.GetMissingPaths(t.Context(), "cache", hashes, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(missing) != len(hashes) {
		t.Fatalf("lost paths: %d", len(missing))
	}
	for _, n := range sizes {
		if n > 10_000 {
			t.Fatalf("retry batch exceeded the server limit: %v", sizes)
		}
	}
	if len(sizes) != 6 {
		t.Fatalf("expected 3 initial + 3 retry requests, got %v", sizes)
	}
}
