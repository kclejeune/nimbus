// Package api is the HTTP client for the nimbus (attic-compatible) server.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type Client struct {
	endpoint string
	token    string
	hc       *http.Client
}

func New(endpoint, token string) *Client {
	// The default transport keeps only 2 idle connections per host; concurrent
	// path jobs and chunk uploads all target one host, so without this every
	// worker past the second pays a fresh TLS handshake per request.
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConnsPerHost = 16
	return &Client{
		endpoint: strings.TrimRight(endpoint, "/"),
		token:    token,
		// Uploads of large NARs can legitimately take a while.
		hc: &http.Client{Timeout: 30 * time.Minute, Transport: transport},
	}
}

// Error is a non-2xx API response.
type Error struct {
	Status  int
	Message string
	// Requests sent before giving up (>1 when transient retries were burned).
	Attempts int
}

// transientStatus reports whether a status is worth retrying: server-side
// trouble (5xx) or an edge rate limit (429). The single spelling shared by
// the retry loop, Error rendering, and the CLI's exit-code classification.
func transientStatus(code int) bool {
	return code >= 500 || code == http.StatusTooManyRequests
}

// Transient reports server-side/transient failure — retrying may succeed.
func (e *Error) Transient() bool { return transientStatus(e.Status) }

// AuthFailure reports a credential problem (missing, expired, revoked, or
// underprivileged token).
func (e *Error) AuthFailure() bool {
	return e.Status == http.StatusUnauthorized || e.Status == http.StatusForbidden
}

func (e *Error) Error() string {
	msg := e.Message
	if msg == "" {
		msg = http.StatusText(e.Status)
	}
	detail := fmt.Sprintf("HTTP %d", e.Status)
	if e.Attempts > 1 {
		detail += fmt.Sprintf(" after %d attempts", e.Attempts)
	}
	// Classify for the person reading a CI log: was this transient, or is it
	// their token? Message stays untouched — the device flow matches on it.
	switch {
	case e.Transient():
		detail += "; transient — retrying may succeed"
	case e.Status == http.StatusUnauthorized:
		detail += "; token missing, expired, or revoked — check `nimbus whoami`"
	case e.Status == http.StatusForbidden:
		detail += "; token lacks permission"
	}
	return fmt.Sprintf("%s (%s)", msg, detail)
}

// do sends the request, retrying transient failures with jittered backoff:
// 5xx responses (a D1 replica blip, a Workers restart), 429s from the edge
// rate limits (honoring Retry-After), and transport errors short of context
// cancellation (a pooled connection reset by the edge — every endpoint is
// idempotent, so replaying is safe even if the request was partially sent).
// Only replayable bodies retry: NewRequest sets GetBody for in-memory
// readers and UploadPath supplies a re-dump factory; a body without GetBody
// gets a single attempt. Returns the attempt count for error reporting.
func (c *Client) do(req *http.Request) (*http.Response, int, error) {
	replayable := req.Body == nil || req.GetBody != nil
	backoff := 500 * time.Millisecond
	for attempt := 1; ; attempt++ {
		res, err := c.hc.Do(req)
		if !replayable || attempt >= 3 {
			return res, attempt, err
		}
		// Terminal outcomes first: cancellation (other transport errors replay
		// — the request may not have reached the server) and non-transient
		// statuses. What remains is a retry.
		if err != nil && req.Context().Err() != nil {
			return res, attempt, err
		}
		if err == nil && !transientStatus(res.StatusCode) {
			return res, attempt, err
		}
		wait := backoff + rand.N(backoff)
		if err == nil {
			if ra := retryAfter(res); ra > 0 {
				wait = ra
			}
			// Drain (bounded) before closing so the transport sees EOF and can
			// reuse the connection instead of paying a fresh TLS handshake.
			_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 256<<10))
			_ = res.Body.Close()
		}
		if req.GetBody != nil {
			body, err := req.GetBody()
			if err != nil {
				return nil, attempt, err
			}
			req.Body = body
		}
		select {
		case <-req.Context().Done():
			return nil, attempt, req.Context().Err()
		case <-time.After(wait):
		}
		backoff *= 2
	}
}

// retryAfter parses an integer-seconds Retry-After header, capped so a
// misbehaving server cannot stall a push.
func retryAfter(res *http.Response) time.Duration {
	secs, err := strconv.Atoi(res.Header.Get("Retry-After"))
	if err != nil || secs <= 0 {
		return 0
	}
	return min(time.Duration(secs)*time.Second, 30*time.Second)
}

func (c *Client) newRequest(
	ctx context.Context,
	method, path string,
	body io.Reader,
) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.endpoint+path, body)
	if err != nil {
		return nil, err
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	return req, nil
}

