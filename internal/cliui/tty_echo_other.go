//go:build !linux && !darwin

package cliui

import "os"

func suppressTTYEcho(*os.File) (restore func()) { return func() {} }
