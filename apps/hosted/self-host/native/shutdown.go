package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

const (
	drainGrace     = 10 * time.Second
	workerdGrace   = 10 * time.Second
	collectorGrace = 3 * time.Second
	// Let cancelled handlers release their upstreams and flush a 503 before Close tears
	// down their downstreams. A client that isn't reading cannot extend this wait.
	cutGrace = time.Second
)

var (
	errStopping  = errors.New("Executor is stopping")
	errEndStream = errors.New("ending open-ended response")
)

func stoppingResponse(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "5")
	http.Error(w, errStopping.Error(), http.StatusServiceUnavailable)
}

type edge struct {
	base   context.Context
	cut    context.CancelCauseFunc
	ending chan struct{}

	mu     sync.Mutex
	active map[*edgeRequest]struct{}
	idle   chan struct{}
}

type edgeRequestKey struct{}

type edgeRequest struct {
	method string
	media  string
	cancel context.CancelCauseFunc
}

func newEdge() *edge {
	base, cut := context.WithCancelCause(context.Background())
	idle := make(chan struct{})
	close(idle)
	return &edge{base: base, cut: cut, ending: make(chan struct{}), active: make(map[*edgeRequest]struct{}), idle: idle}
}

func (e *edge) handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		request := &edgeRequest{method: r.Method, media: "pending"}
		e.mu.Lock()
		if errors.Is(context.Cause(e.base), errStopping) {
			e.mu.Unlock()
			stoppingResponse(w)
			return
		}
		if len(e.active) == 0 {
			e.idle = make(chan struct{})
		}
		ctx, cancel := context.WithCancelCause(r.Context())
		request.cancel = cancel
		e.active[request] = struct{}{}
		e.mu.Unlock()
		defer func() {
			cancel(nil)
			e.mu.Lock()
			delete(e.active, request)
			if len(e.active) == 0 {
				close(e.idle)
			}
			e.mu.Unlock()
		}()
		next.ServeHTTP(w, r.WithContext(context.WithValue(ctx, edgeRequestKey{}, request)))
	})
}

func (e *edge) response(r *http.Response) error {
	media, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	upgrade := r.StatusCode == http.StatusSwitchingProtocols
	ctx := r.Request.Context()
	openEnded := r.Request.Method == http.MethodGet &&
		(media == "text/event-stream" || media == "application/x-ndjson")
	if upgrade {
		media = "upgrade"
	} else {
		if media == "" {
			media = "unspecified"
		}
		r.Body = &cutBody{ReadCloser: r.Body, ctx: ctx}
	}
	if request, ok := ctx.Value(edgeRequestKey{}).(*edgeRequest); ok {
		e.mu.Lock()
		request.media = media
		e.mu.Unlock()
		if openEnded || upgrade {
			if !upgrade {
				// We may end before the advertised length, so frame it as a stream.
				r.Header.Del("Content-Length")
				r.ContentLength = -1
			}
			go func() {
				select {
				case <-e.ending:
					// Cancels a blocked transport read, or closes the backend of an upgrade
					// through ReverseProxy, without losing its half-close support.
					request.cancel(errEndStream)
				case <-ctx.Done():
				}
			}()
		}
	}
	return nil
}

type cutBody struct {
	io.ReadCloser
	ctx context.Context
}

func (b *cutBody) Read(buf []byte) (int, error) {
	n, err := b.ReadCloser.Read(buf)
	if errors.Is(context.Cause(b.ctx), errEndStream) {
		return 0, io.EOF
	}
	if err != nil && errors.Is(context.Cause(b.ctx), errStopping) {
		// ReverseProxy still aborts the response, but does not log an intentional cut
		// as an upstream read error or present the truncated body as complete.
		err = context.Canceled
	}
	return n, err
}

func (e *edge) cutRequests(log io.Writer) <-chan struct{} {
	e.mu.Lock()
	counts := make(map[string]int)
	for r := range e.active {
		counts[r.method+" "+r.media]++
	}
	e.cut(errStopping)
	idle := e.idle
	e.mu.Unlock()
	fmt.Fprintf(log, "Executor shutdown: requests at cut: %v\n", counts)
	return idle
}

type process struct {
	name   string
	cmd    *exec.Cmd
	exited chan struct{}
	err    error // published by closing exited
}

func waitProcess(name string, cmd *exec.Cmd) *process {
	p := &process{name: name, cmd: cmd, exited: make(chan struct{})}
	go func() {
		p.err = cmd.Wait()
		close(p.exited)
	}()
	return p
}

// stopProcess sends SIGTERM once, escalates only at the shared deadline, and reaps even
// after escalation. Only the process owner calls it.
func stopProcess(p *process, deadline <-chan struct{}) (killed bool) {
	if p == nil {
		return false
	}
	select {
	case <-p.exited:
		return false
	default:
	}
	p.cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-p.exited:
		return false
	case <-deadline:
		select {
		case <-p.exited:
			return false
		default:
		}
		killed = p.cmd.Process.Kill() == nil
		<-p.exited
		return killed
	}
}

type stopper interface {
	stop(time.Duration, <-chan struct{}) error
}

type stoppable interface {
	stopper
	hold()
}

func (p *process) stop(grace time.Duration, deadline <-chan struct{}) error {
	if stopProcess(p, deadline) {
		return killedChild(p.name, grace)
	}
	return p.err
}

func killedChild(name string, grace time.Duration) error {
	return fmt.Errorf("%s did not stop within %s; killed", name, grace)
}

