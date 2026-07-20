// Package push uploads store path closures to a nimbus cache.
package push

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/klauspost/compress/zstd"

	"github.com/kclejeune/nimbus/internal/api"
	"github.com/kclejeune/nimbus/internal/chunker"
	"github.com/kclejeune/nimbus/internal/nix"
)

// Above this NAR size (the Workers request-body limit) the client cuts the
// NAR with FastCDC itself and uploads only the chunks the server is missing.
const chunkedThreshold = 100 * 1024 * 1024

// Concurrent compress+PUT workers per chunked NAR; also bounds how many raw
// chunks (≤16 MiB each) are buffered at once.
const chunkUploadJobs = 8

type Pusher struct {
	Client *api.Client
	Cache  string
	Jobs   int
	Out    io.Writer
	// Err receives diagnostics (skip warnings, per-path failures) so stdout
	// stays clean for progress output; falls back to Out when nil.
	Err io.Writer
	// SkipInvalid tolerates paths missing from the local store: they are
	// always skipped (never fail the batch), but without SkipInvalid their
	// presence makes Push return an error after the valid paths upload.
	SkipInvalid bool
	// NoClosure pushes exactly the given paths without computing closures.
	NoClosure bool
	// IgnoreUpstreamFilter asks the server not to drop paths that are already
	// fetchable from the cache's configured upstreams.
	IgnoreUpstreamFilter bool
}

// Push uploads the closures of the given paths, skipping whatever the server
// reports as already present (locally or in its upstream caches).
func (p *Pusher) Push(ctx context.Context, paths []string) error {
	// Paths missing from the local store never fail the batch — CI pushes
	// evaluated outPaths, and checks that `nix flake check` skipped as
	// foreign-platform were never built locally — but they do fail the exit
	// code unless SkipInvalid says they are expected.
	paths, invalid, err := nix.SplitValid(ctx, paths)
	if err != nil {
		return err
	}
	var invalidErr error
	if len(invalid) > 0 {
		level := "warning"
		if !p.SkipInvalid {
			level = "error"
			invalidErr = fmt.Errorf("skipped %d paths not valid in the local store", len(invalid))
		}
		for _, m := range invalid {
			fmt.Fprintf(p.errw(), "%s: skipping %s: not valid in the local store\n", level, m)
		}
	}
	if len(paths) == 0 {
		if invalidErr != nil {
			return invalidErr
		}
		fmt.Fprintln(p.Out, "nothing to push")
		return nil
	}

	infos, err := p.pathInfos(ctx, paths)
	if err != nil {
		return err
	}

	hashes := make([]string, len(infos))
	byHash := make(map[string]nix.PathInfo, len(infos))
	for i, info := range infos {
		hash := nix.HashPart(info.Path)
		hashes[i] = hash
		byHash[hash] = info
	}

	missing, err := p.Client.GetMissingPaths(ctx, p.Cache, hashes, p.IgnoreUpstreamFilter)
	if err != nil {
		return fmt.Errorf("querying %q for missing paths: %w", p.Cache, err)
	}

	_, _ = fmt.Fprintf(p.Out, "⚙️  Pushing %d paths to %q (%d already present or upstream)\n",
		len(missing), p.Cache, len(infos)-len(missing))
	if len(missing) == 0 {
		return invalidErr
	}

	jobs := max(p.Jobs, 1)
	queue := make(chan nix.PathInfo)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var pathErrs []error

	for range jobs {
		wg.Go(func() {
			for info := range queue {
				if err := p.uploadOne(ctx, info); err != nil {
					// Context cancellation (Ctrl-C) ends the worker; any other
					// failure is per-path — report it like the ✅ line, keep
					// draining the queue, and aggregate for the exit status
					// instead of abandoning every path still pending.
					if ctx.Err() != nil {
						return
					}
					_, _ = fmt.Fprintf(p.errw(), "❌ %s: %v\n", nix.BaseName(info.Path), err)
					mu.Lock()
					pathErrs = append(pathErrs, fmt.Errorf("%s: %w", nix.BaseName(info.Path), err))
					mu.Unlock()
				}
			}
		})
	}

feed:
	for _, hash := range missing {
		info, ok := byHash[hash]
		if !ok {
			continue
		}
		select {
		case queue <- info:
		case <-ctx.Done():
			break feed
		}
	}
	close(queue)
	wg.Wait()
	if len(pathErrs) > 0 {
		// Per-path detail already printed as ❌ lines; the summary wraps the
		// first error so errors.As classification (exit codes) still works.
		return fmt.Errorf(
			"%d of %d paths failed; first: %w",
			len(pathErrs),
			len(missing),
			pathErrs[0],
		)
	}
	return invalidErr
}

