package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"testing/synctest"
	"time"
)

func TestMain(m *testing.M) {
	if role := os.Getenv("EXECUTOR_TEST_CHILD"); role != "" {
		runShutdownChild(role, os.Args[1], os.Args[2], os.Args[3], os.Args[4])
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func journalEvent(path, event string) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		panic(err)
	}
	defer file.Close()
	if _, err := fmt.Fprintln(file, event); err != nil {
		panic(err)
	}
}

func runShutdownChild(role, name, journal, socket, edgeAddress string) {
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM)
	quit := make(chan struct{})
	var requests sync.WaitGroup
	var admissions sync.Mutex
	accepting := true
	var listener net.Listener
	notify := func(event string) {
		journalEvent(journal, name+":"+event)
		fmt.Println(event)
	}
	if role == "drains" || role == "stalled" {
		var err error
		listener, err = net.Listen("unix", socket)
		if err != nil {
			panic(err)
		}
		server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/finish" {
				close(quit)
				return
			}
			admissions.Lock()
			if !accepting {
				admissions.Unlock()
				return
			}
			requests.Add(1)
			admissions.Unlock()
			defer requests.Done()
			defer notify("request-ended")
			switch r.URL.Path {
			case "/upgrade":
				conn, rw, err := http.NewResponseController(w).Hijack()
				if err != nil {
					panic(err)
				}
				defer conn.Close()
				fmt.Fprint(rw, "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n")
				rw.Flush()
				io.Copy(conn, rw)
			case "/short", "/pending":
				notify("request-started")
				select {
				case <-quit:
					fmt.Fprint(w, "complete")
				case <-r.Context().Done():
				}
			default:
				media := "text/event-stream; charset=utf-8"
				if r.URL.Path == "/ndjson" {
					media = "application/x-ndjson"
				}
				w.Header().Set("Content-Type", media)
				fmt.Fprint(w, "data: open\n\n")
				w.(http.Flusher).Flush()
				<-r.Context().Done()
			}
		})}
		go server.Serve(listener)
	}
	notify("ready")
	if role == "dead" {
		os.Exit(42)
	}
	<-signals
	if edgeAddress != "" {
		if conn, err := net.Dial("tcp", edgeAddress); err == nil {
			conn.Close()
			notify("edge-open")
		}
	}
	notify("term")
	if role == "stubborn" || role == "stalled" {
		for range signals {
		}
	}
	if listener != nil {
		listener.Close()
		admissions.Lock()
		accepting = false
		admissions.Unlock()
		requests.Wait()
	}
	notify("exit")
}

func await[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for shutdown event")
		var zero T
		return zero
	}
}

type manualTimers struct {
	mu     sync.Mutex
	timers map[time.Duration]chan time.Time
}

// Distinguish the two equal production durations in the fake clock.
const testDrain = drainGrace + time.Millisecond

func (m *manualTimers) after(delay time.Duration) <-chan time.Time { return m.timer(delay) }

func (m *manualTimers) timer(delay time.Duration) chan time.Time {
	m.mu.Lock()
	defer m.mu.Unlock()
	ch := m.timers[delay]
	if ch == nil {
		ch = make(chan time.Time, 1)
		m.timers[delay] = ch
	}
	return ch
}

type observedListener struct {
	net.Listener
	accepted chan struct{}
}

func (l observedListener) Accept() (net.Conn, error) {
	select {
	case <-l.accepted:
	default:
		close(l.accepted)
	}
	return l.Listener.Accept()
}

type observedChild struct {
	*process
	name   string
	events chan string
}

func (p *observedChild) hold() {}

func (p *observedChild) stop(grace time.Duration, deadline <-chan struct{}) error {
	if p.name == "product" {
		return p.process.stop(grace, deadline)
	}
	if stopProcess(p.process, deadline) {
		return killedChild(p.name, grace)
	}
	return nil
}

