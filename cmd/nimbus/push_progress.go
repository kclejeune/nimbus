package main

import (
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"charm.land/bubbles/v2/progress"
	"charm.land/bubbles/v2/spinner"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/term"

	"github.com/kclejeune/nimbus/internal/nix"
	"github.com/kclejeune/nimbus/internal/push"
)

var (
	progressAccent  = lipgloss.NewStyle().Foreground(lipgloss.Color("#7D56F4"))
	progressSuccess = lipgloss.NewStyle().Foreground(lipgloss.Color("#04B575"))
	progressFailure = lipgloss.NewStyle().Foreground(lipgloss.Color("#FF4672"))
	progressMuted   = lipgloss.NewStyle().Foreground(lipgloss.Color("#777777"))
)

func pushProgressFactory(out *os.File) func() push.ProgressReporter {
	if !term.IsTerminal(out.Fd()) || os.Getenv("TERM") == "dumb" {
		return nil
	}
	return func() push.ProgressReporter { return newTTYPushProgress(out) }
}

type ttyPushProgress struct {
	program *tea.Program
	done    chan struct{}
}

func newTTYPushProgress(out io.Writer) *ttyPushProgress {
	model := newPushProgressModel()
	program := tea.NewProgram(
		model,
		tea.WithInput(nil),
		tea.WithOutput(out),
		// Fang owns process signals and cancels the command context. A nested
		// progress renderer must not compete with it for Ctrl-C.
		tea.WithoutSignalHandler(),
	)
	return &ttyPushProgress{program: program, done: make(chan struct{})}
}

func (r *ttyPushProgress) Start(cache string) {
	go func() {
		defer close(r.done)
		_, _ = r.program.Run()
	}()
	r.program.Send(pushStartMsg{cache: cache})
}

func (r *ttyPushProgress) Stage(label string) {
	r.program.Send(pushStageMsg(label))
}

func (r *ttyPushProgress) Ready(total int, totalBytes int64, alreadyPresent int) {
	r.program.Send(pushReadyMsg{
		total:          total,
		totalBytes:     totalBytes,
		alreadyPresent: alreadyPresent,
	})
}

func (r *ttyPushProgress) PathStarted(path string) {
	r.program.Send(pushPathStartedMsg(path))
}

func (r *ttyPushProgress) PathFinished(result push.PathProgress) {
	r.program.Send(pushPathFinishedMsg(result))
}

func (r *ttyPushProgress) Stop() {
	r.program.Send(pushStopMsg{})
	<-r.done
}

type (
	pushStartMsg        struct{ cache string }
	pushStageMsg        string
	pushPathStartedMsg  string
	pushPathFinishedMsg push.PathProgress
	pushStopMsg         struct{}
)

type pushReadyMsg struct {
	total          int
	totalBytes     int64
	alreadyPresent int
}

type pushProgressModel struct {
	spinner spinner.Model
	bar     progress.Model

	cache          string
	stage          string
	ready          bool
	done           bool
	total          int
	totalBytes     int64
	alreadyPresent int
	completed      int
	completedBytes int64
	active         map[string]struct{}
	last           string
	failures       []string
	started        time.Time
	finished       time.Time
	width          int
}

func newPushProgressModel() pushProgressModel {
	spin := spinner.New(spinner.WithSpinner(spinner.MiniDot), spinner.WithStyle(progressAccent))
	bar := progress.New(progress.WithDefaultBlend(), progress.WithScaled(true))
	bar.SetWidth(64)
	return pushProgressModel{
		spinner: spin,
		bar:     bar,
		stage:   "Preparing push",
		active:  make(map[string]struct{}),
		width:   80,
	}
}

func (m pushProgressModel) Init() tea.Cmd { return m.spinner.Tick }