func (p *Pusher) errw() io.Writer {
	if p.Err != nil {
		return p.Err
	}
	return p.Out
}

func (p *Pusher) pathInfos(ctx context.Context, paths []string) ([]nix.PathInfo, error) {
	if p.NoClosure {
		return nix.PathInfoFor(ctx, paths)
	}
	return nix.ClosurePathInfo(ctx, paths)
}

func (p *Pusher) uploadOne(ctx context.Context, info nix.PathInfo) error {
	start := time.Now()

	var result *api.UploadResult
	var err error
	if info.NarSize >= chunkedThreshold {
		result, err = p.uploadChunked(ctx, info)
	} else {
		result, err = p.uploadSimple(ctx, info)
	}
	if err != nil {
		return err
	}

	speed := float64(info.NarSize) / max(time.Since(start).Seconds(), 0.001)
	suffix := fmt.Sprintf("(%s/s)", FormatBytes(int64(speed)))
	if result.Kind == "deduplicated" {
		suffix = "(deduplicated)"
	}
	_, _ = fmt.Fprintf(p.Out, "✅ %s %s\n", nix.BaseName(info.Path), suffix)
	return nil
}

func (p *Pusher) narInfo(info nix.PathInfo) *api.NarInfo {
	narInfo := &api.NarInfo{
		Cache:         p.Cache,
		StorePathHash: nix.HashPart(info.Path),
		StorePath:     info.Path,
		References:    info.References,
		Sigs:          info.Sigs,
		NarHash:       info.NarHash,
	}
	if narInfo.References == nil {
		narInfo.References = []string{}
	}
	if narInfo.Sigs == nil {
		narInfo.Sigs = []string{}
	}
	if info.Deriver != "" {
		narInfo.Deriver = &info.Deriver
	}
	if info.CA != "" {
		narInfo.CA = &info.CA
	}
	return narInfo
}

// uploadSimple streams the raw NAR; the server compresses. The body factory
// re-dumps the path per call (store paths are immutable, so every dump yields
// identical bytes), making the stream replayable for the transport-level 5xx
// retry in api.Client.
func (p *Pusher) uploadSimple(ctx context.Context, info nix.PathInfo) (*api.UploadResult, error) {
	result, err := p.Client.UploadPath(ctx, p.narInfo(info), func() (io.ReadCloser, error) {
		pr, pw := io.Pipe()
		go func() {
			pw.CloseWithError(nix.DumpPath(ctx, pw, info.Path))
		}()
		return pr, nil
	}, info.NarSize)
	if err != nil {
		return nil, fmt.Errorf("upload: %w", err)
	}
	return result, nil
}

// uploadChunked cuts the NAR with the server-compatible FastCDC, uploads only
// the chunks the server lacks (compressed client-side), then assembles the
// NAR from chunk references with a stateless complete call.
func (p *Pusher) uploadChunked(ctx context.Context, info nix.PathInfo) (*api.UploadResult, error) {
	// Pass 1: boundaries and hashes only. Store paths are immutable, so the
	// second dump below yields identical bytes; the hash check in pass 2
	// guards the assumption.
	var descs []api.ChunkDesc
	if err := p.eachChunk(ctx, info.Path, func(chunk []byte) error {
		sum := sha256.Sum256(chunk)
		descs = append(
			descs,
			api.ChunkDesc{Hash: hex.EncodeToString(sum[:]), Size: int64(len(chunk))},
		)
		return nil
	}); err != nil {
		return nil, err
	}

	query, err := p.Client.QueryChunks(ctx, p.narInfo(info), info.NarSize, descs)
	if err != nil {
		return nil, fmt.Errorf("querying missing chunks: %w", err)
	}
	if query.Kind == "deduplicated" {
		return &api.UploadResult{Kind: "deduplicated"}, nil
	}

	missing := make(map[string]bool, len(query.MissingChunkHashes))
	for _, h := range query.MissingChunkHashes {
		missing[h] = true
	}

	for attempt := 0; ; attempt++ {
		if err := p.uploadMissingChunks(ctx, info, descs, missing); err != nil {
			return nil, err
		}
		result, stillMissing, err := p.Client.CompleteChunks(
			ctx,
			p.narInfo(info),
			info.NarSize,
			descs,
		)
		if err != nil {
			return nil, fmt.Errorf("assembling NAR from chunks: %w", err)
		}
		if result != nil {
			return result, nil
		}
		if attempt >= 1 {
			return nil, fmt.Errorf("server still missing %d chunks after retry", len(stillMissing))
		}
		// GC raced the upload; re-send the listed chunks and retry once.
		missing = make(map[string]bool, len(stillMissing))
		for _, h := range stillMissing {
			missing[h] = true
		}
	}
}

