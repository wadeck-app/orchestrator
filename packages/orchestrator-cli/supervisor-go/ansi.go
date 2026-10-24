package main

import "regexp"

// ansiSequence matches the terminal escape sequences a job may print: OSC / DCS / SOS / PM / APC strings (ended by
// BEL or ST, or by the end of the line when cut), CSI sequences (colours, cursor and erase codes), any other short
// ESC sequence, and an ESC that starts nothing. A carriage return is not one of them.
//
// The same expression as stripAnsi in src/ansi.ts, which strips the lines of a job the daemon spawns itself, so the
// run log reads the same whichever path ran the job. test/ansi-cases.js and TestStripAnsiTable pin both.
var ansiSequence = regexp.MustCompile(
	`\x1b[\]PX^_][^\x07\x1b]*(?:\x07|\x1b\\|$)` +
		`|\x1b\[[0-?]*[ -/]*[@-~]` +
		`|\x1b[ -/]*[0-~]` +
		`|\x1b`)

func stripAnsi(text string) string {
	return ansiSequence.ReplaceAllString(text, "")
}
