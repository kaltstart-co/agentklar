package main

import (
	"fmt"
	"io"
	"os"
)

// printBanner renders the Agentklar logo in characters: a checked task box
// (a task that reached "done"). Colored only when writing to a real terminal.
func printBanner(w io.Writer) {
	blue, bold, dim, reset := "", "", "", ""
	if f, ok := w.(*os.File); ok {
		if fi, err := f.Stat(); err == nil && fi.Mode()&os.ModeCharDevice != 0 {
			blue = "\033[38;2;42;85;216m" // cobalt #2A55D8
			bold = "\033[1m"
			dim = "\033[2m"
			reset = "\033[0m"
		}
	}
	fmt.Fprintf(w, "\n   %s┌───┐%s\n", blue, reset)
	fmt.Fprintf(w, "   %s│%s %s✓%s %s│%s   %sagentklar%s\n", blue, reset, blue, reset, blue, reset, bold, reset)
	fmt.Fprintf(w, "   %s└───┘%s   %sagents that know what done means%s\n\n", blue, reset, dim, reset)
}
