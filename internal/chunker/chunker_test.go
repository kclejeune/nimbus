package chunker

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

// makeBuf fills n bytes from splitmix32 — the same generator (and seed) as
// scratch script that produced the golden values from the TypeScript module.
func makeBuf(n int, seed uint32) []byte {
	buf := make([]byte, n)
	s := seed
	for i := 0; i < n; i += 4 {
		s += 0x9e3779b9
		z := s
		z ^= z >> 16
		z *= 0x21f0aaad
		z ^= z >> 15
		z *= 0x735a2d97
		z ^= z >> 15
		buf[i] = byte(z)
		buf[i+1] = byte(z >> 8)
		buf[i+2] = byte(z >> 16)
		buf[i+3] = byte(z >> 24)
	}
	return buf
}

// Golden values generated from web/src/lib/server/attic/chunking.ts (node,
// 48 MiB of splitmix32(0xdeadbeef) data). If this test fails, the Go and TS
// chunkers no longer cut identical boundaries and cross-path dedup between
// client- and server-cut chunks is broken.
var (
	goldenSizes  = []int{11424023, 16777216, 16777216, 5353193}
	goldenHashes = []string{
		"e01d922722f2c5f25822f430c835d82197248a932c18fb2751abcdc1a25cbec1",
		"994f34e842313e7d902c7cbb389949a5f79c1581b63384f79c36ae1890c5aa66",
		"804d70de09090ad441732be4167126ca1e7d21bdf9e90064a354545627468c0b",
		"5ec7ddfabde79aca7cfa9855ffea84de2abecd921d59d302ba8bde538d6aac5b",
	}
)

func collect(t *testing.T, buf []byte, blockSizes []int) (sizes []int, hashes []string) {
	t.Helper()
	c := New()
	emit := func(chunk []byte) error {
		sum := sha256.Sum256(chunk)
		sizes = append(sizes, len(chunk))
		hashes = append(hashes, hex.EncodeToString(sum[:]))
		return nil
	}
	off := 0
	for bi := 0; off < len(buf); bi++ {
		take := min(blockSizes[bi%len(blockSizes)], len(buf)-off)
		if err := c.Push(buf[off:off+take], emit); err != nil {
			t.Fatalf("push: %v", err)
		}
		off += take
	}
	if err := c.Finish(emit); err != nil {
		t.Fatalf("finish: %v", err)
	}
	return sizes, hashes
}

func TestGoldenBoundaries(t *testing.T) {
	buf := makeBuf(48*1024*1024, 0xdeadbeef)

	// One-shot and awkward incremental block sizes must cut identically.
	for name, blocks := range map[string][]int{
		"one-shot":    {len(buf)},
		"incremental": {1, 4095, 65536, 1048577, 7 * 1024 * 1024},
	} {
		sizes, hashes := collect(t, buf, blocks)
		if len(sizes) != len(goldenSizes) {
			t.Fatalf("%s: got %d chunks, want %d (%v)", name, len(sizes), len(goldenSizes), sizes)
		}
		for i := range goldenSizes {
			if sizes[i] != goldenSizes[i] {
				t.Errorf("%s: chunk %d size = %d, want %d", name, i, sizes[i], goldenSizes[i])
			}
			if hashes[i] != goldenHashes[i] {
				t.Errorf("%s: chunk %d hash = %s, want %s", name, i, hashes[i], goldenHashes[i])
			}
		}
	}
}

func TestGearTable(t *testing.T) {
	// Spot values computed independently with node (same splitmix32 seed and
	// finalizer as the TS module); a drifted table cuts different boundaries
	// even when the scan logic is right.
	want := map[int]uint32{
		0:   1505786268,
		1:   792079888,
		2:   2141751570,
		128: 1915569029,
		255: 1604384162,
	}
	for i, g := range want {
		if gear[i] != g {
			t.Errorf("gear[%d] = %d, want %d", i, gear[i], g)
		}
	}
}