func decodeOrError(res *http.Response, out any, attempts int) error {
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		// The server's error shape is {code, error: <kind>, message: <detail>};
		// prefer the human-readable message, falling back to the kind (which is
		// also where bare device-flow codes like authorization_pending live).
		var apiErr struct {
			Error   string `json:"error"`
			Message string `json:"message"`
		}
		data, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		message := strings.TrimSpace(string(data))
		if json.Unmarshal(data, &apiErr) == nil {
			switch {
			case apiErr.Message != "":
				message = apiErr.Message
			case apiErr.Error != "":
				message = apiErr.Error
			}
		} else if message != "" {
			// Non-JSON bodies are edge interstitials (Cloudflare HTML error
			// pages): keep the first line, bounded, not 4 KiB of markup.
			message, _, _ = strings.Cut(message, "\n")
			if len(message) > 200 {
				message = message[:200] + "…"
			}
		}
		return &Error{Status: res.StatusCode, Message: message, Attempts: attempts}
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, res.Body)
		return nil
	}
	return json.NewDecoder(res.Body).Decode(out)
}

func (c *Client) doJSON(ctx context.Context, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}
	req, err := c.newRequest(ctx, method, path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, attempts, err := c.do(req)
	if err != nil {
		return err
	}
	return decodeOrError(res, out, attempts)
}

// CacheInfo is the public cache discovery document (attic-cache-info).
type CacheInfo struct {
	SubstituterEndpoint string `json:"substituter_endpoint"`
	APIEndpoint         string `json:"api_endpoint"`
	PublicKey           string `json:"public_key"`
	IsPublic            bool   `json:"is_public"`
	StoreDir            string `json:"store_dir"`
	Priority            int    `json:"priority"`
	Compression         string `json:"compression"`
}

func (c *Client) GetCacheInfo(ctx context.Context, cache string) (*CacheInfo, error) {
	info := &CacheInfo{}
	if err := c.doJSON(ctx, http.MethodGet, "/"+cache+"/attic-cache-info", nil, info); err != nil {
		return nil, err
	}
	return info, nil
}

func (c *Client) GetMissingPaths(
	ctx context.Context,
	cache string,
	hashes []string,
	ignoreUpstreamFilter bool,
) ([]string, error) {
	var out struct {
		MissingPaths []string `json:"missing_paths"`
	}
	body := map[string]any{"cache": cache, "store_path_hashes": hashes}
	if ignoreUpstreamFilter {
		body["ignore_upstream_cache_filter"] = true
	}
	if err := c.doJSON(ctx, http.MethodPost, "/_api/v1/get-missing-paths", body, &out); err != nil {
		return nil, err
	}
	return out.MissingPaths, nil
}

// NarInfo describes an upload, matching the server's UploadNarInfo shape.
type NarInfo struct {
	Cache         string   `json:"cache"`
	StorePathHash string   `json:"store_path_hash"`
	StorePath     string   `json:"store_path"`
	References    []string `json:"references"`
	System        *string  `json:"system"`
	Deriver       *string  `json:"deriver"`
	Sigs          []string `json:"sigs"`
	CA            *string  `json:"ca"`
	NarHash       string   `json:"nar_hash"`
}

type UploadResult struct {
	Kind             string   `json:"kind"`
	FileSize         *int64   `json:"file_size"`
	FracDeduplicated *float64 `json:"frac_deduplicated"`
}

// UploadPath uploads a raw NAR with the metadata in the X-Attic-Nar-Info
// header. nar returns a fresh NAR stream per call — it seeds the request body
// and serves as GetBody so do's 5xx retry can replay the upload. size must be
// the exact NAR size so the server can pick its buffered/streaming strategy.
func (c *Client) UploadPath(
	ctx context.Context,
	info *NarInfo,
	nar func() (io.ReadCloser, error),
	size int64,
) (*UploadResult, error) {
	header, err := json.Marshal(info)
	if err != nil {
		return nil, err
	}
	body, err := nar()
	if err != nil {
		return nil, err
	}
	req, err := c.newRequest(ctx, http.MethodPut, "/_api/v1/upload-path", body)
	if err != nil {
		_ = body.Close()
		return nil, err
	}
	req.GetBody = nar
	req.Header.Set("X-Attic-Nar-Info", string(header))
	req.Header.Set("Content-Type", "application/octet-stream")
	req.ContentLength = size

	res, attempts, err := c.do(req)
	if err != nil {
		return nil, err
	}
	result := &UploadResult{}
	if err := decodeOrError(res, result, attempts); err != nil {
		return nil, err
	}
	return result, nil
}

