package main

import (
	"bufio"
	"fmt"
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
	// unreadPath is answered 403 before the request's body is read. The connection then closes
	// without Connection: close, as workerd's does once a body has crossed into the product's
	// Durable Object. workerd closes it right after the answer; the fake takes the rest of the body
	// and waits unreadLinger first, so a proxy that reuses the connection always loses the race
	// and the refused request itself never does.
	unreadPath string
	// closePath is answered 403 at once, and the connection then closes with the body unread, as
	// workerd's does within about 50 µs of such an answer.
	closePath string
	// stopPath stops reading at the request's headers and is answered 403 stopLinger later, so a
	// body write the proxy makes meanwhile fails before there is an answer to read. That is the
	// order in which a busy host sees workerd's close. Writes fail this way on Linux, where the
	// image runs; on macOS they succeed.
	stopPath string
	received atomic.Int32
	handled  atomic.Int32
}

const (
	unreadLinger = 200 * time.Millisecond
	stopLinger   = 50 * time.Millisecond
)

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
		if request.URL.Path == f.closePath || request.URL.Path == f.stopPath {
			f.received.Add(1)
			if request.URL.Path == f.stopPath {
				conn.(*net.UnixConn).CloseRead()
				time.Sleep(stopLinger)
			}
			f.handled.Add(1)
			io.WriteString(conn, "HTTP/1.1 403 Forbidden\r\nContent-Length: 7\r\n\r\nrefused")
			return
		}
		if request.URL.Path == f.unreadPath {
			f.received.Add(1)
			f.handled.Add(1)
			if request.Close {
				io.WriteString(conn, "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 7\r\n\r\nrefused")
				io.Copy(io.Discard, request.Body)
				return
			}
			io.WriteString(conn, "HTTP/1.1 403 Forbidden\r\nContent-Length: 7\r\n\r\nrefused")
			io.Copy(io.Discard, request.Body)
			time.Sleep(unreadLinger)
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
		if request.Close {
			io.WriteString(conn, "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 2\r\n\r\nok")
			return
		}
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
	return postTo(t, http.DefaultClient, address+"/api/workflow-runs", `{"key":"k"}`)
}