func (m pushProgressModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.resizeBar()
	case pushStartMsg:
		m.cache = msg.cache
	case pushStageMsg:
		m.stage = string(msg)
	case pushReadyMsg:
		m.ready = true
		m.total = msg.total
		m.totalBytes = msg.totalBytes
		m.alreadyPresent = msg.alreadyPresent
		m.started = time.Now()
	case pushPathStartedMsg:
		m.active[string(msg)] = struct{}{}
	case pushPathFinishedMsg:
		result := push.PathProgress(msg)
		delete(m.active, result.Path)
		m.completed++
		name := nix.BaseName(result.Path)
		if result.Err != nil {
			failure := fmt.Sprintf("%s: %v", name, result.Err)
			m.failures = append(m.failures, failure)
			m.last = progressFailure.Render("✗") + " " + failure
		} else {
			m.completedBytes += result.NarSize
			m.last = progressSuccess.Render("✓") + " " + name + " " +
				progressMuted.Render(result.Suffix())
		}
	case pushStopMsg:
		m.done = true
		m.finished = time.Now()
		return m, tea.Quit
	}

	// The bar is rendered statelessly via ViewAs, so only the spinner needs
	// message-driven updates.
	var cmd tea.Cmd
	m.spinner, cmd = m.spinner.Update(msg)
	return m, cmd
}

func (m *pushProgressModel) resizeBar() {
	// Leave a little room so terminals do not wrap at the rightmost column.
	m.bar.SetWidth(min(72, max(1, m.width-2)))
}

func (m pushProgressModel) View() tea.View {
	if m.done && !m.ready {
		return tea.NewView("")
	}
	if !m.ready {
		return tea.NewView(fmt.Sprintf(
			"%s %s %s",
			m.spinner.View(),
			m.stage,
			progressMuted.Render(pushDestination(m.cache)),
		))
	}
	if m.done {
		return tea.NewView(m.finalView())
	}

	percent := 0.0
	if m.total > 0 {
		percent = float64(m.completed) / float64(m.total)
	}
	lines := []string{
		fmt.Sprintf("%s Pushing to %s", m.spinner.View(), progressAccent.Render(m.cache)),
		m.bar.ViewAs(percent),
		fmt.Sprintf(
			"%d/%d paths  %s/%s%s",
			m.completed,
			m.total,
			push.FormatBytes(m.completedBytes),
			push.FormatBytes(m.totalBytes),
			alreadyPresentLabel(m.alreadyPresent),
		),
	}
	if active := m.activeLabel(); active != "" {
		lines = append(lines, progressMuted.Render(active))
	}
	if m.last != "" {
		lines = append(lines, m.truncate(m.last))
	}
	return tea.NewView(strings.Join(lines, "\n"))
}

func (m pushProgressModel) finalView() string {
	elapsed := m.finished.Sub(m.started).Round(100 * time.Millisecond)
	if elapsed < 0 {
		elapsed = 0
	}
	if m.total == 0 {
		return fmt.Sprintf(
			"%s Nothing to push to %s%s",
			progressSuccess.Render("✓"),
			progressAccent.Render(m.cache),
			alreadyPresentLabel(m.alreadyPresent),
		)
	}

	succeeded := m.completed - len(m.failures)
	icon := progressSuccess.Render("✓")
	verb := fmt.Sprintf("Pushed %d paths", succeeded)
	if m.completed < m.total {
		icon = progressFailure.Render("✗")
		verb = fmt.Sprintf("Stopped after %d/%d paths", m.completed, m.total)
	} else if len(m.failures) > 0 {
		icon = progressFailure.Render("✗")
		verb = fmt.Sprintf("Pushed %d/%d paths", succeeded, m.total)
	}
	line := fmt.Sprintf(
		"%s %s (%s) to %s in %s%s",
		icon,
		verb,
		push.FormatBytes(m.completedBytes),
		progressAccent.Render(m.cache),
		elapsed,
		alreadyPresentLabel(m.alreadyPresent),
	)
	if len(m.failures) == 0 {
		return line
	}
	for _, failure := range m.failures {
		line += "\n  " + progressFailure.Render("✗") + " " + failure
	}
	return line
}

func (m pushProgressModel) activeLabel() string {
	if len(m.active) == 0 {
		return ""
	}
	// Show the alphabetically first active path so the label is stable
	// across renders without sorting the whole set.
	var first string
	for path := range m.active {
		if name := nix.BaseName(path); first == "" || name < first {
			first = name
		}
	}
	label := "Uploading " + first
	if len(m.active) > 1 {
		label += fmt.Sprintf(" (+%d more)", len(m.active)-1)
	}
	return m.truncate(label)
}

func (m pushProgressModel) truncate(s string) string {
	return ansi.Truncate(s, max(1, m.width-1), "…")
}

func pushDestination(cache string) string {
	if cache == "" {
		return ""
	}
	return "for " + cache
}

func alreadyPresentLabel(n int) string {
	if n == 0 {
		return ""
	}
	return fmt.Sprintf("  %d already present", n)
}
