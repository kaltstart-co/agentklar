//go:build !darwin && !linux && !freebsd && !netbsd && !openbsd && !dragonfly && !windows

package team

import (
	"errors"
	"os"
)

func lockFile(*os.File) error { return errors.New("safe team writes are unsupported on this platform") }
func unlockFile(*os.File)     {}
