package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: orchestrator-supervisor <run folder>\nThe run folder holds spec.json, written by the orchestrator daemon.")
		os.Exit(2)
	}
	os.Exit(Run(os.Args[1]))
}
