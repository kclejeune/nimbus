package chunker

// Differential boundary tests against the server's TypeScript cutter. The TS
// twin (web/src/lib/server/cache/chunking.test.ts) generates THE SAME inputs
// from the same splitmix32 streams and asserts THE SAME pinned digests. If
// either side drifts — gear table, masks, min/avg/max, scan order — its
// digest changes and one suite fails. Never update a digest here without
// updating the TS twin (and accepting that stored chunk identities change).

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"testing"
)

// prngBytes is a splitmix32 byte stream: each 32-bit output contributes 4
// little-endian bytes. Must match prngBytes in the TS differential test.
func prngBytes(seed uint32, length int) []byte {
	out := make([]byte, length)
	s := seed
	for i := 0; i < length; i += 4 {
		s += 0x9e3779b9
		z := s
		z ^= z >> 16
		z *= 0x21f0aaad
		z ^= z >> 15
		z *= 0x735a2d97
		z ^= z >> 15
		out[i] = byte(z)
		if i+1 < length {
			out[i+1] = byte(z >> 8)
		}
		if i+2 < length {
			out[i+2] = byte(z >> 16)
		}
		if i+3 < length {
			out[i+3] = byte(z >> 24)
		}
	}
	return out
}

const mib = 1024 * 1024

func boundaryDigest(lengths []int) string {
	parts := make([]string, len(lengths))
	for i, n := range lengths {
		parts[i] = strconv.Itoa(n)
	}
	sum := sha256.Sum256([]byte(strings.Join(parts, ",")))
	return hex.EncodeToString(sum[:])
}

func cutAll(t *testing.T, data []byte, pushSize int) []int {
	t.Helper()
	var lengths []int
	c := New()
	emit := func(chunk []byte) error {
		lengths = append(lengths, len(chunk))
		return nil
	}
	for off := 0; off < len(data); off += pushSize {
		end := min(off+pushSize, len(data))
		if err := c.Push(data[off:end], emit); err != nil {
			t.Fatalf("Push: %v", err)
		}
	}
	if err := c.Finish(emit); err != nil {
		t.Fatalf("Finish: %v", err)
	}
	return lengths
}

func TestDifferentialCorpus(t *testing.T) {
	cases := []struct {
		name   string
		data   func() []byte
		digest string
	}{
		{
			name:   "random-40MiB",
			data:   func() []byte { return prngBytes(1, 40*mib) },
			digest: "a54ec757d8fa6b6cd59c596c353c9a971dd46d2dd66509bcecc960ef4997e231",
		},
		{
			name:   "zeros-24MiB",
			data:   func() []byte { return make([]byte, 24*mib) },
			digest: "072b0c7944560a97e7c5e0282d05a1299e28586d3217e3e90e2182b42ad5747a",
		},
		{
			name: "repeat-1KiB-24MiB",
			data: func() []byte {
				block := prngBytes(2, 1024)
				out := make([]byte, 24*mib)
				for i := 0; i < len(out); i += 1024 {
					copy(out[i:], block)
				}
				return out
			},
			digest: "072b0c7944560a97e7c5e0282d05a1299e28586d3217e3e90e2182b42ad5747a",
		},
		{
			name: "random-with-zero-runs-32MiB",
			data: func() []byte {
				out := prngBytes(3, 32*mib)
				for mark := 3 * mib; mark+512*1024 <= len(out); mark += 3 * mib {
					clear(out[mark : mark+512*1024])
				}
				return out
			},
			digest: "ad79dae0d9e3dd99796336d6c43b3024b75c9f268b47bae1df4f373d5b9f4efe",
		},
		{
			name:   "sub-min-1MiB",
			data:   func() []byte { return prngBytes(4, mib) },
			digest: "50b4b069390c1d7966da182649bb2caddb412a2f9012425b5e9ec0ef4ec68545",
		},
		{
			name:   "max-exact-32MiB-zeros",
			data:   func() []byte { return make([]byte, 32*mib) },
			digest: "68b4798f3bf07a216ebea4318987df86db3fd08d305638d66ca3966f354f4999",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			data := tc.data()
			lengths := cutAll(t, data, len(data))

			total := 0
			for i, n := range lengths {
				total += n
				if i < len(lengths)-1 && n < MinChunk {
					t.Errorf("chunk %d is %d bytes, below MinChunk", i, n)
				}
				if n > MaxChunk {
					t.Errorf("chunk %d is %d bytes, above MaxChunk", i, n)
				}
			}
			if total != len(data) {
				t.Errorf("chunks sum to %d, want %d", total, len(data))
			}

			if got := boundaryDigest(lengths); got != tc.digest {
				t.Errorf(
					"boundary digest = %s, want %s (%d chunks) — the Go and TS cutters have diverged",
					got,
					tc.digest,
					len(lengths),
				)
			}
		})
	}
}

func TestPushGranularityInvariance(t *testing.T) {
	data := prngBytes(5, 24*mib)
	oneShot := cutAll(t, data, len(data))
	// Prime-sized pushes so block edges never align with chunk boundaries.
	incremental := cutAll(t, data, 65537)
	if fmt.Sprint(oneShot) != fmt.Sprint(incremental) {
		t.Errorf("boundaries differ by push granularity: %v vs %v", oneShot, incremental)
	}
}