type shutdownFixture struct {
	t                    *testing.T
	parts                shutdownParts
	signals              chan os.Signal
	stalled              chan error
	timers               manualTimers
	log                  bytes.Buffer
	journal, socket, url string
	draining             chan struct{}
	children             []*observedChild
}

func newShutdownFixture(t *testing.T) *shutdownFixture {
	t.Helper()
	dir, err := os.MkdirTemp("", "executor-stop-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	f := &shutdownFixture{
		t: t, journal: filepath.Join(dir, "journal"), socket: filepath.Join(dir, "workerd.sock"),
		signals: make(chan os.Signal, 2), stalled: make(chan error, 1), draining: make(chan struct{}),
		timers: manualTimers{timers: make(map[time.Duration]chan time.Time)},
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	edge := newEdge()
	proxy := productProxy(f.socket, workerdIdleTimeout)
	proxy.ModifyResponse = edge.response
	public := &http.Server{
		Handler:     edge.handler(publicHandler(proxy)),
		BaseContext: func(net.Listener) context.Context { return edge.base },
	}
	accepted := make(chan struct{})
	go public.Serve(observedListener{listener, accepted})
	await(t, accepted)
	t.Cleanup(func() {
		edge.cut(errStopping)
		public.Close()
		listener.Close()
	})
	f.url = "http://" + listener.Addr().String()
	f.parts = shutdownParts{
		signals: f.signals, stalled: f.stalled, public: public, listener: listener, edge: edge,
		endWatching: func() { close(f.draining) }, endAnnouncing: func() {}, joinWatching: func() {},
		endStreams: func() { close(edge.ending) },
		closeIdle: func() {
			proxy.Transport.(*http.Transport).CloseIdleConnections()
			if errors.Is(context.Cause(edge.base), errStopping) {
				journalEvent(f.journal, "edge:cut")
			}
		},
		closeBridge: func() { journalEvent(f.journal, "bridge:close") },
	}
	return f
}

func testChildCommand(role, name, journal, socket, edge string) *exec.Cmd {
	cmd := exec.Command(os.Args[0], name, journal, socket, edge)
	cmd.Env = append(os.Environ(), "EXECUTOR_TEST_CHILD="+role, "GORACE=atexit_sleep_ms=0")
	cmd.Stderr = os.Stderr
	return cmd
}

func (f *shutdownFixture) child(role, name string) *observedChild {
	f.t.Helper()
	cmd := testChildCommand(role, name, f.journal, f.socket, strings.TrimPrefix(f.url, "http://"))
	// Use an explicit pipe so Wait does not close the read side before the final journal event.
	read, write, err := os.Pipe()
	if err != nil {
		f.t.Fatal(err)
	}
	cmd.Stdout = write
	if err := cmd.Start(); err != nil {
		read.Close()
		write.Close()
		f.t.Fatal(err)
	}
	write.Close()
	p := &observedChild{process: waitProcess(name, cmd), name: name, events: make(chan string, 16)}
	go func() {
		defer read.Close()
		defer close(p.events)
		scanner := bufio.NewScanner(read)
		for scanner.Scan() {
			p.events <- scanner.Text()
		}
	}()
	f.t.Cleanup(func() {
		cmd.Process.Kill()
		await(f.t, p.exited)
	})
	if got := await(f.t, p.events); got != "ready" {
		f.t.Fatalf("%s first event = %q; want ready", name, got)
	}
	f.children = append(f.children, p)
	return p
}

func (f *shutdownFixture) start() <-chan error {
	for _, child := range f.children {
		switch child.name {
		case "product":
			f.parts.product, f.parts.productExited = child, child.exited
		case "apps":
			f.parts.apps = child
		case "collector":
			f.parts.collector = child
		}
	}
	result := make(chan error, 1)
	go func() {
		result <- shutdown(f.parts, shutdownPlan{testDrain, workerdGrace, collectorGrace, f.timers.after, &f.log})
	}()
	return result
}

func (f *shutdownFixture) request(method, path string) *http.Response {
	f.t.Helper()
	result := await(f.t, f.beginRequest(method, path))
	if result.err != nil {
		f.t.Fatal(result.err)
	}
	f.t.Cleanup(func() { result.response.Body.Close() })
	return result.response
}

type requestResult struct {
	response *http.Response
	err      error
}

func (f *shutdownFixture) beginRequest(method, path string) <-chan requestResult {
	req, err := http.NewRequest(method, f.url+path, nil)
	if err != nil {
		f.t.Fatal(err)
	}
	done := make(chan requestResult, 1)
	go func() {
		client := &http.Client{Timeout: 4 * time.Second}
		response, err := client.Do(req)
		done <- requestResult{response, err}
	}()
	return done
}

func (f *shutdownFixture) journalOrder(pairs ...[2]string) {
	f.t.Helper()
	data, err := os.ReadFile(f.journal)
	if err != nil {
		f.t.Fatal(err)
	}
	log := string(data)
	if strings.Contains(log, ":edge-open") {
		f.t.Fatalf("listener still open when a child got SIGTERM:\n%s", log)
	}
	for _, pair := range pairs {
		first, second := strings.Index(log, pair[0]+"\n"), strings.Index(log, pair[1]+"\n")
		if first < 0 || second < 0 || first >= second {
			f.t.Fatalf("want %s before %s:\n%s", pair[0], pair[1], log)
		}
	}
}

func (f *shutdownFixture) clean(result <-chan error) {
	f.t.Helper()
	if err := await(f.t, result); err != nil {
		f.t.Fatal(err)
	}
}

func TestStopClosesTheEdgeBeforeAskingWorkerdToExit(t *testing.T) {
	f := newShutdownFixture(t)
	f.child("drains", "product")
	f.child("quick", "apps")
	f.child("quick", "collector")
	response := f.request(http.MethodPost, "/stream")
	result := f.start()
	f.signals <- syscall.SIGTERM
	await(t, f.draining)
	f.timers.timer(testDrain) <- time.Now()
	f.clean(result)
	response.Body.Close()
	f.journalOrder(
		[2]string{"edge:cut", "product:term"}, [2]string{"edge:cut", "apps:term"},
		[2]string{"product:request-ended", "product:exit"},
		[2]string{"product:exit", "bridge:close"}, [2]string{"apps:exit", "bridge:close"},
		[2]string{"bridge:close", "collector:term"},
	)
}

func TestStopLetsAShortRequestFinish(t *testing.T) {
	f := newShutdownFixture(t)
	product := f.child("drains", "product")
	f.child("quick", "collector")
	response := f.beginRequest(http.MethodGet, "/short")
	if got := await(t, product.events); got != "request-started" {
		t.Fatal(got)
	}
	result := f.start()
	f.signals <- syscall.SIGTERM
	await(t, f.draining)
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", f.socket)
	}}
	defer transport.CloseIdleConnections()
	release, err := (&http.Client{Transport: transport, Timeout: 3 * time.Second}).Get("http://workerd/finish")
	if err != nil {
		t.Fatal(err)
	}
	release.Body.Close()
	reply := await(t, response)
	if reply.err != nil {
		t.Fatal(reply.err)
	}
	defer reply.response.Body.Close()
	body, err := io.ReadAll(reply.response.Body)
	if err != nil || string(body) != "complete" {
		t.Fatalf("got %q, %v; want complete response", body, err)
	}
	f.clean(result)
	f.journalOrder([2]string{"product:request-ended", "product:term"})
}

