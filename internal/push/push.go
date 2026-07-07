// Package push uploads store path closures to a nimbus cache.
package push

import (
	"context"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/klauspost/compress/zstd"

	"github.com/kclejeune/nimbus/internal/api"
	"github.com/kclejeune/nimbus/internal/nix"
)

// Above this NAR size the chunked protocol is used: the client compresses
// with zstd and uploads fixed-size parts, matching the attic client.
const chunkedThreshold = 100 * 1024 * 1024

type Pusher struct {
	Client *api.Client
	Cache  string
	Jobs   int
	Out    io.Writer
	// SkipInvalid tolerates paths missing from the local store: they are
	// always skipped (never fail the batch), but without SkipInvalid their
	// presence makes Push return an error after the valid paths upload.
	SkipInvalid bool
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
			fmt.Fprintf(p.Out, "%s: skipping %s: not valid in the local store\n", level, m)
		}
	}
	if len(paths) == 0 {
		if invalidErr != nil {
			return invalidErr
		}
		fmt.Fprintln(p.Out, "nothing to push")
		return nil
	}

	infos, err := nix.ClosurePathInfo(ctx, paths)
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

	missing, err := p.Client.GetMissingPaths(ctx, p.Cache, hashes)
	if err != nil {
		return fmt.Errorf("get-missing-paths: %w", err)
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
	var firstErr error

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	for range jobs {
		wg.Go(func() {
			for info := range queue {
				if err := p.uploadOne(ctx, info); err != nil {
					mu.Lock()
					if firstErr == nil {
						firstErr = fmt.Errorf("%s: %w", nix.BaseName(info.Path), err)
						cancel()
					}
					mu.Unlock()
					return
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
	if firstErr != nil {
		return firstErr
	}
	return invalidErr
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
	suffix := fmt.Sprintf("(%s/s)", formatBytes(int64(speed)))
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

// uploadSimple streams the raw NAR; the server compresses.
func (p *Pusher) uploadSimple(ctx context.Context, info nix.PathInfo) (*api.UploadResult, error) {
	pr, pw := io.Pipe()
	go func() {
		pw.CloseWithError(nix.DumpPath(ctx, pw, info.Path))
	}()
	result, err := p.Client.UploadPath(ctx, p.narInfo(info), pr, info.NarSize)
	pr.CloseWithError(err)
	return result, err
}

// uploadChunked compresses client-side with zstd and uploads sequential
// fixed-size parts under an opaque server-issued token.
func (p *Pusher) uploadChunked(ctx context.Context, info nix.PathInfo) (*api.UploadResult, error) {
	upload, err := p.Client.StartChunkedUpload(ctx, p.narInfo(info), info.NarSize)
	if err != nil {
		return nil, err
	}
	if upload.Token == "" {
		// Deduplicated at start: the server answered with an upload result.
		return &api.UploadResult{Kind: "deduplicated"}, nil
	}

	pr, pw := io.Pipe()
	go func() {
		zw, err := zstd.NewWriter(pw)
		if err != nil {
			pw.CloseWithError(err)
			return
		}
		if err := nix.DumpPath(ctx, zw, info.Path); err != nil {
			pw.CloseWithError(err)
			return
		}
		pw.CloseWithError(zw.Close())
	}()

	buf := make([]byte, upload.ChunkSize)
	for part := 1; ; part++ {
		n, err := io.ReadFull(pr, buf)
		if n > 0 {
			if err := p.Client.UploadChunk(ctx, upload.Token, part, buf[:n]); err != nil {
				pr.CloseWithError(err)
				return nil, err
			}
		}
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			break
		}
		if err != nil {
			return nil, err
		}
	}

	return p.Client.CompleteChunkedUpload(ctx, upload.Token)
}

func formatBytes(n int64) string {
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
