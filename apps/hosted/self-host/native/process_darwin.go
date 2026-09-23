package main

import "os/exec"

// macOS development uses the explicit supervisor shutdown path.
func configureChild(command *exec.Cmd) {}