// postTo POSTs body to target, with no body when it is empty.
func postTo(t *testing.T, client *http.Client, target, body string) (int, string) {
	t.Helper()
	response, err := client.Post(target, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	answer, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, strings.TrimSpace(string(answer))
}

// Only requests without a body reuse pooled connections, so these POSTs send none. Go does not
// replay a POST that loses the race.
func TestProxyDoesNotReuseConnectionsWorkerdHasTimedOut(t *testing.T) {
	socket := socketPath(t)
	upstream := &fakeWorkerd{idleTimeout: 300 * time.Millisecond}
	upstream.serve(t, socket)
	front := httptest.NewServer(productProxy(socket, upstream.idleTimeout))
	defer front.Close()
	target := front.URL + "/api/workflow-runs"

	if status, body := postTo(t, http.DefaultClient, target, ""); status != 200 {
		t.Fatalf("first POST: %d %s", status, body)
	}
	time.Sleep(upstream.idleTimeout + 100*time.Millisecond)
	if status, body := postTo(t, http.DefaultClient, target, ""); status != 200 {
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

// workerd closes a connection after an answer that left the request's body unread. The proxy
// sends any client's next request on a different connection, and the client keeps its own.
func TestProxyDoesNotReuseAConnectionThatCarriedABody(t *testing.T) {
	socket := socketPath(t)
	upstream := &fakeWorkerd{idleTimeout: time.Minute, unreadPath: "/api/refused"}
	upstream.serve(t, socket)
	front := httptest.NewUnstartedServer(productProxy(socket, upstream.idleTimeout))
	var clientConnections atomic.Int32
	front.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			clientConnections.Add(1)
		}
	}
	front.Start()
	defer front.Close()
	client := &http.Client{Transport: &http.Transport{}}
	defer client.CloseIdleConnections()

	for round := range 3 {
		if status, body := postTo(t, client, front.URL+"/api/refused", `{"name":"refused"}`); status != http.StatusForbidden {
			t.Fatalf("round %d, POST answered without reading its body: %d %s", round, status, body)
		}
		if status, body := postTo(t, client, front.URL+"/api/workflow-runs", `{"key":"k"}`); status != 200 {
			t.Fatalf("round %d, the next POST: %d %s", round, status, body)
		}
	}
	if handled := upstream.handled.Load(); handled != 6 {
		t.Fatalf("workerd handled %d POSTs, want 6", handled)
	}
	if connections := clientConnections.Load(); connections != 1 {
		t.Fatalf("the client opened %d connections to the host, want 1", connections)
	}
}

// workerd can answer while the client is still sending the body. The host then serves the
// client's next request on the same connection. Built with Go 1.26, whose ReverseProxy returned
// before its transport finished reading the body, it panicked reading that request instead.
func TestHostServesTheNextRequestAfterAnAnswerBeforeTheBody(t *testing.T) {
	socket := socketPath(t)
	upstream := &fakeWorkerd{idleTimeout: time.Minute, unreadPath: "/api/refused"}
	upstream.serve(t, socket)
	front := httptest.NewServer(publicHandler(productProxy(socket, upstream.idleTimeout)))
	defer front.Close()
	conn, err := net.Dial("tcp", front.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	reader := bufio.NewReader(conn)
	status := func(step string) int {
		t.Helper()
		response, err := http.ReadResponse(reader, nil)
		if err != nil {
			t.Fatalf("%s: %v", step, err)
		}
		defer response.Body.Close()
		if _, err := io.Copy(io.Discard, response.Body); err != nil {
			t.Fatalf("%s: %v", step, err)
		}
		return response.StatusCode
	}

	body := `{"name":"refused"}`
	half := len(body) / 2
	fmt.Fprintf(conn, "POST /api/refused HTTP/1.1\r\nHost: executor.test\r\nContent-Length: %d\r\n\r\n%s", len(body), body[:half])
	if refused := status("POST answered before its body arrived"); refused != http.StatusForbidden {
		t.Fatalf("POST answered before its body arrived: %d, want 403", refused)
	}
	time.Sleep(300 * time.Millisecond)
	fmt.Fprintf(conn, "%sPOST /api/workflow-runs HTTP/1.1\r\nHost: executor.test\r\nContent-Length: 11\r\n\r\n{\"key\":\"k\"}", body[half:])
	if next := status("the next POST on the connection"); next != 200 {
		t.Fatalf("the next POST on the connection: %d, want 200", next)
	}
}

// twoParts is a request body that sends its first part at once and the rest after pause.
type twoParts struct {
	first, rest []byte
	pause       time.Duration
}

func (b *twoParts) Read(data []byte) (int, error) {
	if len(b.first) > 0 {
		n := copy(data, b.first)
		b.first = b.first[n:]
		return n, nil
	}
	time.Sleep(b.pause)
	b.pause = 0
	if len(b.rest) == 0 {
		return 0, io.EOF
	}
	n := copy(data, b.rest)
	b.rest = b.rest[n:]
	return n, nil
}

// refused POSTs body, of length bytes, to the fake's refused path through the proxy.
func refused(t *testing.T, proxy http.Handler, body io.Reader, length int) {
	t.Helper()
	request := httptest.NewRequest("POST", "/api/refused", body)
	request.ContentLength = int64(length)
	recorder := httptest.NewRecorder()
	proxy.ServeHTTP(recorder, request)
	if answer := strings.TrimSpace(recorder.Body.String()); recorder.Code != http.StatusForbidden || answer != "refused" {
		t.Fatalf("POST refused before its body was read: %d %s, want workerd's 403", recorder.Code, answer)
	}
}

// workerd answers a POST it refuses before reading the body, then closes the connection with the
// body unread. The proxy is still writing this body, which is larger than the socket's buffer,
// and the write fails when workerd closes. The client gets workerd's answer, not a 502.
func TestProxyReturnsTheAnswerWorkerdSentBeforeClosing(t *testing.T) {
	socket := socketPath(t)
	upstream := &fakeWorkerd{idleTimeout: time.Minute, closePath: "/api/refused"}
	upstream.serve(t, socket)
	body := strings.Repeat("x", 1<<20)
	refused(t, productProxy(socket, upstream.idleTimeout), strings.NewReader(body), len(body))
}

// A busy host may not read workerd's answer before its next body write fails. Here the write
// always fails first: the body's second part arrives after workerd stopped reading and before it
// answers. The client still gets workerd's answer.
func TestProxyWaitsForWorkerdsAnswerAfterABodyWriteFails(t *testing.T) {
	socket := socketPath(t)
	upstream := &fakeWorkerd{idleTimeout: time.Minute, stopPath: "/api/refused"}
	upstream.serve(t, socket)
	body := []byte(`{"name":"refused"}`)
	half := len(body) / 2
	parts := &twoParts{first: body[:half], rest: body[half:], pause: 10 * time.Millisecond}
	refused(t, productProxy(socket, upstream.idleTimeout), parts, len(body))
}

// A client that half-closes an upgraded connection, as the ws library does after a WebSocket's
// close handshake, still gets what workerd sends once it sees that half-close.
func TestProxyPassesAClientsHalfCloseOnAnUpgradedConnectionToWorkerd(t *testing.T) {
	socket := socketPath(t)
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		reader := bufio.NewReader(conn)
		if _, err := http.ReadRequest(reader); err != nil {
			return
		}
		io.WriteString(conn, "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
		io.Copy(io.Discard, reader)
		io.WriteString(conn, "closing")
	}()
	front := httptest.NewServer(publicHandler(productProxy(socket, workerdIdleTimeout)))
	defer front.Close()

	conn, err := net.Dial("tcp", front.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	io.WriteString(conn, "GET /api/live HTTP/1.1\r\nHost: executor\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("upgrade answered %d, want 101", response.StatusCode)
	}
	if err := conn.(*net.TCPConn).CloseWrite(); err != nil {
		t.Fatal(err)
	}
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	after, err := io.ReadAll(reader)
	if string(after) != "closing" {
		t.Fatalf("after the client's half-close got %q (%v), want workerd's %q", after, err, "closing")
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

func TestMemoryPressureIsSixtyPercentOfTheCgroupLimit(t *testing.T) {
	directory := t.TempDir()
	write := func(name, content string) string {
		path := filepath.Join(directory, name)
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	cases := []struct {
		name string
		file string
		want uint64
	}{
		{"4 GiB limit", write("limited", "4294967296\n"), 2457},
		{"no limit", write("unlimited", "max\n"), 0},
		{"no cgroup v2", filepath.Join(directory, "missing"), 0},
	}
	for _, c := range cases {
		if got := memoryPressureMiB(c.file); got != c.want {
			t.Errorf("%s: memoryPressureMiB = %d, want %d", c.name, got, c.want)
		}
	}
}

// syncBuffer collects the announcer's log while the test reads it.
type syncBuffer struct {
	mutex sync.Mutex
	text  strings.Builder
}

func (b *syncBuffer) Write(data []byte) (int, error) {
	b.mutex.Lock()
	defer b.mutex.Unlock()
	return b.text.Write(data)
}

func (b *syncBuffer) String() string {
	b.mutex.Lock()
	defer b.mutex.Unlock()
	return b.text.String()
}

// The product opens at boot without a visitor. Its socket appears only once workerd listens, and
// /health fails while the database initializes; the log says it is starting, that it is still
// starting while it waits, and then where it is ready.
func TestAnnounceReadyOpensTheProductAtBootAndSaysWhenItIsReady(t *testing.T) {
	socket := socketPath(t)
	var probes atomic.Int32
	go func() {
		time.Sleep(50 * time.Millisecond)
		listener, err := net.Listen("unix", socket)
		if err != nil {
			t.Error(err)
			return
		}
		t.Cleanup(func() { listener.Close() })
		http.Serve(listener, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/health" {
				t.Errorf("announcer requested %s", r.URL.Path)
			}
			time.Sleep(40 * time.Millisecond)
			if probes.Add(1) < 3 {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusOK)
		}))
	}()

	var log syncBuffer
	opened := make(chan struct{})
	returned := make(chan struct{})
	go func() {
		announceReady(socket, "https://executor.example.test:4443", 30*time.Millisecond, 5*time.Millisecond, &log, opened, make(chan struct{}))
		close(returned)
	}()
	select {
	case <-returned:
	case <-time.After(5 * time.Second):
		t.Fatalf("announcer did not see the product ready; log:\n%s", log.String())
	}

	text := log.String()
	for _, want := range []string{"Executor is starting.", "Executor is still starting (", "Executor is ready at https://executor.example.test:4443 (started in "} {
		if !strings.Contains(text, want) {
			t.Fatalf("log lacks %q:\n%s", want, text)
		}
	}
	if probes.Load() != 3 {
		t.Fatalf("announcer asked /health %d times, want 3", probes.Load())
	}
	if strings.Index(text, "ready at") < strings.LastIndex(text, "still starting") {
		t.Fatalf("log reports progress after ready:\n%s", text)
	}
	select {
	case <-opened:
	default:
		t.Fatal("the product answered, but opened stayed open")
	}
}

// The first answer opens the gate even when it is an error: a product that cannot open its
// database must show that failure, not report starting forever.
func TestAnnounceReadyOpensTheGateOnTheFirstAnswerEvenWhenItFails(t *testing.T) {
	socket := socketPath(t)
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go http.Serve(listener, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))

	opened := make(chan struct{})
	done := make(chan struct{})
	defer close(done)
	go announceReady(socket, "http://localhost:4400", time.Hour, time.Hour, io.Discard, opened, done)
	select {
	case <-opened:
	case <-time.After(5 * time.Second):
		t.Fatal("a failed open did not open the gate")
	}
}

// Until the product first answers, every public request gets an immediate 503 instead of waiting
// for the database to open; afterwards requests reach the product.
func TestStartingGateAnswersAtOnceUntilTheProductOpens(t *testing.T) {
	opened := make(chan struct{})
	var reached atomic.Int32
	front := httptest.NewServer(startingGate(opened, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached.Add(1)
		io.WriteString(w, "product")
	})))
	defer front.Close()

	client := http.Client{Timeout: time.Second}
	response, err := client.Get(front.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusServiceUnavailable || strings.TrimSpace(string(body)) != "Executor is starting" || response.Header.Get("Retry-After") != "5" {
		t.Fatalf("before the product opened: %d %q Retry-After %q", response.StatusCode, body, response.Header.Get("Retry-After"))
	}
	if reached.Load() != 0 {
		t.Fatal("a request reached the product before it opened")
	}

	close(opened)
	response, err = client.Get(front.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK || string(body) != "product" {
		t.Fatalf("after the product opened: %d %q", response.StatusCode, body)
	}
}

// A host that stops while the product is still opening ends the announcer and its waiting request.
func TestAnnounceReadyStopsWithTheHost(t *testing.T) {
	socket := socketPath(t)
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	requested := make(chan struct{}, 1)
	released := make(chan struct{})
	go http.Serve(listener, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requested <- struct{}{}
		select {
		case <-r.Context().Done():
			close(released)
		case <-time.After(5 * time.Second):
		}
	}))

	var log syncBuffer
	opened := make(chan struct{})
	done := make(chan struct{})
	returned := make(chan struct{})
	go func() {
		announceReady(socket, "http://localhost:4400", time.Hour, time.Millisecond, &log, opened, done)
		close(returned)
	}()
	<-requested
	close(done)
	select {
	case <-returned:
	case <-time.After(time.Second):
		t.Fatal("announcer kept running after the host stopped")
	}
	select {
	case <-released:
	case <-time.After(time.Second):
		t.Fatal("the waiting /health request was not cancelled")
	}
	if strings.Contains(log.String(), "ready at") {
		t.Fatalf("announcer reported ready for a product that never opened:\n%s", log.String())
	}
	select {
	case <-opened:
		t.Fatal("the gate opened although the product never answered")
	default:
	}
}

