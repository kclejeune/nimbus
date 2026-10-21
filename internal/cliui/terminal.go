package cliui

import (
	"io"
	"os"
	"sync"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/term"
)

// TerminalFile selects interactive rendering consistently across commands.
func TerminalFile(out io.Writer) (*os.File, bool) {
	f, ok := out.(*os.File)
	return f, ok && term.IsTerminal(f.Fd()) && os.Getenv("TERM") != "dumb"
}

// Program owns terminal setup/cleanup for a progress model. Fang owns process
// signals; nested renderers leave stdin and signal handling to the command.
type Program struct {
	program     *tea.Program
	out         *os.File
	restoreEcho func()
	done        chan struct{}
	stop        sync.Once
}

func NewProgram(out *os.File, model tea.Model) *Program {
	return &Program{
		program: tea.NewProgram(
			model,
			tea.WithInput(nil),
			tea.WithOutput(out),
			tea.WithoutSignalHandler(),
		),
		out:  out,
		done: make(chan struct{}),
	}
}

func (p *Program) Start() {
	p.restoreEcho = suppressTTYEcho(p.out)
	go func() {
		defer close(p.done)
		_, _ = p.program.Run()
	}()
}

func (p *Program) Send(msg tea.Msg) { p.program.Send(msg) }

// Stop delivers the model's final message, waits for the last render, and
// restores the tty. Safe for an explicit stop followed by deferred cleanup.
func (p *Program) Stop(msg tea.Msg) {
	p.stop.Do(func() {
		p.Send(msg)
		<-p.done
		p.restoreEcho()
	})
}