func TestStopCutsAStreamThatNeverEndsAtTheDrainDeadline(t *testing.T) {
	f := newShutdownFixture(t)
	product := f.child("drains", "product")
	f.child("quick", "collector")
	response := f.request(http.MethodPost, "/private?secret=not-logged")
	result := f.start()
	f.signals <- syscall.SIGTERM
	await(t, f.draining)
	stream := bufio.NewReader(response.Body)
	if line, err := stream.ReadString('\n'); err != nil || line != "data: open\n" {
		t.Fatalf("stream during drain: %q, %v", line, err)
	}
	select {
	case got := <-product.events:
		t.Fatalf("product got %q before the drain timer", got)
	default:
	}
	f.timers.timer(testDrain) <- time.Now()
	if _, err := io.ReadAll(stream); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("cut response should be incomplete, got %v", err)
	}
	f.clean(result)
	if log := f.log.String(); !strings.Contains(log, "POST text/event-stream:1") || strings.Contains(log, "secret") || strings.Contains(log, "private") {
		t.Fatalf("unexpected cut log: %s", log)
	}
}

func TestSecondSignalEndsTheDrain(t *testing.T) {
	f := newShutdownFixture(t)
	f.child("drains", "product")
	f.child("quick", "collector")
	f.request(http.MethodPost, "/stream")
	result := f.start()
	f.signals <- syscall.SIGTERM
	await(t, f.draining)
	f.signals <- syscall.SIGINT
	f.clean(result)
}

