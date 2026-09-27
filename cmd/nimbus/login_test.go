package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCallbackHandlerDeclaresUTF8(t *testing.T) {
	tokens := make(chan string, 1)
	rec := httptest.NewRecorder()
	callbackHandler("s1", tokens).ServeHTTP(
		rec,
		httptest.NewRequest(http.MethodGet, "/callback?state=s1&token=tok", nil),
	)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "text/html; charset=utf-8" {
		t.Errorf("Content-Type = %q, want text/html; charset=utf-8", got)
	}
	if body := rec.Body.String(); !strings.Contains(body, `<meta charset="utf-8">`) ||
		!strings.Contains(body, "✅ nimbus is authorized — you can close this tab.") {
		t.Errorf("body = %q, want a UTF-8 meta tag and the authorized message", body)
	}
	if got := <-tokens; got != "tok" {
		t.Errorf("token = %q, want tok", got)
	}
}

func TestCallbackHandlerRejectsBadCallbacks(t *testing.T) {
	for _, target := range []string{
		"/callback?state=wrong&token=tok",
		"/callback?state=s1",
		"/other?state=s1&token=tok",
	} {
		tokens := make(chan string, 1)
		rec := httptest.NewRecorder()
		callbackHandler(
			"s1",
			tokens,
		).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", target, rec.Code)
		}
		if len(tokens) != 0 {
			t.Errorf("%s: token delivered for a rejected callback", target)
		}
	}
}
