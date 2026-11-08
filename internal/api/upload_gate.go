package api

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Bound aggregate path/chunk requests, not just path workers. A pressure
// response drains existing requests and slows every uploader using this client.
const (
	maxUploadRequests      = 8
	uploadRecoveryInterval = 5 * time.Second
)

type uploadGate struct {
	mu           sync.Mutex
	active       int
	limit        int
	until        time.Time
	nextIncrease time.Time
	changed      chan struct{}
}

func (g *uploadGate) initLocked() {
	if g.changed == nil {
		g.changed = make(chan struct{})
		g.limit = maxUploadRequests
	}
}

func (g *uploadGate) notifyLocked() {
	close(g.changed)
	g.changed = make(chan struct{})
}

func isUploadRequest(req *http.Request) bool {
	// Endpoints can have a deployment prefix before /_api.
	const path = "/_api/v1/upload-path"
	return strings.HasSuffix(req.URL.Path, path) || strings.Contains(req.URL.Path, path+"/")
}

func isUploadPressure(status int) bool {
	return status == http.StatusTooManyRequests || status == http.StatusServiceUnavailable
}

func (g *uploadGate) acquire(ctx context.Context) error {
	for {
		g.mu.Lock()
		g.initLocked()
		if err := ctx.Err(); err != nil {
			g.mu.Unlock()
			return err
		}
		wait := time.Until(g.until)
		if wait <= 0 && g.active < g.limit {
			g.active++
			g.mu.Unlock()
			return nil
		}
		changed := g.changed
		g.mu.Unlock()
		var timer *time.Timer
		var ready <-chan time.Time
		if wait > 0 {
			timer = time.NewTimer(wait)
			ready = timer.C
		}
		select {
		case <-ctx.Done():
			if timer != nil {
				timer.Stop()
			}
			return ctx.Err()
		case <-changed:
		case <-ready:
		}
		if timer != nil {
			timer.Stop()
		}
	}
}

func (g *uploadGate) finish(status int, cooldown time.Duration) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.active--
	now := time.Now()
	switch {
	case isUploadPressure(status):
		g.pressureLocked(cooldown)
	case status >= 200 && status < 300 && g.limit < maxUploadRequests && !now.Before(g.nextIncrease):
		g.limit++
		g.nextIncrease = now.Add(uploadRecoveryInterval)
	}
	g.notifyLocked()
}

// A failed preflight/control request can expose pressure before an upload
// fails. It pauses uploads without acquiring or releasing an upload permit.
func (g *uploadGate) backoff(cooldown time.Duration) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.initLocked()
	g.pressureLocked(cooldown)
	g.notifyLocked()
}

func (g *uploadGate) pressureLocked(cooldown time.Duration) {
	g.limit = max(1, g.limit/2)
	if until := time.Now().Add(cooldown); until.After(g.until) {
		g.until = until
	}
	g.nextIncrease = g.until.Add(uploadRecoveryInterval)
}
