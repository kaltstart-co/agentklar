//go:build darwin || linux || freebsd || netbsd || openbsd || dragonfly

package team

import (
	"os"
	"syscall"
)

func lockFile(f *os.File) error { return syscall.Flock(int(f.Fd()), syscall.LOCK_EX) }
func unlockFile(f *os.File)     { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN) }