// ChunkDesc describes one CDC chunk: raw sha256 hex and uncompressed size.
type ChunkDesc struct {
	Hash string `json:"hash"`
	Size int64  `json:"size"`
}

type cdcManifest struct {
	NarInfo *NarInfo    `json:"nar_info"`
	NarSize int64       `json:"nar_size"`
	Chunks  []ChunkDesc `json:"chunks"`
}

// ChunkQueryResult is the server's answer to a chunk manifest: either the
// whole NAR deduplicated, or the subset of chunk hashes it lacks.
type ChunkQueryResult struct {
	Kind               string   `json:"kind"`
	MissingChunkHashes []string `json:"missing_chunk_hashes"`
}

// QueryChunks reports which of the NAR's chunks the server is missing,
// deduplicating the whole NAR when it already exists.
func (c *Client) QueryChunks(
	ctx context.Context,
	info *NarInfo,
	narSize int64,
	chunks []ChunkDesc,
) (*ChunkQueryResult, error) {
	out := &ChunkQueryResult{}
	body := cdcManifest{NarInfo: info, NarSize: narSize, Chunks: chunks}
	if err := c.doJSON(ctx, http.MethodPost, "/_api/v1/upload-path/chunks", body, out); err != nil {
		return nil, err
	}
	return out, nil
}

// UploadChunk stores one zstd-compressed chunk under its raw-content hash.
func (c *Client) UploadChunk(ctx context.Context, cache, hash string, data []byte) error {
	req, err := c.newRequest(
		ctx,
		http.MethodPut,
		"/_api/v1/upload-path/chunks/"+hash+"?cache="+url.QueryEscape(cache),
		bytes.NewReader(data),
	)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	res, attempts, err := c.do(req)
	if err != nil {
		return err
	}
	return decodeOrError(res, nil, attempts)
}

// CompleteChunks assembles the NAR from its chunk references. When the server
// lost chunks in the meantime (HTTP 409) it returns their hashes with a nil
// result so the caller can re-upload and retry.
func (c *Client) CompleteChunks(
	ctx context.Context,
	info *NarInfo,
	narSize int64,
	chunks []ChunkDesc,
) (*UploadResult, []string, error) {
	data, err := json.Marshal(cdcManifest{NarInfo: info, NarSize: narSize, Chunks: chunks})
	if err != nil {
		return nil, nil, err
	}
	req, err := c.newRequest(
		ctx,
		http.MethodPost,
		"/_api/v1/upload-path/chunks/complete",
		bytes.NewReader(data),
	)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, attempts, err := c.do(req)
	if err != nil {
		return nil, nil, err
	}
	if res.StatusCode == http.StatusConflict {
		var out struct {
			MissingChunkHashes []string `json:"missing_chunk_hashes"`
		}
		err := json.NewDecoder(res.Body).Decode(&out)
		_ = res.Body.Close()
		if err != nil {
			return nil, nil, err
		}
		return nil, out.MissingChunkHashes, nil
	}
	result := &UploadResult{}
	if err := decodeOrError(res, result, attempts); err != nil {
		return nil, nil, err
	}
	return result, nil, nil
}

// Cache create/configure bodies are open maps so retention_period can be an
// explicit JSON null (present = clear, absent = unchanged).
func (c *Client) CreateCache(
	ctx context.Context,
	name string,
	opts map[string]any,
) (publicKey string, err error) {
	var out struct {
		PublicKey string `json:"public_key"`
	}
	if err := c.doJSON(
		ctx,
		http.MethodPost,
		"/_api/v1/cache-config/"+name,
		opts,
		&out,
	); err != nil {
		return "", err
	}
	return out.PublicKey, nil
}

func (c *Client) ConfigureCache(
	ctx context.Context,
	name string,
	opts map[string]any,
) (publicKey string, err error) {
	var out struct {
		PublicKey string `json:"public_key"`
	}
	if err := c.doJSON(
		ctx,
		http.MethodPatch,
		"/_api/v1/cache-config/"+name,
		opts,
		&out,
	); err != nil {
		return "", err
	}
	return out.PublicKey, nil
}

func (c *Client) DestroyCache(ctx context.Context, name string) error {
	return c.doJSON(ctx, http.MethodDelete, "/_api/v1/cache-config/"+name, nil, nil)
}

func (c *Client) RenameCache(ctx context.Context, name, newName string) error {
	body := map[string]string{"new_name": newName}
	return c.doJSON(ctx, http.MethodPost, "/_api/v1/cache-config/"+name+"/rename", body, nil)
}