func TestARequestCutWhileWaitingForHeadersIsAnswered503(t *testing.T) {
	f := newShutdownFixture(t)
	product := f.child("drains", "product")
	f.child("quick", "collector")
	response := f.beginRequest(http.MethodGet, "/pending")
	if got := await(t, product.events); got != "request-started" {
		t.Fatal(got)
	}
	result := f.start()
	f.signals <- syscall.SIGTERM
	f.timers.timer(testDrain) <- time.Now()
	reply := await(t, response)
	if reply.err != nil {
		t.Fatal(reply.err)
	}
	defer reply.response.Body.Close()
	if reply.response.StatusCode != 503 || reply.response.Header.Get("Retry-After") == "" {
		t.Fatalf("got %d %v; want 503 with Retry-After", reply.response.StatusCode, reply.response.Header)
	}
	f.clean(result)
}

func openTestTunnel(t *testing.T, address string) (*bufio.Reader, net.Conn) {
	t.Helper()
	conn, err := net.DialTimeout("tcp", address, 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	conn.SetDeadline(time.Now().Add(4 * time.Second))
	fmt.Fprint(conn, "GET /upgrade HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n")
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, nil)
	if err != nil || response.StatusCode != 101 {
		t.Fatalf("expected upgrade: %v %v", response, err)
	}
	fmt.Fprint(conn, "ping\n")
	if line, err := reader.ReadString('\n'); line != "ping\n" || err != nil {
		t.Fatalf("tunnel echo was %q, %v", line, err)
	}
	return reader, conn
}

func TestStopCutsAHijackedTunnelAtTheDeadline(t *testing.T) {
	f := newShutdownFixture(t)
	f.child("drains", "product")
	f.child("quick", "collector")
	// A POST keeps the drain open even though http.Server ignores the hijacked tunnel.
	f.request(http.MethodPost, "/stream")
	tunnel, _ := openTestTunnel(t, strings.TrimPrefix(f.url, "http://"))
	// Exercise the BaseContext cut independently of the drain-start policy.
	f.parts.endStreams = func() {}
	result := f.start()
	f.signals <- syscall.SIGTERM
	f.timers.timer(testDrain) <- time.Now()
	if _, err := tunnel.ReadByte(); !errors.Is(err, io.EOF) {
		t.Fatalf("tunnel still open after cut: %v", err)
	}
	f.clean(result)
}

func TestStopEndsOpenEndedStreamsAtOnce(t *testing.T) {
	f := newShutdownFixture(t)
	f.child("drains", "product")
	f.child("quick", "collector")
	eventStream := f.request(http.MethodGet, "/stream")
	ndjson := f.request(http.MethodGet, "/ndjson")
	tunnel, _ := openTestTunnel(t, strings.TrimPrefix(f.url, "http://"))
	result := f.start()
	f.signals <- syscall.SIGTERM
	for _, response := range []*http.Response{eventStream, ndjson} {
		body, err := io.ReadAll(response.Body)
		if err != nil || len(body) == 0 {
			t.Fatalf("stream did not end with a clean EOF: %q (%v)", body, err)
		}
	}
	if _, err := tunnel.ReadByte(); !errors.Is(err, io.EOF) {
		t.Fatalf("upgrade not closed at drain start: %v", err)
	}
	f.clean(result)
}

