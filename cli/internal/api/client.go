// Package api is the HTTP client for the nimbus (attic-compatible) server.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
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
	return &Client{
		endpoint: strings.TrimRight(endpoint, "/"),
		token:    token,
		// Uploads of large NARs can legitimately take a while.
		hc: &http.Client{Timeout: 30 * time.Minute},
	}
}

// Error is a non-2xx API response.
type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string {
	return fmt.Sprintf("%s (HTTP %d)", e.Message, e.Status)
}

func (c *Client) newRequest(ctx context.Context, method, path string, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.endpoint+path, body)
	if err != nil {
		return nil, err
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	return req, nil
}

func decodeOrError(res *http.Response, out any) error {
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		var apiErr struct {
			Error string `json:"error"`
		}
		data, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		message := strings.TrimSpace(string(data))
		if json.Unmarshal(data, &apiErr) == nil && apiErr.Error != "" {
			message = apiErr.Error
		}
		return &Error{Status: res.StatusCode, Message: message}
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
	res, err := c.hc.Do(req)
	if err != nil {
		return err
	}
	return decodeOrError(res, out)
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

func (c *Client) GetMissingPaths(ctx context.Context, cache string, hashes []string) ([]string, error) {
	var out struct {
		MissingPaths []string `json:"missing_paths"`
	}
	body := map[string]any{"cache": cache, "store_path_hashes": hashes}
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
// header. size must be the exact NAR size so the server can pick its
// buffered/streaming strategy.
func (c *Client) UploadPath(ctx context.Context, info *NarInfo, nar io.Reader, size int64) (*UploadResult, error) {
	header, err := json.Marshal(info)
	if err != nil {
		return nil, err
	}
	req, err := c.newRequest(ctx, http.MethodPut, "/_api/v1/upload-path", nar)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Attic-Nar-Info", string(header))
	req.Header.Set("Content-Type", "application/octet-stream")
	req.ContentLength = size

	res, err := c.hc.Do(req)
	if err != nil {
		return nil, err
	}
	result := &UploadResult{}
	if err := decodeOrError(res, result); err != nil {
		return nil, err
	}
	return result, nil
}

type ChunkedUpload struct {
	Token     string `json:"upload_token"`
	ChunkSize int64  `json:"chunk_size"`
}

func (c *Client) StartChunkedUpload(ctx context.Context, info *NarInfo, narSize int64) (*ChunkedUpload, error) {
	out := &ChunkedUpload{}
	body := map[string]any{"nar_info": info, "nar_size": narSize}
	if err := c.doJSON(ctx, http.MethodPost, "/_api/v1/upload-path/start", body, out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) UploadChunk(ctx context.Context, token string, part int, data []byte) error {
	req, err := c.newRequest(ctx, http.MethodPut, "/_api/v1/upload-path/chunk", bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("X-Upload-Token", token)
	req.Header.Set("X-Part-Number", strconv.Itoa(part))
	req.Header.Set("Content-Type", "application/octet-stream")
	res, err := c.hc.Do(req)
	if err != nil {
		return err
	}
	return decodeOrError(res, nil)
}

func (c *Client) CompleteChunkedUpload(ctx context.Context, token string) (*UploadResult, error) {
	result := &UploadResult{}
	body := map[string]any{"upload_token": token}
	if err := c.doJSON(ctx, http.MethodPost, "/_api/v1/upload-path/complete", body, result); err != nil {
		return nil, err
	}
	return result, nil
}

// Cache create/configure bodies are open maps so retention_period can be an
// explicit JSON null (present = clear, absent = unchanged).
func (c *Client) CreateCache(ctx context.Context, name string, opts map[string]any) (publicKey string, err error) {
	var out struct {
		PublicKey string `json:"public_key"`
	}
	if err := c.doJSON(ctx, http.MethodPost, "/_api/v1/cache-config/"+name, opts, &out); err != nil {
		return "", err
	}
	return out.PublicKey, nil
}

func (c *Client) ConfigureCache(ctx context.Context, name string, opts map[string]any) (publicKey string, err error) {
	var out struct {
		PublicKey string `json:"public_key"`
	}
	if err := c.doJSON(ctx, http.MethodPatch, "/_api/v1/cache-config/"+name, opts, &out); err != nil {
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
