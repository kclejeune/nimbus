package main

import (
	"errors"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/kclejeune/nimbus/internal/push"
)

func TestPushProgressModelTracksConcurrentPaths(t *testing.T) {
	m := newPushProgressModel()
	m = updatePushProgressModel(t, m, pushStartMsg{cache: "ci"})
	m = updatePushProgressModel(t, m, pushReadyMsg{
		total:          2,
		totalBytes:     3 * 1024,
		alreadyPresent: 4,
	})
	m = updatePushProgressModel(t, m, pushPathStartedMsg("/nix/store/aaa-first"))
	m = updatePushProgressModel(t, m, pushPathStartedMsg("/nix/store/bbb-second"))
	m = updatePushProgressModel(t, m, pushPathFinishedMsg(push.PathProgress{
		Path:    "/nix/store/aaa-first",
		NarSize: 1024,
		Elapsed: time.Second,
	}))
	m = updatePushProgressModel(t, m, pushPathFinishedMsg(push.PathProgress{
		Path:    "/nix/store/bbb-second",
		NarSize: 2 * 1024,
		Elapsed: time.Second,
		Err:     errors.New("upload refused"),
	}))

	if m.completed != 2 || m.completedBytes != 1024 {
		t.Fatalf(
			"completed = %d paths/%d bytes, want 2 paths/1024 bytes",
			m.completed,
			m.completedBytes,
		)
	}
	if len(m.active) != 0 {
		t.Fatalf("active = %v, want empty", m.active)
	}
	if len(m.failures) != 1 {
		t.Fatalf("failures = %v, want one", m.failures)
	}

	m = updatePushProgressModel(t, m, pushStopMsg{})
	view := ansi.Strip(m.View().Content)
	for _, want := range []string{
		"Pushed 1/2 paths",
		"1.0 KiB",
		"4 already present",
		"bbb-second: upload refused",
	} {
		if !strings.Contains(view, want) {
			t.Errorf("final view %q does not contain %q", view, want)
		}
	}
}

func TestPushProgressModelNothingMissing(t *testing.T) {
	m := newPushProgressModel()
	m = updatePushProgressModel(t, m, pushStartMsg{cache: "ci"})
	m = updatePushProgressModel(t, m, pushReadyMsg{alreadyPresent: 7})
	m = updatePushProgressModel(t, m, pushStopMsg{})

	view := ansi.Strip(m.View().Content)
	if !strings.Contains(view, "Nothing to push to ci  7 already present") {
		t.Fatalf("final view = %q", view)
	}
}

func TestPushProgressModelStoppedBeforeCompletion(t *testing.T) {
	m := newPushProgressModel()
	m = updatePushProgressModel(t, m, pushStartMsg{cache: "ci"})
	m = updatePushProgressModel(t, m, pushReadyMsg{total: 3, totalBytes: 3072})
	m = updatePushProgressModel(t, m, pushPathFinishedMsg(push.PathProgress{
		Path:    "/nix/store/aaa-first",
		NarSize: 1024,
		Elapsed: time.Second,
	}))
	m = updatePushProgressModel(t, m, pushStopMsg{})

	view := ansi.Strip(m.View().Content)
	if !strings.Contains(view, "Stopped after 1/3 paths") {
		t.Fatalf("final view = %q", view)
	}
}

func TestPushProgressModelHonorsNarrowTerminal(t *testing.T) {
	m := newPushProgressModel()
	m = updatePushProgressModel(t, m, tea.WindowSizeMsg{Width: 12, Height: 24})

	if got, want := m.bar.Width(), 10; got != want {
		t.Fatalf("bar width = %d, want %d", got, want)
	}
	if got := ansi.StringWidth(m.truncate("Uploading a-very-long-store-path")); got > 11 {
		t.Fatalf("truncated label width = %d, want <= 11", got)
	}
}

func updatePushProgressModel(t *testing.T, m pushProgressModel, msg any) pushProgressModel {
	t.Helper()
	updated, _ := m.Update(msg)
	return updated.(pushProgressModel)
}
