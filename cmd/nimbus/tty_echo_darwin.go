package main

import "golang.org/x/sys/unix"

func flushTTYInput(fd int) error {
	// TIOCFLUSH takes FREAD, which shares TCIFLUSH's value on BSD.
	return unix.IoctlSetPointerInt(fd, unix.TIOCFLUSH, unix.TCIFLUSH)
}