// uploadMissingChunks re-dumps the NAR and uploads each chunk in the missing
// set, zstd-compressed as a single frame.
func (p *Pusher) uploadMissingChunks(
	ctx context.Context,
	info nix.PathInfo,
	descs []api.ChunkDesc,
	missing map[string]bool,
) error {
	if len(missing) == 0 {
		return nil
	}
	// SpeedBetterCompression is close to the server's zstd level at a fraction
	// of SpeedBestCompression's CPU; the client's choice is what gets stored
	// for chunked NARs, so don't drop below this without considering ratio.
	enc, err := zstd.NewWriter(nil, zstd.WithEncoderLevel(zstd.SpeedBetterCompression))
	if err != nil {
		return err
	}
	defer func() { _ = enc.Close() }()

	// Compression and PUTs fan out across chunks (bounded, so at most
	// chunkUploadJobs raw chunks are held in memory); the dump/cut/hash pass
	// stays sequential. Content-addressed PUTs are idempotent, and the
	// complete call is only sent after every upload lands.
	uctx, cancel := context.WithCancel(ctx)
	defer cancel()
	sem := make(chan struct{}, chunkUploadJobs)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var uploadErr error
	fail := func(err error) {
		mu.Lock()
		if uploadErr == nil {
			uploadErr = err
			cancel()
		}
		mu.Unlock()
	}

	idx := 0
	sent := make(map[string]bool, len(missing))
	err = p.eachChunk(uctx, info.Path, func(chunk []byte) error {
		if idx >= len(descs) {
			return errors.New("store path changed between passes")
		}
		desc := descs[idx]
		idx++
		sum := sha256.Sum256(chunk)
		if hex.EncodeToString(sum[:]) != desc.Hash {
			return errors.New("store path changed between passes")
		}
		if !missing[desc.Hash] || sent[desc.Hash] {
			return nil
		}
		sent[desc.Hash] = true
		// The chunker reuses its buffer across cuts; copy before handing off.
		owned := bytes.Clone(chunk)
		select {
		case sem <- struct{}{}:
		case <-uctx.Done():
			return context.Cause(uctx)
		}
		wg.Go(func() {
			defer func() { <-sem }()
			if err := p.Client.UploadChunk(
				uctx,
				p.Cache,
				desc.Hash,
				enc.EncodeAll(owned, nil),
			); err != nil {
				fail(fmt.Errorf("uploading chunk %s: %w", desc.Hash[:12], err))
			}
		})
		return nil
	})
	wg.Wait()
	mu.Lock()
	defer mu.Unlock()
	if uploadErr != nil {
		return uploadErr
	}
	if err != nil {
		return err
	}
	if idx != len(descs) {
		return errors.New("store path changed between passes")
	}
	return nil
}

// eachChunk streams the NAR dump through the FastCDC cutter.
func (p *Pusher) eachChunk(ctx context.Context, path string, emit func([]byte) error) error {
	cutter := chunker.New()
	w := &chunkWriter{cutter: cutter, emit: emit}
	if err := nix.DumpPath(ctx, w, path); err != nil {
		return err
	}
	return cutter.Finish(emit)
}

type chunkWriter struct {
	cutter *chunker.Chunker
	emit   func([]byte) error
}

func (w *chunkWriter) Write(p []byte) (int, error) {
	if err := w.cutter.Push(p, w.emit); err != nil {
		return 0, err
	}
	return len(p), nil
}

// FormatBytes renders a byte count with 1024-based units, e.g. "50.0 GiB".
func FormatBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}
