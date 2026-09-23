package main

import (
	"os/exec"
	"syscall"
)

// A killed supervisor cannot leave a second process owning the product database.
func configureChild(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
}
