//go:build !darwin

package main

import "fmt"

// The menu-bar widget is macOS-only. This stub keeps `go build ./...` working
// on other platforms (and in CI).
func main() {
	fmt.Println("agentklar-bar is a macOS menu-bar app; build and run it on macOS.")
}
