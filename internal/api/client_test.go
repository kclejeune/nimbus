package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
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
