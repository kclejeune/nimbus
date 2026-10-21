package cliui

import (
	"fmt"
	"io"
	"time"

	"charm.land/bubbles/v2/progress"
	"charm.land/bubbles/v2/spinner"
	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

// Stages shows a themed spinner for work with an unknown total. Redirected
// output uses plain lines, keeping logs and separate JSON reports usable.
type Stages struct {
	out     io.Writer
	program *Program
}

func NewStages(out io.Writer) *Stages {
	p := &Stages{out: out}
	if file, ok := TerminalFile(out); ok {
		p.program = NewProgram(
			file,
			stageModel{
				spinner: NewSpinner(),
				bar:     NewBar(64),
				label:   "Preparing",
				started: time.Now(),
				width:   80,
			},
		)
		p.program.Start()
	}
	return p
}

func (p *Stages) Stage(label string) {
	if p.program != nil {
		p.program.Send(stageLabelMsg(label))
	} else {
		fmt.Fprintln(p.out, label)
	}
}

// Progress advances a known amount of work. Unknown totals use Stage instead.
// The label carries units/counters for the plain-text fallback too.
func (p *Stages) Progress(label string, completed, total int) {
	if p.program != nil {
		p.program.Send(stageProgressMsg{label: label, completed: completed, total: total})
	} else {
		fmt.Fprintln(p.out, label)
	}
}

func (p *Stages) Stop() {
	if p.program != nil {
		p.program.Stop(stageStopMsg{})
	}
}

type (
	stageLabelMsg string
	stageStopMsg  struct{}
)

type stageProgressMsg struct {
	label            string
	completed, total int
}

type stageModel struct {
	spinner          spinner.Model
	bar              progress.Model
	label            string
	started          time.Time
	width            int
	done             bool
	completed, total int
}

func (m stageModel) Init() tea.Cmd { return m.spinner.Tick }

func (m stageModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.bar.SetWidth(min(72, max(1, m.width-2)))
	case stageLabelMsg:
		m.label = string(msg)
		m.completed, m.total = 0, 0
	case stageProgressMsg:
		m.label = msg.label
		m.total = max(0, msg.total)
		m.completed = min(max(0, msg.completed), m.total)
	case stageStopMsg:
		m.done = true
		return m, tea.Quit
	}
	var cmd tea.Cmd
	m.spinner, cmd = m.spinner.Update(msg)
	return m, cmd
}

func (m stageModel) View() tea.View {
	if m.done {
		return tea.NewView("")
	}
	elapsed := Muted.Render("(" + time.Since(m.started).Round(time.Second).String() + ")")
	icon := m.spinner.View()
	width := max(1, m.width-1)
	label := ansi.Truncate(
		m.label,
		max(1, width-ansi.StringWidth(icon)-ansi.StringWidth(elapsed)-2),
		"…",
	)
	header := ansi.Truncate(fmt.Sprintf("%s %s %s", icon, label, elapsed), width, "…")
	if m.total > 0 {
		return tea.NewView(
			header + "\n" + ansi.Truncate(
				m.bar.ViewAs(float64(m.completed)/float64(m.total)),
				width,
				"…",
			),
		)
	}
	return tea.NewView(header)
}
