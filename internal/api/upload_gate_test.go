package api

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

type observedBody struct {
	io.Reader
	closed bool
}

func (b *observedBody) Close() error { b.closed = true; return nil }

func uploadResponse(req *http.Request, status int) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     make(http.Header),
		Body:       http.NoBody,
		Request:    req,
	}
}

func TestUploadRequestsShareAConcurrencyCap(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var active, peak, calls atomic.Int32
		release := make(chan struct{})
		c := New("https://cache.test/prefix", "")
		c.hc.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
			calls.Add(1)
			n := active.Add(1)
			for old := peak.Load(); n > old && !peak.CompareAndSwap(old, n); old = peak.Load() {
			}
			<-release
			active.Add(-1)
			return uploadResponse(req, 200), nil
		})
		var jobs sync.WaitGroup
		for range 24 {
			jobs.Go(func() {
				req, _ := c.newRequest(
					t.Context(),
					http.MethodPut,
					"/_api/v1/upload-path/chunks/hash",
					nil,
				)
				res, _, err := c.do(req)
				if err != nil {
					t.Error(err)
					return
				}
				_ = res.Body.Close()
			})
		}
		synctest.Wait()
		if calls.Load() != maxUploadRequests {
			t.Fatalf("sent %d requests before capacity was released", calls.Load())
		}
		close(release)
		jobs.Wait()
		if calls.Load() != 24 || peak.Load() > maxUploadRequests || active.Load() != 0 {
			t.Fatalf("calls=%d peak=%d active=%d", calls.Load(), peak.Load(), active.Load())
		}
	})
}

func TestOverloadPausesQueuedUploadsAndTheRetry(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls atomic.Int32
		fail := make(chan struct{})
		healthy := make(chan struct{})
		start := time.Now()
		c := New("https://cache.test", "")
		c.hc.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
			n := calls.Add(1)
			if n == 1 {
				<-fail
				res := uploadResponse(req, 503)
				res.Header.Set("Retry-After", "2")
				return res, nil
			}
			if n <= maxUploadRequests {
				<-healthy
			} else if time.Since(start) < 2*time.Second {
				t.Error("queued upload ignored another request's Retry-After")
			}
			return uploadResponse(req, 200), nil
		})
		var jobs sync.WaitGroup
		for range maxUploadRequests + 1 {
			jobs.Go(func() {
				req, _ := c.newRequest(t.Context(), http.MethodPut, "/_api/v1/upload-path", nil)
				res, _, err := c.do(req)
				if err != nil {
					t.Error(err)
					return
				}
				_ = res.Body.Close()
			})
		}
		synctest.Wait()
		close(fail)
		synctest.Wait()
		close(healthy)
		time.Sleep(2*time.Second - time.Nanosecond)
		synctest.Wait()
		if calls.Load() != maxUploadRequests {
			t.Fatalf("sent %d requests during cooldown", calls.Load())
		}
		jobs.Wait()
		if calls.Load() != maxUploadRequests+2 {
			t.Fatalf("expected one retry and one queued upload, got %d calls", calls.Load())
		}
	})
}

func TestUploadPressureDoesNotBlockControlRequestsOrLeakCancelledWaiters(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c := New("https://cache.test", "")
		calls := 0
		c.hc.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
			calls++
			return uploadResponse(req, 200), nil
		})
		for range maxUploadRequests {
			if err := c.uploads.acquire(t.Context()); err != nil {
				t.Fatal(err)
			}
		}
		ctx, cancel := context.WithCancel(t.Context())
		done := make(chan error, 1)
		body := &observedBody{Reader: strings.NewReader("payload")}
		go func() {
			req, _ := c.newRequest(ctx, http.MethodPut, "/_api/v1/upload-path/chunks/hash", body)
			_, _, err := c.do(req)
			done <- err
		}()
		synctest.Wait()
		req, _ := c.newRequest(t.Context(), http.MethodGet, "/_api/v1/cache-config/test", nil)
		res, _, err := c.do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		cancel()
		if err := <-done; !errors.Is(err, context.Canceled) {
			t.Fatalf("queued error=%v", err)
		}
		if !body.closed {
			t.Error("cancelled queued request leaked its body")
		}
		if calls != 1 || c.uploads.active != maxUploadRequests {
			t.Fatalf("calls=%d active=%d", calls, c.uploads.active)
		}
		for range maxUploadRequests {
			c.uploads.finish(200, 0)
		}
	})
}

