//go:build !linux && !darwin

package main

import "os"

func suppressTTYEcho(*os.File) (restore func()) { return func() {} }
