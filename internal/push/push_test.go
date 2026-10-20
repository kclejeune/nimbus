package push

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/klauspost/compress/zstd"

	"github.com/kclejeune/nimbus/internal/api"
	"github.com/kclejeune/nimbus/internal/nix"
)

func TestUploadOneStrategies(t *testing.T) {
	// A file-backed dump avoids depending on an installed Nix store. The
	// transport, native codec, FastCDC passes and receipt forwarding are real.
	dir := t.TempDir()
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	if err := os.WriteFile(
		filepath.Join(dir, "nix-store"),
		[]byte("#!/bin/sh\nexec cat \"$NIMBUS_TEST_NAR\"\n"),
		0o755,
	); err != nil {
		t.Fatal(err)
	}
	large := filepath.Join(dir, "large.nar")
	file, err := os.Create(large)
	if err != nil {
		t.Fatal(err)
	}
	// Distinct MiB blocks keep the fixture compressible without making all
	// chunks identical, so completion must preserve their order.
	for i := range 64 {
		if _, err := file.Write(bytes.Repeat([]byte{byte(i)}, 1<<20)); err != nil {
			t.Fatal(err)
		}
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	fullHash := sha256.New()
	file, err = os.Open(large)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(fullHash, file); err != nil {
		t.Fatal(err)
	}
	file.Close()
	largeHash := hex.EncodeToString(fullHash.Sum(nil))
	small := filepath.Join(dir, "small.nar")
	smallBytes := []byte("small NAR payload")
	if err := os.WriteFile(small, smallBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	smallSum := sha256.Sum256(smallBytes)
	for _, tc := range []struct {
		name                        string
		size                        int64
		path, hash                  string
		queryStatus                 int
		oldProofs, chunked, wantErr bool
	}{
		{name: "small raw", size: int64(len(smallBytes)), path: small, hash: hex.EncodeToString(smallSum[:])},
		{name: "64 MiB compressed with completion", size: 64 << 20, path: large, hash: largeHash, chunked: true},
		{name: "64 MiB legacy raw fallback", size: 64 << 20, path: large, hash: largeHash, queryStatus: 404},
		{name: "64 MiB legacy receipts fallback", size: 64 << 20, path: large, hash: largeHash, oldProofs: true},
		{name: "permission errors do not fall back", size: 64 << 20, path: large, hash: largeHash, queryStatus: 403, wantErr: true},
		// Metadata is sufficient to test the raw-limit guard; the unsupported
		// server rejects the chunk query before checking the manifest size.
		{name: "100 MiB cannot use legacy raw fallback", size: 100 << 20, path: large, hash: largeHash, queryStatus: 404, wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("NIMBUS_TEST_NAR", tc.path)
			var mu sync.Mutex
			var queryCount, rawCount, completeCount int
			stored := map[string][]byte{}
			server := httptest.NewServer(
				http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					mu.Lock()
					defer mu.Unlock()
					defer r.Body.Close()
					w.Header().Set("Content-Type", "application/json")
					switch {
					case r.URL.Path == "/_api/v1/upload-path/chunks":
						queryCount++
						if tc.queryStatus != 0 {
							w.WriteHeader(tc.queryStatus)
							_, _ = io.WriteString(w, `{"error":"unsupported or forbidden"}`)
							return
						}
						var request struct {
							Chunks []api.ChunkDesc `json:"chunks"`
						}
						if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
							t.Error(err)
							w.WriteHeader(400)
							return
						}
						missing := make([]string, len(request.Chunks))
						for i, c := range request.Chunks {
							missing[i] = c.Hash
						}
						response := map[string]any{
							"kind":                 "pending",
							"missing_chunk_hashes": missing,
						}
						if !tc.oldProofs {
							response["proofs"] = map[string]string{}
						}
						_ = json.NewEncoder(w).Encode(response)
					case r.Method == "PUT" && strings.HasPrefix(r.URL.Path, "/_api/v1/upload-path/chunks/"):
						hash := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
						reader, err := zstd.NewReader(r.Body)
						if err != nil {
							t.Error(err)
							w.WriteHeader(400)
							return
						}
						raw, err := io.ReadAll(reader)
						reader.Close()
						if err != nil {
							t.Error(err)
							w.WriteHeader(400)
							return
						}
						sum := sha256.Sum256(raw)
						if hex.EncodeToString(sum[:]) != hash {
							t.Error("chunk hash mismatch")
							w.WriteHeader(400)
							return
						}
						stored[hash] = raw
						_ = json.NewEncoder(w).
							Encode(map[string]any{"ok": true, "proof": "receipt-" + hash})
					case r.URL.Path == "/_api/v1/upload-path/chunks/complete":
						completeCount++
						var request struct {
							Chunks  []api.ChunkDesc `json:"chunks"`
							NarSize int64           `json:"nar_size"`
						}
						if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
							t.Error(err)
							w.WriteHeader(400)
							return
						}
						digest := sha256.New()
						var size int64
						for _, c := range request.Chunks {
							if c.Proof != "receipt-"+c.Hash {
								t.Error("missing receipt")
								w.WriteHeader(400)
								return
							}
							raw := stored[c.Hash]
							digest.Write(raw)
							size += int64(len(raw))
						}
						if size != request.NarSize ||
							hex.EncodeToString(digest.Sum(nil)) != tc.hash {
							t.Error("assembled NAR mismatch")
							w.WriteHeader(400)
							return
						}
						_, _ = io.WriteString(w, `{"kind":"uploaded"}`)
					case r.URL.Path == "/_api/v1/upload-path":
						rawCount++
						digest := sha256.New()
						size, err := io.Copy(digest, r.Body)
						if err != nil || size != tc.size ||
							hex.EncodeToString(digest.Sum(nil)) != tc.hash {
							t.Error("raw NAR mismatch", err)
							w.WriteHeader(400)
							return
						}
						_, _ = io.WriteString(w, `{"kind":"uploaded"}`)
					default:
						t.Error("unexpected endpoint", r.URL.Path)
						w.WriteHeader(404)
					}
				}),
			)
			defer server.Close()
			p := Pusher{Client: api.New(server.URL, "token"), Cache: "test"}
			_, err := p.uploadOne(
				context.Background(),
				nix.PathInfo{
					Path:    "/nix/store/" + strings.Repeat("a", 32) + "-test",
					NarHash: "sha256:" + tc.hash,
					NarSize: tc.size,
				},
				func(int64) {},
			)
			mu.Lock()
			defer mu.Unlock()
			if (err != nil) != tc.wantErr {
				t.Fatalf("upload error: %v", err)
			}
			if tc.wantErr {
				if rawCount != 0 || completeCount != 0 {
					t.Fatal("error retried with a different upload protocol")
				}
				return
			}
			if tc.chunked {
				if queryCount != 1 || completeCount != 1 || rawCount != 0 || len(stored) == 0 {
					t.Fatal("chunked path not completed")
				}
			} else if rawCount != 1 || completeCount != 0 {
				t.Fatal("raw path not completed")
			}
		})
	}
}