// PinPath marks a store path's closure as a GC root.
func (c *Client) PinPath(ctx context.Context, cache, storePathHash, note string) error {
	body := map[string]any{"store_path_hash": storePathHash}
	if note != "" {
		body["note"] = note
	}
	return c.doJSON(ctx, http.MethodPost, "/_api/v1/gc-root/"+cache, body, nil)
}

// UnpinPath removes a GC root.
func (c *Client) UnpinPath(ctx context.Context, cache, storePathHash string) error {
	return c.doJSON(ctx, http.MethodDelete, "/_api/v1/gc-root/"+cache+"/"+storePathHash, nil, nil)
}

// PinNamed creates or re-points a named pin (cachix-style): re-pinning the
// name adds a revision. keepRevisions/keepDays of 0 leave the pin's current
// retention settings unchanged.
func (c *Client) PinNamed(
	ctx context.Context,
	cache, name, storePathHash string,
	keepRevisions, keepDays int,
	note string,
) error {
	body := map[string]any{"name": name, "store_path_hash": storePathHash}
	if keepRevisions > 0 {
		body["keep_revisions"] = keepRevisions
	}
	if keepDays > 0 {
		body["keep_days"] = keepDays
	}
	if note != "" {
		body["note"] = note
	}
	return c.doJSON(ctx, http.MethodPost, "/_api/v1/pin/"+cache, body, nil)
}

// PinRevision is one entry of a named pin's history, newest first.
type PinRevision struct {
	Hash      string  `json:"hash"`
	CreatedAt string  `json:"createdAt"`
	Note      *string `json:"note"`
}

// Pin mirrors the server's PinInfo listing shape.
type Pin struct {
	Name          string        `json:"name"`
	KeepRevisions *int          `json:"keepRevisions"`
	KeepDays      *int          `json:"keepDays"`
	Revisions     []PinRevision `json:"revisions"`
}

// ListPins returns the cache's pins with their revision histories.
func (c *Client) ListPins(ctx context.Context, cache string) ([]Pin, error) {
	var out struct {
		Pins []Pin `json:"pins"`
	}
	if err := c.doJSON(ctx, http.MethodGet, "/_api/v1/pin/"+cache, nil, &out); err != nil {
		return nil, err
	}
	return out.Pins, nil
}

// UnpinNamed removes a named pin and all its revisions.
func (c *Client) UnpinNamed(ctx context.Context, cache, name string) error {
	return c.doJSON(
		ctx,
		http.MethodDelete,
		"/_api/v1/pin/"+cache+"/"+url.PathEscape(name),
		nil,
		nil,
	)
}

// CachePermissions is the caller's effective access to a listed cache.
type CachePermissions struct {
	Pull                    bool `json:"pull"`
	Push                    bool `json:"push"`
	Delete                  bool `json:"delete"`
	ConfigureCache          bool `json:"configure_cache"`
	ConfigureCacheRetention bool `json:"configure_cache_retention"`
	DestroyCache            bool `json:"destroy_cache"`
}

// CacheListEntry is one row of the server's cache listing.
type CacheListEntry struct {
	Name        string `json:"name"`
	Public      bool   `json:"public"`
	Priority    int    `json:"priority"`
	Compression string `json:"compression"`
	// RetentionPeriod is in days; nil means no age-based retention.
	RetentionPeriod *int64 `json:"retention_period"`
	// RetentionMaxBytes caps compressed storage; nil means no size budget.
	RetentionMaxBytes *int64           `json:"retention_max_bytes"`
	Permissions       CachePermissions `json:"permissions"`
}

// ListCaches returns the caches the caller may discover: public ones plus,
// when a token is configured, any it carries an explicit bit for.
func (c *Client) ListCaches(ctx context.Context) ([]CacheListEntry, error) {
	var out struct {
		Caches []CacheListEntry `json:"caches"`
	}
	if err := c.doJSON(ctx, http.MethodGet, "/_api/v1/caches", nil, &out); err != nil {
		return nil, err
	}
	return out.Caches, nil
}

// TokenCreateRequest asks the server to mint a scoped API token. Permissions
// take the server's form-field names: pull, push, delete, configure_cache,
// destroy_cache. GC and CT are the admin-only server-wide claims.
type TokenCreateRequest struct {
	Name        string   `json:"name"`
	Cache       string   `json:"cache,omitempty"`
	Permissions []string `json:"permissions,omitempty"`
	GC          bool     `json:"gc,omitempty"`
	CT          bool     `json:"ct,omitempty"`
	ExpiryDays  int      `json:"expiry_days,omitempty"`
}

