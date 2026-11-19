package main

import (
	"context"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestConfigureChildIsolatesTerminalSIGINT(t *testing.T) {
	const helper = "EXECUTOR_TEST_SIGNAL_HOST"
	if os.Getenv(helper) != "1" {
		// Signal only the fixture's group, never the test runner's group.
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		host := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestConfigureChildIsolatesTerminalSIGINT$")
		host.Env = append(os.Environ(), helper+"=1", "GORACE=atexit_sleep_ms=0")
		host.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
		if output, err := host.CombinedOutput(); err != nil {
			t.Fatalf("isolated host fixture: %v\n%s", err, output)
		}
		return
	}

	group := syscall.Getpgrp()
	if group != os.Getpid() {
		t.Fatal("refusing to signal a group not created for this test")
	}
	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, syscall.SIGINT)
	defer signal.Stop(interrupt)

	child := testChildCommand("quick", "child", filepath.Join(t.TempDir(), "journal"), "", "")
	configureChild(child)
	ready := make(chan struct{}, 1)
	child.Stdout = readyWriter{ready}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	p := waitProcess("child", child)
	t.Cleanup(func() {
		child.Process.Kill()
		await(t, p.exited)
	})
	await(t, ready)
	pgid, err := syscall.Getpgid(child.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	if pgid == group || pgid != child.Process.Pid {
		t.Errorf("child pgid = %d, want its own group %d (host group %d)", pgid, child.Process.Pid, group)
	}
	if err := syscall.Kill(-group, syscall.SIGINT); err != nil {
		t.Fatal(err)
	}
	await(t, interrupt)
	if err := child.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("child did not survive host-group SIGINT: %v", err)
	}
	await(t, p.exited)
	if p.err != nil {
		t.Fatalf("child did not exit cleanly after its own SIGTERM: %v", p.err)
	}
}