func TestSupervisorDoesNotRestartAfterHold(t *testing.T) {
	for _, inBackoff := range []bool{false, true} {
		t.Run(fmt.Sprintf("backoff=%t", inBackoff), func(t *testing.T) {
			journal := filepath.Join(t.TempDir(), "child")
			var starts atomic.Int32
			ready := make(chan struct{}, 1)
			backoff := make(chan chan time.Time, 1)
			s := startSupervisor("test", func() *exec.Cmd {
				starts.Add(1)
				cmd := testChildCommand("quick", "apps", journal, "", "")
				cmd.Stdout = readyWriter{ready}
				return cmd
			}, time.Second, time.Second, func(time.Duration) <-chan time.Time {
				timer := make(chan time.Time, 1)
				backoff <- timer
				return timer
			})
			t.Cleanup(func() { stopChildren(time.Second, time.After, s) })
			await(t, ready)
			s.mu.Lock()
			child := s.current
			s.mu.Unlock()
			if inBackoff {
				child.cmd.Process.Signal(syscall.SIGTERM)
				timer := await(t, backoff)
				// Rescue a broken supervisor at cleanup only. The wait below must end
				// without firing the backoff timer.
				t.Cleanup(func() { timer <- time.Now() })
				s.hold()
			} else {
				s.hold()
				reported := false
				s.restartUnlessStopping(context.Background(), func() { reported = true })
				if reported {
					t.Fatal("restart acted after hold")
				}
				child.cmd.Process.Signal(syscall.SIGTERM)
			}
			await(t, s.finished)
			if starts.Load() != 1 || child.err != nil {
				t.Fatalf("held child: starts = %d, exit = %v", starts.Load(), child.err)
			}
		})
	}
}

type readyWriter struct{ ready chan<- struct{} }

func (w readyWriter) Write(p []byte) (int, error) {
	if bytes.Contains(p, []byte("ready\n")) {
		w.ready <- struct{}{}
	}
	return len(p), nil
}

func TestStopKillsOnlyAChildThatIgnoresSIGTERM(t *testing.T) {
	f := newShutdownFixture(t)
	product := f.child("drains", "product")
	apps := f.child("stubborn", "apps")
	collector := f.child("quick", "collector")
	result := f.start()
	f.signals <- syscall.SIGTERM
	if got := await(t, apps.events); got != "term" {
		t.Fatal(got)
	}
	await(t, product.exited)
	for _, child := range []*observedChild{apps, collector} {
		select {
		case <-child.exited:
			t.Fatalf("%s exited before apps grace expired", child.name)
		default:
		}
	}
	f.timers.timer(workerdGrace) <- time.Now()
	if err := await(t, result); err == nil || err.Error() != "apps did not stop within 10s; killed" {
		t.Fatalf("unexpected result: %v", err)
	}
	if !apps.cmd.ProcessState.Sys().(syscall.WaitStatus).Signaled() || apps.cmd.ProcessState.Sys().(syscall.WaitStatus).Signal() != syscall.SIGKILL || collector.err != nil || product.err != nil {
		t.Fatalf("exit statuses: apps %v, collector %v, product %v", apps.err, collector.err, product.err)
	}
	f.journalOrder([2]string{"product:exit", "bridge:close"}, [2]string{"bridge:close", "collector:term"})
}

