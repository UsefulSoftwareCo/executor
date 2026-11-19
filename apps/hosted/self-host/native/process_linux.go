package main

import (
	"os/exec"
	"syscall"
)

// Keep terminal SIGINT at the host so it can drain, without orphaning a child if the host is killed.
// macOS keeps the shared group because it has no parent-death signal to clean up an isolated child.
func configureChild(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL, Setpgid: true}
}
