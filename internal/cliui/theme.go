// Package cliui provides the shared terminal theme and progress rendering for
// the nimbus CLI. Command results and domain-specific upload state stay with
// their callers.
package cliui

import (
	"charm.land/bubbles/v2/progress"
	"charm.land/bubbles/v2/spinner"
	"charm.land/lipgloss/v2"
)

var (
	Accent  = lipgloss.NewStyle().Foreground(lipgloss.Color("#7D56F4"))
	Success = lipgloss.NewStyle().Foreground(lipgloss.Color("#04B575"))
	Failure = lipgloss.NewStyle().Foreground(lipgloss.Color("#FF4672"))
	Muted   = lipgloss.NewStyle().Foreground(lipgloss.Color("#777777"))
)

func NewSpinner() spinner.Model {
	return spinner.New(spinner.WithSpinner(spinner.MiniDot), spinner.WithStyle(Accent))
}

func NewBar(width int) progress.Model {
	bar := progress.New(progress.WithDefaultBlend(), progress.WithScaled(true))
	bar.SetWidth(width)
	return bar
}