func TestStopAfterTheProductExitedSkipsTheDrain(t *testing.T) {
	f := newShutdownFixture(t)
	ending := f.parts.edge.ending
	// A blocked handler makes waiting for graceful HTTP Shutdown observable.
	enter, leave := make(chan struct{}), make(chan struct{})
	existing := f.parts.edge.handler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(enter)
		defer close(leave)
		<-r.Context().Done()
	}))
	server := &http.Server{Handler: existing, BaseContext: func(net.Listener) context.Context { return f.parts.edge.base }}
	f.parts.public.Close()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f.parts.public, f.parts.listener, f.url = server, listener, "http://"+listener.Addr().String()
	go server.Serve(listener)
	t.Cleanup(func() { server.Close(); listener.Close() })
	f.beginRequest(http.MethodGet, "/")
	await(t, enter)
	product := f.child("dead", "product")
	f.child("quick", "collector")
	await(t, product.exited)
	result := f.start()
	await(t, leave)
	var exited *exec.ExitError
	if err := await(t, result); !errors.As(err, &exited) || exited.ExitCode() != 42 {
		t.Fatalf("want product exit 42, got %v", err)
	}
	select {
	case <-ending:
		t.Fatal("product exit must abort responses, not end streams cleanly")
	default:
	}
}

func TestStopFindsChildrenAlreadyGone(t *testing.T) {
	f := newShutdownFixture(t)
	product := f.child("quick", "product")
	for _, name := range []string{"apps", "collector"} {
		await(t, f.child("dead", name).exited)
	}
	result := f.start()
	f.signals <- syscall.SIGTERM
	f.clean(result)
	if product.err != nil {
		t.Fatal(product.err)
	}
	// No timer was fired. An already-dead child must not use up a grace period.
}

func TestAStalledProductAfterTheStopBeganIsIgnored(t *testing.T) {
	f := newShutdownFixture(t)
	f.child("drains", "product")
	f.child("quick", "collector")
	f.request(http.MethodPost, "/stream")
	result := f.start()
	f.signals <- syscall.SIGTERM
	await(t, f.draining)
	f.stalled <- errors.New("stale watchdog report")
	f.signals <- syscall.SIGTERM
	f.clean(result)
	if len(f.stalled) != 1 {
		t.Fatal("drain consumed a stale watchdog report")
	}
}

func TestStopAfterWatchdogStallCutsStreamsAndUsesShortGrace(t *testing.T) {
	f := newShutdownFixture(t)
	product := f.child("stalled", "product")
	f.child("quick", "collector")
	stream := f.request(http.MethodGet, "/stream")
	result := f.start()
	var log bytes.Buffer
	reportProductStall(&log, f.stalled, 3, 2*time.Second)
	const want = "Executor watchdog: the product did not answer 3 health checks in a row (every 2s); workerd is unresponsive, restarting it\n"
	if log.String() != want {
		t.Fatalf("watchdog detection log = %q; want %q", log.String(), want)
	}
	if _, err := io.ReadAll(stream.Body); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("stalled product stream must be aborted, got %v", err)
	}
	select {
	case <-f.parts.edge.ending:
		t.Fatal("watchdog must abort responses, not end streams cleanly")
	default:
	}
	for event := await(t, product.events); event != "term"; event = await(t, product.events) {
		if event != "request-ended" {
			t.Fatalf("got %q waiting for product SIGTERM", event)
		}
	}
	f.timers.timer(5 * time.Second) <- time.Now()
	if err := await(t, result); err == nil || !strings.Contains(err.Error(), "product did not stop within 5s; killed") {
		t.Fatalf("want watchdog failure with five-second escalation, got %v", err)
	}
}

type readerFunc func([]byte) (int, error)

func (f readerFunc) Read(buf []byte) (int, error) { return f(buf) }

func TestCutBodyPreservesCleanEOF(t *testing.T) {
	ctx, cut := context.WithCancelCause(context.Background())
	body := cutBody{ctx: ctx, ReadCloser: io.NopCloser(readerFunc(func(buf []byte) (int, error) {
		n := copy(buf, "last chunk")
		cut(errStopping)
		return n, io.EOF
	}))}
	got, err := io.ReadAll(&body)
	if string(got) != "last chunk" || err != nil {
		t.Fatalf("a response that completed at the cut returned %q, %v", got, err)
	}
}