// healthServer answers /health on 127.0.0.1 through answer and returns its port.
func healthServer(t *testing.T, answer http.HandlerFunc) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/health" {
			http.NotFound(writer, request)
			return
		}
		answer(writer, request)
	}))
	t.Cleanup(server.Close)
	return strings.TrimPrefix(server.URL, "http://127.0.0.1:")
}

func TestHealthWaitsOutAStorageCommitStall(t *testing.T) {
	// A slow disk held /health behind one storage commit for several seconds. The previous
	// 4-second wait reported such a healthy instance as failing.
	port := healthServer(t, func(writer http.ResponseWriter, _ *http.Request) {
		time.Sleep(6 * time.Second)
		writer.WriteHeader(http.StatusOK)
	})
	if err := checkHealth(port, healthTimeout); err != nil {
		t.Fatalf("checkHealth after a 6-second stall = %v, want healthy", err)
	}
}

func TestHealthFailsWhenTheProductDoesNotAnswer(t *testing.T) {
	stuck := make(chan struct{})
	port := healthServer(t, func(http.ResponseWriter, *http.Request) { <-stuck })
	defer close(stuck)
	started := time.Now()
	if err := checkHealth(port, 200*time.Millisecond); err == nil {
		t.Fatal("checkHealth of a product that never answers = nil, want an error")
	}
	if waited := time.Since(started); waited > 5*time.Second {
		t.Fatalf("checkHealth waited %v past its 200ms timeout", waited)
	}
}

func TestHealthFailsWhileTheProductIsStarting(t *testing.T) {
	port := healthServer(t, func(writer http.ResponseWriter, _ *http.Request) {
		http.Error(writer, "Executor is starting", http.StatusServiceUnavailable)
	})
	if err := checkHealth(port, healthTimeout); err == nil || err.Error() != "Executor is not ready" {
		t.Fatalf("checkHealth while starting = %v, want Executor is not ready", err)
	}
}
