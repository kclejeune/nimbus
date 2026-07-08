// Package chunker is a FastCDC cutter bit-identical to the server's
// (web/src/lib/server/attic/chunking.ts): same gear table, masks, and
// min/avg/max sizes, so chunks cut client-side for >100 MB NARs dedup against
// chunks the server cut itself. The golden test pins the boundaries; any
// change here or in the TS module breaks dedup between the two.
package chunker

const (
	MinChunk     = 2 * 1024 * 1024
	avgChunkBits = 23
	AvgChunk     = 1 << avgChunkBits
	MaxChunk     = 16 * 1024 * 1024

	// FastCDC normalization: a stricter mask before the average size, a
	// looser one after, pulling the size distribution toward AvgChunk.
	maskS = (1 << (avgChunkBits + 1)) - 1
	maskL = (1 << (avgChunkBits - 1)) - 1
)

// gear mirrors the server's deterministic 31-bit table (splitmix32 seeded
// 0x9e3779b9). The values must never change: chunk boundaries — and
// therefore dedup — depend on them.
var gear = func() (g [256]uint32) {
	s := uint32(0x9e3779b9)
	for i := range g {
		s += 0x9e3779b9
		z := s
		z ^= z >> 16
		z *= 0x21f0aaad
		z ^= z >> 15
		z *= 0x735a2d97
		z ^= z >> 15
		g[i] = z & 0x7fffffff
	}
	return g
}()

// Chunker is an incremental FastCDC cutter: feed arbitrary blocks with Push,
// which emits chunks as they complete; Finish emits the remainder.
type Chunker struct {
	// Holds the current unfinished chunk plus incoming slack. A cut is forced
	// at MaxChunk, so len never exceeds MaxChunk for long.
	buf     []byte
	len     int
	scanned int
	hash    uint32
}

func New() *Chunker {
	return &Chunker{buf: make([]byte, 2*MaxChunk)}
}

// Push feeds data, calling emit for each completed chunk. The emitted slice
// aliases the chunker's buffer and is only valid during the call.
func (c *Chunker) Push(data []byte, emit func([]byte) error) error {
	for len(data) > 0 {
		take := min(len(c.buf)-c.len, len(data))
		copy(c.buf[c.len:], data[:take])
		c.len += take
		data = data[take:]
		if err := c.scan(emit); err != nil {
			return err
		}
	}
	return nil
}

// Finish emits any remainder as the final chunk and resets the chunker.
func (c *Chunker) Finish(emit func([]byte) error) error {
	if c.len == 0 {
		return nil
	}
	rest := c.buf[:c.len]
	c.len, c.scanned, c.hash = 0, 0, 0
	return emit(rest)
}

func (c *Chunker) scan(emit func([]byte) error) error {
	i := c.scanned
	hash := c.hash
	for i < c.len {
		hash = ((hash << 1) + gear[c.buf[i]]) & 0x7fffffff
		i++
		if i < MinChunk {
			continue
		}
		mask := uint32(maskL)
		if i < AvgChunk {
			mask = maskS
		}
		if hash&mask == 0 || i >= MaxChunk {
			err := emit(c.buf[:i])
			// Compact and reset state regardless of emit outcome so the
			// chunker's invariants hold even when the caller returns an error.
			copy(c.buf, c.buf[i:c.len])
			c.len -= i
			i = 0
			hash = 0
			if err != nil {
				c.scanned, c.hash = 0, 0
				return err
			}
		}
	}
	c.scanned = i
	c.hash = hash
	return nil
}