// CreatedToken carries the plaintext JWT, which the server shows only once.
type CreatedToken struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Token     string `json:"token"`
	ExpiresAt int64  `json:"expires_at"`
}

func (c *Client) CreateToken(
	ctx context.Context,
	req *TokenCreateRequest,
) (*CreatedToken, error) {
	created := &CreatedToken{}
	if err := c.doJSON(ctx, http.MethodPost, "/_api/v1/tokens", req, created); err != nil {
		return nil, err
	}
	return created, nil
}

// TokenInfo is one issued token as presented by the server (plaintext is
// never available after minting). Scope is the JSON-encoded snapshot of the
// token's cache access, {pattern: {bit: 1, ...}}.
type TokenInfo struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Scope     string `json:"scope"`
	CreatedAt int64  `json:"createdAt"`
	ExpiresAt *int64 `json:"expiresAt"`
	Status    string `json:"status"` // active | expired | revoked
}

// ListTokens returns the tokens issued to the calling token's user.
func (c *Client) ListTokens(ctx context.Context) ([]TokenInfo, error) {
	var out struct {
		Tokens []TokenInfo `json:"tokens"`
	}
	if err := c.doJSON(ctx, http.MethodGet, "/_api/v1/tokens", nil, &out); err != nil {
		return nil, err
	}
	return out.Tokens, nil
}

// RevokeToken revokes one of the calling user's tokens by id.
func (c *Client) RevokeToken(ctx context.Context, id string) error {
	return c.doJSON(
		ctx,
		http.MethodDelete,
		"/_api/v1/tokens/"+url.PathEscape(id),
		nil,
		nil,
	)
}

// DestroyPathResult reports a per-path removal: detached is how many closure
// members stopped anchoring retention, reaped how many became unreachable and
// were deleted outright.
type DestroyPathResult struct {
	Destroyed string `json:"destroyed"`
	Detached  int    `json:"detached"`
	Reaped    int    `json:"reaped"`
}

// DestroyPath removes a store path from a cache. The server is closure-safe:
// dependencies shared with other paths survive until their last dependent is
// removed.
func (c *Client) DestroyPath(
	ctx context.Context,
	cache, storePathHash string,
) (*DestroyPathResult, error) {
	result := &DestroyPathResult{}
	if err := c.doJSON(
		ctx,
		http.MethodDelete,
		"/_api/v1/path/"+cache+"/"+storePathHash,
		nil,
		result,
	); err != nil {
		return nil, err
	}
	return result, nil
}

// RunGc triggers a server-side garbage collection pass and returns the
// server's stats object verbatim.
func (c *Client) RunGc(ctx context.Context, dryRun bool) (map[string]any, error) {
	path := "/_api/v1/gc"
	if dryRun {
		path += "?dry_run=1"
	}
	stats := map[string]any{}
	if err := c.doJSON(ctx, http.MethodPost, path, nil, &stats); err != nil {
		return nil, err
	}
	return stats, nil
}

// AuthConfig is the public login discovery document.
type AuthConfig struct {
	AuthorizeURL          string `json:"authorize_url"`
	DeviceVerificationURL string `json:"device_verification_url"`
}

func (c *Client) GetAuthConfig(ctx context.Context) (*AuthConfig, error) {
	cfg := &AuthConfig{}
	if err := c.doJSON(ctx, http.MethodGet, "/_api/v1/auth-config", nil, cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}

// DeviceGrant is the RFC 8628 device-authorization response.
type DeviceGrant struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	Interval                int    `json:"interval"`
	ExpiresIn               int    `json:"expires_in"`
}

func (c *Client) StartDeviceAuth(ctx context.Context) (*DeviceGrant, error) {
	grant := &DeviceGrant{}
	if err := c.doJSON(ctx, http.MethodPost, "/_api/v1/cli/device", nil, grant); err != nil {
		return nil, err
	}
	return grant, nil
}

// PollDeviceToken returns the token once approved; empty while pending.
func (c *Client) PollDeviceToken(ctx context.Context, deviceCode string) (string, error) {
	var out struct {
		Token string `json:"token"`
		Error string `json:"error"`
	}
	body := map[string]string{"device_code": deviceCode}
	err := c.doJSON(ctx, http.MethodPost, "/_api/v1/cli/token", body, &out)
	if err != nil {
		var apiErr *Error
		// Device-flow signals come back as HTTP 400 with an error code.
		if errors.As(err, &apiErr) {
			switch apiErr.Message {
			case "authorization_pending":
				return "", nil
			case "access_denied":
				return "", errors.New("authorization denied")
			case "expired_token":
				return "", errors.New("device code expired; try again")
			}
		}
		return "", err
	}
	return out.Token, nil
}
