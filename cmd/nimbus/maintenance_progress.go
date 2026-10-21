package main

import (
	"fmt"
	"io"

	"github.com/kclejeune/nimbus/internal/cliui"
)

// Keep command-specific stage labels while sharing push's theme and terminal
// lifecycle. Plans/results stay on stdout; maintenance progress uses stderr.
type maintenanceProgress struct{ stages *cliui.Stages }

func newMaintenanceProgress(out io.Writer) *maintenanceProgress {
	return &maintenanceProgress{stages: cliui.NewStages(out)}
}

func (p *maintenanceProgress) update(format string, args ...any) {
	p.stages.Stage(fmt.Sprintf(format, args...))
}

func (p *maintenanceProgress) counted(completed, total int, format string, args ...any) {
	p.stages.Progress(fmt.Sprintf(format, args...), completed, total)
}

func (p *maintenanceProgress) close() { p.stages.Stop() }
