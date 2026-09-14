package main

import (
	"fmt"
	"io"
	"os"
	"slices"
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

func (r *ttyPushProgress) PathStarted(path string, narSize int64) {
	r.program.Send(pushPathStartedMsg{path: path, narSize: narSize})
}

func (r *ttyPushProgress) PathProgressed(path string, sent int64) {
	r.program.Send(pushPathProgressedMsg{path: path, sent: sent})
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
	pushPathFinishedMsg push.PathProgress
	pushStopMsg         struct{}
)

type pushPathStartedMsg struct {
	path    string
	narSize int64
}

type pushPathProgressedMsg struct {
	path string
	sent int64
}

// activeUpload is one in-flight path; sent is clamped to size on receipt.
type activeUpload struct {
	path string
	size int64
	sent int64
}

func (a *activeUpload) fraction() float64 {
	if a.size <= 0 {
		return 0
	}
	return float64(a.sent) / float64(a.size)
}

// maxActiveLines bounds the live region so a large --jobs does not push the
// summary off a short terminal; the remainder is folded into a count.
const maxActiveLines = 8

type pushReadyMsg struct {
	total          int
	totalBytes     int64
	alreadyPresent int
}

type pushProgressModel struct {
	spinner spinner.Model
	bar     progress.Model
	pathBar progress.Model

	cache          string
	stage          string
	ready          bool
	done           bool
	total          int
	totalBytes     int64
	alreadyPresent int
	completed      int
	completedBytes int64
	// active is in start order, which is the display order.
	active   []*activeUpload
	failures []string
	started  time.Time
	finished time.Time
	width    int
}

func newPushProgressModel() pushProgressModel {
	spin := spinner.New(spinner.WithSpinner(spinner.MiniDot), spinner.WithStyle(progressAccent))
	bar := progress.New(progress.WithDefaultBlend(), progress.WithScaled(true))
	bar.SetWidth(64)
	pathBar := progress.New(progress.WithDefaultBlend(), progress.WithScaled(true))
	pathBar.SetWidth(16)
	pathBar.PercentageStyle = progressMuted
	return pushProgressModel{
		spinner: spin,
		bar:     bar,
		pathBar: pathBar,
		stage:   "Preparing push",
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
		m.active = append(m.active, &activeUpload{path: msg.path, size: msg.narSize})
	case pushPathProgressedMsg:
		if a := m.upload(msg.path); a != nil {
			a.sent = min(msg.sent, a.size)
		}
	case pushPathFinishedMsg:
		result := push.PathProgress(msg)
		m.active = slices.DeleteFunc(m.active, func(a *activeUpload) bool {
			return a.path == result.Path
		})
		m.completed++
		name := nix.BaseName(result.Path)
		var line string
		if result.Err != nil {
			failure := fmt.Sprintf("%s: %v", name, result.Err)
			m.failures = append(m.failures, failure)
			line = progressFailure.Render("✗") + " " + failure
		} else {
			m.completedBytes += result.NarSize
			line = progressSuccess.Render("✓") + " " + name + " " +
				progressMuted.Render(result.Suffix())
		}
		// Finished paths scroll above the live region so the history of a
		// push survives the way plain line output does.
		return m, tea.Println(m.truncate(line))
	case pushStopMsg:
		m.done = true
		m.finished = time.Now()
		return m, tea.Quit
	}

	// The bars are rendered statelessly via ViewAs, so only the spinner needs
	// message-driven updates.
	var cmd tea.Cmd
	m.spinner, cmd = m.spinner.Update(msg)
	return m, cmd
}

func (m pushProgressModel) upload(path string) *activeUpload {
	i := slices.IndexFunc(m.active, func(a *activeUpload) bool { return a.path == path })
	if i < 0 {
		return nil
	}
	return m.active[i]
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

	// The overall bar advances by bytes rather than paths so one large NAR
	// among many small ones moves visibly while it uploads.
	transferred := m.transferredBytes()
	fraction := 0.0
	if m.totalBytes > 0 {
		fraction = float64(transferred) / float64(m.totalBytes)
	}
	lines := []string{
		fmt.Sprintf("%s Pushing to %s", m.spinner.View(), progressAccent.Render(m.cache)),
		m.bar.ViewAs(fraction),
		fmt.Sprintf(
			"%d/%d paths  %s/%s%s",
			m.completed,
			m.total,
			push.FormatBytes(transferred),
			push.FormatBytes(m.totalBytes),
			alreadyPresentLabel(m.alreadyPresent),
		),
	}
	lines = append(lines, m.activeLines()...)
	return tea.NewView(strings.Join(lines, "\n"))
}

// transferredBytes is completed NAR bytes plus the in-flight bytes of every
// active upload.
func (m pushProgressModel) transferredBytes() int64 {
	n := m.completedBytes
	for _, a := range m.active {
		n += a.sent
	}
	return n
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

// activeLines renders one row per in-flight upload in start order, so rows
// keep their position as neighbours finish.
func (m pushProgressModel) activeLines() []string {
	shown := min(len(m.active), maxActiveLines)
	lines := make([]string, 0, shown+1)
	for _, a := range m.active[:shown] {
		lines = append(lines, m.activeLine(a))
	}
	if rest := len(m.active) - shown; rest > 0 {
		lines = append(lines, progressMuted.Render(fmt.Sprintf("  +%d more uploading", rest)))
	}
	return lines
}

func (m pushProgressModel) activeLine(a *activeUpload) string {
	// The name column is truncated so the numbers survive a narrow terminal;
	// the whole row is truncated once more for the pathological case.
	nameWidth := max(8, min(40, m.width/3))
	name := lipgloss.NewStyle().Width(nameWidth).Inline(true).
		Render(ansi.Truncate(nix.BaseName(a.path), nameWidth, "…"))
	return m.truncate(fmt.Sprintf(
		"  %s %s  %s",
		name,
		m.pathBar.ViewAs(a.fraction()),
		progressMuted.Render(push.FormatBytes(a.sent)+"/"+push.FormatBytes(a.size)),
	))
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