func TestCutBodyDeliversTheLastReadWhenEndingAnOpenStream(t *testing.T) {
	ctx, cut := context.WithCancelCause(context.Background())
	body := cutBody{ctx: ctx, ReadCloser: io.NopCloser(readerFunc(func(buf []byte) (int, error) {
		n := copy(buf, "last chunk")
		cut(errEndStream)
		return n, nil
	}))}
	got, err := io.ReadAll(&body)
	if string(got) != "last chunk" || err != nil {
		t.Fatalf("an open-ended stream returned %q, %v; want last chunk and clean EOF", got, err)
	}
}

type closeFunc func()

func (f closeFunc) Close() error { f(); return nil }

type modelPublic struct{ closeFunc }

func (modelPublic) Shutdown(ctx context.Context) error { <-ctx.Done(); return ctx.Err() }

type modelChild struct {
	name   string
	log    func(string)
	exited chan struct{}
	err    error
}

func (c *modelChild) hold() { c.log("hold " + c.name) }

func (c *modelChild) stop(grace time.Duration, deadline <-chan struct{}) error {
	defer c.log("reap " + c.name)
	select {
	case <-c.exited:
		return c.err
	default:
	}
	c.log("term " + c.name)
	select {
	case <-c.exited:
		return c.err
	case <-deadline:
		select {
		case <-c.exited:
			return c.err
		default:
		}
		c.log("kill " + c.name)
		<-c.exited // A kill is not a reap; the driver must acknowledge the exit.
		return killedChild(c.name, grace)
	}
}

func TestShutdownKeepsItsOrderForEveryEventOrder(t *testing.T) {
	// Drain has one winning event. Workerd exit events race a shared deadline, and the
	// collector then has its own deadline. Enumerate those orders within their phases,
	// not permutations that inject every child exit before reaching the stop phase.
	workerdOrders := [][3]string{
		{"product", "apps", "timer"}, {"apps", "product", "timer"},
		{"product", "timer", "apps"}, {"apps", "timer", "product"},
		{"timer", "product", "apps"}, {"timer", "apps", "product"},
	}
	for _, drain := range []string{"second-signal", "product-exit", "drain-timer"} {
		for _, order := range workerdOrders {
			for _, collectorTimesOut := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/%s/collector-timeout=%t", drain, strings.Join(order[:], "-"), collectorTimesOut), func(t *testing.T) {
					synctest.Test(t, func(t *testing.T) {
						checkShutdownOrder(t, drain, order, collectorTimesOut)
					})
				})
			}
		}
	}
}