func TestUploadRetryDoesNotOpenItsBodyBeforeSharedAdmission(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c := New("https://cache.test", "")
		c.hc.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
			res := uploadResponse(req, 503)
			res.Header.Set("Retry-After", "1")
			return res, nil
		})
		ctx, cancel := context.WithCancel(t.Context())
		req, _ := c.newRequest(ctx, http.MethodPut, "/_api/v1/upload-path", nil)
		opened := 0
		req.GetBody = func() (io.ReadCloser, error) { opened++; return http.NoBody, nil }
		done := make(chan error, 1)
		go func() { _, _, err := c.do(req); done <- err }()
		synctest.Wait()
		// A different request extends pressure after this retry starts waiting.
		c.uploads.backoff(time.Minute)
		time.Sleep(2 * time.Second)
		synctest.Wait()
		if opened != 0 {
			t.Error("body producer started while upload admission was blocked")
		}
		cancel()
		if err := <-done; !errors.Is(err, context.Canceled) {
			t.Fatalf("retry error=%v", err)
		}
	})
}

func TestFinalPressureResponseStillPausesUploads(t *testing.T) {
	for _, first := range []struct{ method, path string }{
		{http.MethodPut, "/_api/v1/upload-path"},
		{http.MethodGet, "/_api/v1/cache-config/test"},
	} {
		t.Run(first.path, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				c := New("https://cache.test", "")
				calls := 0
				lastFailure := time.Time{}
				c.hc.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
					calls++
					if calls <= 3 {
						lastFailure = time.Now()
						res := uploadResponse(req, 503)
						res.Header.Set("Retry-After", "2")
						return res, nil
					}
					if time.Since(lastFailure) < 2*time.Second {
						t.Error("final failure did not pause the next upload")
					}
					return uploadResponse(req, 200), nil
				})
				req, _ := c.newRequest(t.Context(), first.method, first.path, nil)
				res, attempts, err := c.do(req)
				if err != nil || attempts != 3 || res.StatusCode != 503 {
					t.Fatalf("attempts=%d response=%v error=%v", attempts, res, err)
				}
				_ = res.Body.Close()
				req, _ = c.newRequest(t.Context(), http.MethodPut, "/_api/v1/upload-path", nil)
				res, _, err = c.do(req)
				if err != nil {
					t.Fatal(err)
				}
				_ = res.Body.Close()
			})
		})
	}
}

func TestUploadConcurrencyRecoversGraduallyAfterPressure(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var gate uploadGate
		for range maxUploadRequests {
			if err := gate.acquire(t.Context()); err != nil {
				t.Fatal(err)
			}
		}
		for range maxUploadRequests {
			gate.finish(429, time.Second)
		}
		if gate.limit != 1 {
			t.Fatalf("burst left concurrency at %d", gate.limit)
		}
		time.Sleep(time.Second)
		for range 20 {
			if err := gate.acquire(t.Context()); err != nil {
				t.Fatal(err)
			}
			gate.finish(200, 0)
		}
		if gate.limit != 1 {
			t.Fatal("old successful responses bypassed recovery window")
		}
		time.Sleep(uploadRecoveryInterval)
		if err := gate.acquire(t.Context()); err != nil {
			t.Fatal(err)
		}
		gate.finish(200, 0)
		if gate.limit != 2 {
			t.Fatalf("expected gradual recovery to two requests, got %d", gate.limit)
		}
	})
}

func TestPressureCooldownCapsLongRetryAfter(t *testing.T) {
	for _, status := range []int{http.StatusTooManyRequests, http.StatusServiceUnavailable} {
		for _, path := range []string{"/_api/v1/upload-path", "/_api/v1/cache-config/test"} {
			for _, format := range []string{"seconds", "date"} {
				t.Run(http.StatusText(status)+path+"/"+format, func(t *testing.T) {
					synctest.Test(t, func(t *testing.T) {
						c := New("https://cache.test", "")
						start := time.Now()
						calls := 0
						c.hc.Transport = roundTripFunc(
							func(req *http.Request) (*http.Response, error) {
								calls++
								if calls == 1 {
									res := uploadResponse(req, status)
									value := "86400"
									if format == "date" {
										value = start.Add(24 * time.Hour).
											UTC().
											Format(http.TimeFormat)
									}
									res.Header.Set("Retry-After", value)
									return res, nil
								}
								elapsed := time.Since(start)
								if elapsed < maxRetryAfter ||
									elapsed >= maxRetryAfter+500*time.Millisecond {
									t.Errorf(
										"shared cooldown = %v, want five minutes plus at most 500 ms jitter",
										elapsed,
									)
								}
								return uploadResponse(req, 200), nil
							},
						)
						req, _ := c.newRequest(t.Context(), http.MethodPut, path, nil)
						res, attempts, err := c.do(req)
						if err != nil || attempts != 1 || res.StatusCode != status {
							t.Fatalf("attempts=%d response=%v error=%v", attempts, res, err)
						}
						_ = res.Body.Close()
						req, _ = c.newRequest(
							t.Context(),
							http.MethodPut,
							"/_api/v1/upload-path",
							nil,
						)
						res, _, err = c.do(req)
						if err != nil {
							t.Fatal(err)
						}
						_ = res.Body.Close()
					})
				})
			}
		}
	}
}
