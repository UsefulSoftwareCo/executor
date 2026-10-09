package main

import (
	"bufio"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeWorkerd serves HTTP/1.1 on a Unix socket with kj's keep-alive rule: once a
// response completes, the connection closes if no request starts within the
// idle timeout. A request arriving at that moment is dropped unread, which is
// the race a pooled proxy connection can lose.
type fakeWorkerd struct {
	idleTimeout time.Duration
	// dropFirst closes a fresh connection after reading its request, without a response.
	dropFirst bool
	received  atomic.Int32
	handled   atomic.Int32
}

func (f *fakeWorkerd) serve(t *testing.T, socket string) {
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go f.connection(conn)
		}
	}()
}

func (f *fakeWorkerd) connection(conn net.Conn) {
	defer conn.Close()
	reader := bufio.NewReader(conn)
	for first := true; ; first = false {
		idleSince := time.Now()
		if _, err := reader.Peek(1); err != nil {
			return
		}
		if !first && time.Since(idleSince) >= f.idleTimeout {
			return
		}
		request, err := http.ReadRequest(reader)
		if err != nil {
			return
		}
		if _, err = io.Copy(io.Discard, request.Body); err != nil {
			return
		}
		f.received.Add(1)
		if f.dropFirst && first {
			return
		}
		f.handled.Add(1)
		if _, err = io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"); err != nil {
			return
		}
	}
}

func socketPath(t *testing.T) string {
	// Unix socket paths are limited to about 100 bytes, which t.TempDir can exceed on macOS.
	directory, err := os.MkdirTemp("", "proxy-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(directory) })
	return filepath.Join(directory, "product.sock")
}

func post(t *testing.T, address string) (int, string) {
	t.Helper()
	response, err := http.Post(address+"/api/workflow-runs", "application/json", strings.NewReader(`{"key":"k"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, strings.TrimSpace(string(body))
}

func TestProxyDoesNotReuseConnectionsWorkerdHasTimedOut(t *testing.T) {
	socket := socketPath(t)
	upstream := &fakeWorkerd{idleTimeout: 300 * time.Millisecond}
	upstream.serve(t, socket)
	front := httptest.NewServer(productProxy(socket, upstream.idleTimeout))
	defer front.Close()

	if status, body := post(t, front.URL); status != 200 {
		t.Fatalf("first POST: %d %s", status, body)
	}
	time.Sleep(upstream.idleTimeout + 100*time.Millisecond)
	if status, body := post(t, front.URL); status != 200 {
		t.Fatalf("POST after workerd's idle timeout: %d %s", status, body)
	}
	if handled := upstream.handled.Load(); handled != 2 {
		t.Fatalf("workerd handled %d POSTs, want 2", handled)
	}
}

func TestProxyDoesNotRetryPostWorkerdMayHaveReceived(t *testing.T) {
	socket := socketPath(t)
	upstream := &fakeWorkerd{idleTimeout: time.Minute, dropFirst: true}
	upstream.serve(t, socket)
	front := httptest.NewServer(productProxy(socket, upstream.idleTimeout))
	defer front.Close()

	status, body := post(t, front.URL)
	if status != http.StatusBadGateway || body == "Executor is starting" {
		t.Fatalf("dropped POST: %d %q, want 502 with the upstream failure", status, body)
	}
	if received := upstream.received.Load(); received != 1 {
		t.Fatalf("workerd received the POST %d times, want 1", received)
	}
}

func TestProxyReportsStartingUntilWorkerdListens(t *testing.T) {
	front := httptest.NewServer(productProxy(socketPath(t), workerdIdleTimeout))
	defer front.Close()

	if status, body := post(t, front.URL); status != http.StatusServiceUnavailable || body != "Executor is starting" {
		t.Fatalf("POST before workerd listens: %d %q", status, body)
	}
}

// The collector runs beside the product: an exit is followed by a restart, not by the product
// stopping. The waits double from the minimum to the maximum, so a collector that cannot start
// does not spin, and return to the minimum after a run longer than the maximum.
func TestSuperviseRestartsAnExitedProcessWithBackoff(t *testing.T) {
	var mutex sync.Mutex
	var waits []time.Duration
	after := func(delay time.Duration) <-chan time.Time {
		mutex.Lock()
		waits = append(waits, delay)
		mutex.Unlock()
		return time.After(0)
	}
	var starts atomic.Int32
	stop := supervise(func() *exec.Cmd {
		// The fifth process outlives the maximum wait; every other one exits at once.
		if starts.Add(1) == 5 {
			return exec.Command("sh", "-c", "sleep 0.6; exit 1")
		}
		return exec.Command("sh", "-c", "exit 1")
	}, 100*time.Millisecond, 400*time.Millisecond, after)
	deadline := time.Now().Add(10 * time.Second)
	for starts.Load() < 7 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	stop()
	mutex.Lock()
	recorded := append([]time.Duration(nil), waits...)
	mutex.Unlock()
	want := []time.Duration{100, 200, 400, 400, 100, 200}
	if len(recorded) < len(want) {
		t.Fatalf("waited %v, want at least %v ms", recorded, want)
	}
	for index, milliseconds := range want {
		if recorded[index] != milliseconds*time.Millisecond {
			t.Fatalf("waited %v, want %v ms first", recorded, want)
		}
	}
	settled := starts.Load()
	time.Sleep(100 * time.Millisecond)
	if count := starts.Load(); count != settled {
		t.Fatalf("started %d times after stop, want %d", count, settled)
	}
}

func TestSuperviseStopsARunningProcess(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "stopped")
	stop := supervise(func() *exec.Cmd {
		return exec.Command("sh", "-c", `trap 'touch "$0"; exit 0' TERM; while :; do sleep 0.05; done`, marker)
	}, time.Second, time.Second, time.After)
	time.Sleep(200 * time.Millisecond)
	returned := make(chan struct{})
	go func() { stop(); close(returned) }()
	select {
	case <-returned:
	case <-time.After(5 * time.Second):
		t.Fatal("stop did not return after SIGTERM")
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("the process was not sent SIGTERM: %v", err)
	}
}
