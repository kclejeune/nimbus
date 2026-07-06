// Package nix queries the local Nix store via the nix CLI and streams NARs.
package nix

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"path"
	"strings"
)

const StoreDir = "/nix/store"

// PathInfo is the metadata needed to upload one store path.
type PathInfo struct {
	Path string
	// NarHash as "sha256:<64 hex chars>".
	NarHash string
	NarSize int64
	// References as store path base names.
	References []string
	// Deriver base name, or empty.
	Deriver string
	Sigs    []string
	CA      string
}

// BaseName strips the store dir: /nix/store/<hash>-name -> <hash>-name.
func BaseName(storePath string) string {
	return path.Base(storePath)
}

// HashPart returns the 32-character store path hash.
func HashPart(storePath string) string {
	base := BaseName(storePath)
	if len(base) < 32 {
		return base
	}
	return base[:32]
}

// rawPathInfo tolerates both `nix path-info --json` output shapes: an array
// of objects with a "path" field (older) or an object keyed by path (newer).
type rawPathInfo struct {
	Path       string   `json:"path"`
	NarHash    string   `json:"narHash"`
	NarSize    int64    `json:"narSize"`
	References []string `json:"references"`
	Deriver    *string  `json:"deriver"`
	Signatures []string `json:"signatures"`
	CA         *string  `json:"ca"`
	Valid      *bool    `json:"valid"`
}

// ClosurePathInfo returns metadata for the full closure of the given paths.
func ClosurePathInfo(ctx context.Context, paths []string) ([]PathInfo, error) {
	return queryPathInfo(ctx, paths, true)
}

// PathInfoFor returns metadata for exactly the given paths (no closure).
func PathInfoFor(ctx context.Context, paths []string) ([]PathInfo, error) {
	return queryPathInfo(ctx, paths, false)
}

func queryPathInfo(ctx context.Context, paths []string, recursive bool) ([]PathInfo, error) {
	args := []string{"path-info", "--json"}
	if recursive {
		args = append(args, "--recursive")
	}
	args = append(args, paths...)

	cmd := exec.CommandContext(ctx, "nix", args...)
	out, err := cmd.Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return nil, fmt.Errorf("nix path-info: %s", strings.TrimSpace(string(ee.Stderr)))
		}
		return nil, fmt.Errorf("nix path-info: %w", err)
	}

	var raws []rawPathInfo
	var asArray []rawPathInfo
	if err := json.Unmarshal(out, &asArray); err == nil {
		raws = asArray
	} else {
		var asMap map[string]rawPathInfo
		if err := json.Unmarshal(out, &asMap); err != nil {
			return nil, fmt.Errorf("parsing nix path-info output: %w", err)
		}
		for p, raw := range asMap {
			raw.Path = p
			raws = append(raws, raw)
		}
	}

	infos := make([]PathInfo, 0, len(raws))
	for _, raw := range raws {
		if raw.Valid != nil && !*raw.Valid {
			return nil, fmt.Errorf("path is not valid in the local store: %s", raw.Path)
		}
		narHash, err := normalizeNarHash(raw.NarHash)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", raw.Path, err)
		}
		info := PathInfo{
			Path:    raw.Path,
			NarHash: narHash,
			NarSize: raw.NarSize,
			Sigs:    raw.Signatures,
		}
		for _, ref := range raw.References {
			info.References = append(info.References, BaseName(ref))
		}
		if raw.Deriver != nil && *raw.Deriver != "" && *raw.Deriver != "unknown-deriver" {
			info.Deriver = BaseName(*raw.Deriver)
		}
		if raw.CA != nil {
			info.CA = *raw.CA
		}
		infos = append(infos, info)
	}
	return infos, nil
}

// DumpPath streams the NAR serialization of a store path to w via
// `nix-store --dump`. Deferring to Nix guarantees the bytes match the narHash
// that `nix path-info` reported; go-nix's writer miscounts entries whose names
// start with ".." (e.g. Mercurial's bin/..hg-wrapped-wrapped).
func DumpPath(ctx context.Context, w io.Writer, storePath string) error {
	cmd := exec.CommandContext(ctx, "nix-store", "--dump", storePath)
	cmd.Stdout = w
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return fmt.Errorf("nix-store --dump %s: %s", storePath, msg)
		}
		return fmt.Errorf("nix-store --dump %s: %w", storePath, err)
	}
	return nil
}

// normalizeNarHash converts SRI ("sha256-<base64>"), base32
// ("sha256:<52 chars>"), or hex ("sha256:<64 hex>") to "sha256:<64 hex>".
func normalizeNarHash(hash string) (string, error) {
	if rest, ok := strings.CutPrefix(hash, "sha256-"); ok {
		raw, err := base64.StdEncoding.DecodeString(rest)
		if err != nil || len(raw) != 32 {
			return "", fmt.Errorf("invalid SRI nar hash %q", hash)
		}
		return "sha256:" + hex.EncodeToString(raw), nil
	}
	if rest, ok := strings.CutPrefix(hash, "sha256:"); ok {
		switch len(rest) {
		case 64:
			return hash, nil
		case 52:
			raw, err := decodeNixBase32(rest)
			if err != nil {
				return "", fmt.Errorf("invalid base32 nar hash %q: %w", hash, err)
			}
			return "sha256:" + hex.EncodeToString(raw), nil
		}
	}
	return "", fmt.Errorf("unsupported nar hash format %q", hash)
}

const nixBase32Alphabet = "0123456789abcdfghijklmnpqrsvwxyz"

// decodeNixBase32 reverses Nix's base32: digits are emitted most-significant
// first over the little-endian byte string.
func decodeNixBase32(s string) ([]byte, error) {
	out := make([]byte, len(s)*5/8)
	for n := 0; n < len(s); n++ {
		c := s[len(s)-1-n]
		digit := strings.IndexByte(nixBase32Alphabet, c)
		if digit < 0 {
			return nil, fmt.Errorf("invalid character %q", c)
		}
		b := n * 5
		i := b / 8
		j := b % 8
		out[i] |= byte(digit << j)
		if rem := digit >> (8 - j); rem != 0 {
			if i+1 >= len(out) {
				return nil, fmt.Errorf("invalid trailing bits")
			}
			out[i+1] |= byte(rem)
		}
	}
	return out, nil
}