type shutdownParts struct {
	signals       <-chan os.Signal
	serverError   <-chan error
	stalled       <-chan error
	endWatching   func()
	endAnnouncing func()
	endStreams    func()
	joinWatching  func()
	public        publicServer
	listener      io.Closer
	edge          *edge
	closeIdle     func()
	closeBridge   func()
	product       stopper
	productExited <-chan struct{}
	apps          stoppable
	collector     stoppable
}

type publicServer interface {
	Shutdown(context.Context) error
	Close() error
}

type shutdownPlan struct {
	drain, workerd, collector time.Duration
	after                     func(time.Duration) <-chan time.Time
	log                       io.Writer
}

// shutdown owns the host lifecycle. Its phases only move forward:
// serving -> draining -> stoppingWorkerd -> stoppingCollector -> stopped.
func shutdown(parts shutdownParts, plan shutdownPlan) error {
	// Serving. Only this select can act on a product watchdog report.
	var reason error
	skipDrain := false
	select {
	case <-parts.signals:
	case reason = <-parts.serverError:
	case <-parts.productExited:
		skipDrain = true
	case reason = <-parts.stalled:
		skipDrain = true
	}

	// Draining. Stop creating upstream work before waiting on existing requests.
	parts.endWatching()
	parts.endAnnouncing()
	if parts.apps != nil {
		parts.apps.hold()
	}
	parts.collector.hold()
	parts.endStreams()
	// Close explicitly as Serve may not yet have registered the listener.
	parts.listener.Close()
	ctx, cancel := context.WithCancel(context.Background())
	drained := make(chan struct{})
	go func() {
		parts.public.Shutdown(ctx)
		close(drained)
	}()
	if !skipDrain {
		select {
		case <-drained:
		case <-plan.after(plan.drain):
		case <-parts.signals:
		case <-parts.productExited:
		}
	}
	idle := parts.edge.cutRequests(plan.log)
	parts.closeIdle()
	cutDeadline := plan.after(cutGrace)
	select {
	case <-drained: // regular handlers and their final response bytes
		// Shutdown does not wait for hijacked handlers.
		select {
		case <-idle:
		case <-cutDeadline:
		}
	case <-cutDeadline:
	}
	parts.public.Close()
	parts.closeIdle()
	cancel()
	<-drained

	// Stopping workerd. Both processes share one deadline; neither waits on the
	// other to receive SIGTERM. Keep the bridge and collector alive for both.
	err := errors.Join(reason, stopChildren(plan.workerd, plan.after, parts.product, parts.apps))
	parts.closeBridge()
	parts.joinWatching()

	// Stopping collector, then stopped.
	return errors.Join(err, stopChildren(plan.collector, plan.after, parts.collector))
}

func stopChildren(grace time.Duration, after func(time.Duration) <-chan time.Time, children ...stopper) error {
	deadline := make(chan struct{})
	timer := after(grace)
	results := make(chan error, len(children))
	pending := 0
	for _, child := range children {
		if child != nil {
			pending++
			go func() { results <- child.stop(grace, deadline) }()
		}
	}
	var result error
	for pending > 0 {
		select {
		case err := <-results:
			result = errors.Join(result, err)
			pending--
		case <-timer:
			close(deadline)
			timer = nil
		}
	}
	return result
}

type childState uint8

const (
	running childState = iota
	held
	stopping
	exited
	killed
)

type supervisor struct {
	name     string
	mu       sync.Mutex
	state    childState
	current  *process
	held     chan struct{}
	finished chan struct{}
	stopOnce sync.Once
	stopErr  error
}

func startSupervisor(name string, newCommand func() *exec.Cmd, minDelay, maxDelay time.Duration, after func(time.Duration) <-chan time.Time) *supervisor {
	s := &supervisor{name: name, held: make(chan struct{}), finished: make(chan struct{})}
	go s.run(newCommand, minDelay, maxDelay, after)
	return s
}

func (s *supervisor) run(newCommand func() *exec.Cmd, minDelay, maxDelay time.Duration, after func(time.Duration) <-chan time.Time) {
	defer close(s.finished)
	delay := minDelay
	for {
		s.mu.Lock()
		if s.state != running {
			s.mu.Unlock()
			return
		}
		cmd := newCommand()
		started := time.Now()
		err := cmd.Start()
		var p *process
		if err == nil {
			p = waitProcess(s.name, cmd)
			s.current = p
		}
		s.mu.Unlock()
		if err != nil {
			fmt.Fprintln(os.Stderr, s.name+" could not start:", err)
		} else {
			<-p.exited
			s.mu.Lock()
			s.current = nil
			retry := s.state == running
			s.mu.Unlock()
			if !retry {
				return
			}
			fmt.Fprintln(os.Stderr, s.name+" stopped; restarting")
		}
		if time.Since(started) > maxDelay {
			delay = minDelay
		}
		select {
		case <-after(delay):
		case <-s.held:
			return
		}
		delay = min(delay*2, maxDelay)
	}
}

func (s *supervisor) hold() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state == running {
		s.state = held
		close(s.held)
	}
}

func (s *supervisor) stop(grace time.Duration, deadline <-chan struct{}) error {
	s.stopOnce.Do(func() {
		s.hold()
		s.mu.Lock()
		s.state = stopping
		p := s.current
		s.mu.Unlock()
		wasKilled := stopProcess(p, deadline)
		<-s.finished
		s.mu.Lock()
		defer s.mu.Unlock()
		s.state = exited
		if wasKilled {
			s.state = killed
			s.stopErr = killedChild(s.name, grace)
		}
	})
	return s.stopErr
}

func (s *supervisor) restart() {
	s.restartUnlessStopping(context.Background(), func() {})
}

func (s *supervisor) restartUnlessStopping(ctx context.Context, report func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state == running && ctx.Err() == nil && s.current != nil {
		report()
		s.current.cmd.Process.Kill()
	}
}
