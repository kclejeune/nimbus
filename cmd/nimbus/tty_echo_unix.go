//go:build linux || darwin

package main

import (
	"os"

	"github.com/charmbracelet/x/term"
	"golang.org/x/sys/unix"
)

// suppressTTYEcho hides replies to bubbletea's startup mode queries, which it
// sends even with input disabled, so the tty would otherwise echo them. The
// returned func discards the unread replies and restores the terminal.
func suppressTTYEcho(f *os.File) (restore func()) {
	fd := f.Fd()
	orig, err := term.GetState(fd)
	if err != nil {
		return func() {}
	}
	quiet := *orig
	quiet.Lflag &^= unix.ECHO
	if err := term.SetState(fd, &quiet); err != nil {
		return func() {}
	}
	return func() {
		_ = flushTTYInput(int(fd))
		_ = term.Restore(fd, orig)
	}
}