func checkShutdownOrder(t *testing.T, drain string, order [3]string, collectorTimesOut bool) {
	var mu sync.Mutex
	var trace []string
	log := func(event string) {
		mu.Lock()
		defer mu.Unlock()
		trace = append(trace, event)
	}
	child := func(name string) *modelChild {
		return &modelChild{name: name, log: log, exited: make(chan struct{})}
	}
	product, apps, collector := child("product"), child("apps"), child("collector")
	if drain == "product-exit" {
		product.err = errors.New("product failed")
	}
	signals := make(chan os.Signal, 2)
	timers := manualTimers{timers: make(map[time.Duration]chan time.Time)}
	e := newEdge()
	stopped := make(chan error, 1)
	go func() {
		stopped <- shutdown(shutdownParts{
			signals: signals, edge: e, public: modelPublic{func() { log("close public") }},
			product: product, productExited: product.exited, apps: apps, collector: collector,
			listener:      closeFunc(func() { log("close listener") }),
			endWatching:   func() { log("watchdogs off") },
			endAnnouncing: func() { log("announcer off") },
			endStreams:    func() {},
			joinWatching:  func() {},
			closeIdle: func() {
				if errors.Is(context.Cause(e.base), errStopping) {
					log("cut")
				}
			},
			closeBridge: func() { log("close bridge") },
		}, shutdownPlan{testDrain, workerdGrace, collectorGrace, timers.after, io.Discard})
	}()

	// Check exact effects after each event, once shutdown and all children have
	// settled. No next event can retroactively permit an early cut, TERM or KILL.
	expected := map[string]bool{}
	check := func() {
		t.Helper()
		synctest.Wait()
		has := func(event string) bool { return slices.Contains(trace, event) }
		before := func(first, second string) {
			i, j := slices.Index(trace, first), slices.Index(trace, second)
			if j >= 0 && (i < 0 || i >= j) {
				t.Errorf("%s must precede %s: %v", first, second, trace)
			}
		}
		for _, event := range []string{"cut", "close public", "close bridge",
			"term product", "term apps", "term collector",
			"kill product", "kill apps", "kill collector",
			"reap product", "reap apps", "reap collector"} {
			if has(event) != expected[event] {
				t.Errorf("want %s=%t: %v", event, expected[event], trace)
			}
		}
		for _, name := range []string{"product", "apps"} {
			for _, first := range []string{"hold apps", "hold collector", "watchdogs off", "announcer off", "close listener", "cut", "close public"} {
				before(first, "term "+name)
			}
			before("reap "+name, "close bridge")
		}
		before("close bridge", "term collector")
		for _, name := range []string{"product", "apps", "collector"} {
			before("term "+name, "kill "+name)
			if has("reap "+name) && has("kill "+name) {
				before("kill "+name, "reap "+name)
			}
		}
	}

	signals <- syscall.SIGTERM
	check()
	switch drain {
	case "second-signal":
		signals <- syscall.SIGINT
	case "product-exit":
		close(product.exited)
	case "drain-timer":
		timers.timer(testDrain) <- time.Now()
	}
	expected["cut"] = true
	check()

	timers.timer(cutGrace) <- time.Now()
	expected["close public"], expected["term apps"] = true, true
	expected["term product"] = drain != "product-exit"
	expected["reap product"] = drain == "product-exit"
	check()
	if !slices.Contains(trace, "term apps") && !slices.Contains(trace, "term product") {
		t.Error("the model must observe at least one workerd TERM in every run")
	}

	for _, event := range order {
		switch event {
		case "timer":
			for _, name := range []string{"product", "apps"} {
				// A child that has not exited must be killed when its grace expires,
				// but is still not reaped until we observe its exit.
				expected["kill "+name] = !expected["reap "+name]
			}
			if expected["kill product"] || expected["kill apps"] {
				timers.timer(workerdGrace) <- time.Now()
			}
		case "product":
			if drain != "product-exit" {
				close(product.exited)
			}
			expected["reap product"] = true
		case "apps":
			close(apps.exited)
			expected["reap apps"] = true
		}
		expected["close bridge"] = expected["reap product"] && expected["reap apps"]
		expected["term collector"] = expected["close bridge"]
		check()
	}
	if collectorTimesOut {
		timers.timer(collectorGrace) <- time.Now()
		expected["kill collector"] = true
		check()
	}
	close(collector.exited)
	expected["reap collector"] = true
	check()
	select {
	case err := <-stopped:
		for _, name := range []string{"product", "apps", "collector"} {
			reportedKilled := err != nil && strings.Contains(err.Error(), name+" did not stop")
			if reportedKilled != expected["kill "+name] {
				t.Errorf("want kill of %s reported=%t, got %v", name, expected["kill "+name], err)
			}
		}
		if product.err != nil && !errors.Is(err, product.err) {
			t.Errorf("product failure lost: %v", err)
		}
		wantFailure := product.err != nil || expected["kill product"] || expected["kill apps"] || expected["kill collector"]
		if (err != nil) != wantFailure {
			t.Errorf("want failure=%t, got %v", wantFailure, err)
		}
	default:
		t.Error("shutdown did not return after the collector was reaped")
	}
}
