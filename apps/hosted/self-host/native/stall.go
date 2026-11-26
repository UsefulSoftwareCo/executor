package main

// The stall check watches workerd after the product first answers. Everything Executor serves runs
// on workerd's one main thread, so when something holds that thread the whole instance stops
// answering, and before this check nothing noticed. A container health check only marks it
// unhealthy.
//
// The check counts its own one-second ticks, never elapsed time: a paused container or a sleeping
// host freezes this process too, and it handles at most one tick when it wakes. In each tick it
// asks whether workerd showed a sign of life (an answer to the check's own /health request over the
// product's private socket, or any response the proxy received from workerd) and what workerd's
// main thread did, from /proc. Two rules decide that workerd has stalled:
//
//   - busy: the thread used at least half a CPU-second in each of `seconds` ticks with no sign of
//     life, as when app code never returns;
//   - idle: the thread was sleeping or stopped, using little CPU, in 5 × `seconds` ticks with no
//     sign of life, as when the thread waits on something that never comes.
//
// A tick with the thread waiting on disk (state D), or runnable but given little CPU because the
// machine is busy, adds to neither count. Only a sign of life resets the counts: on a slow disk a
// healthy instance's /health waited minutes while its thread waited on disk, and a stall that the
// odd disk wait interrupted must not start counting again.
//
// By default the check only logs. With EXECUTOR_HOST_STALL_RESTART=true the host stops workerd and
// exits with an error, so the container's restart policy starts it again.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

// defaultStallSeconds is the busy rule's tick count; the idle rule counts five times as many. In
// the initial measurements without an added CPU quota, the longest a healthy instance's thread was
// measured busy without answering, under large builds and package installs, was 3 ticks on an
// otherwise idle 16-CPU machine (and on disks limited to 20 and 5 writes a second) and 8 on a 4-CPU
// machine running other instances beside two CPU-bound processes.
const defaultStallSeconds = 60

// idleRuleFactor scales the busy rule's count to the idle rule's.
const idleRuleFactor = 5

// maxStallSeconds is the largest busy rule count: an hour, so the idle rule's is five hours. A
// larger count would leave a stalled server down for longer than any operator would choose.
const maxStallSeconds = 3600

// clockTicksPerSecond is the unit of utime and stime in /proc/<pid>/stat (USER_HZ), 100 on every
// Linux architecture the image is built for.
const clockTicksPerSecond = 100

// stallSettings are the check's settings, read from the environment.
type stallSettings struct {
	// seconds is the busy rule's count; zero turns the check off.
	seconds int
	restart bool
}

func readStallSettings(values map[string]string) (stallSettings, error) {
	settings := stallSettings{seconds: defaultStallSeconds}
	if value := values["EXECUTOR_HOST_STALL_SECONDS"]; value != "" {
		number, err := strconv.Atoi(value)
		if err != nil || number < 0 || number > maxStallSeconds {
			return settings, fmt.Errorf("EXECUTOR_HOST_STALL_SECONDS must be an integer from 0 to %d", maxStallSeconds)
		}
		settings.seconds = number
	}
	switch values["EXECUTOR_HOST_STALL_RESTART"] {
	case "", "false":
	case "true":
		settings.restart = true
	default:
		return settings, errors.New("EXECUTOR_HOST_STALL_RESTART must be true or false")
	}
	return settings, nil
}

// threadSample is workerd's main thread as /proc shows it: its scheduler state and the CPU it has
// used in all, in clock ticks.
type threadSample struct {
	state byte
	cpu   uint64
}

// readThread reads the thread from /proc/<pid>/task/<pid>/stat. The main thread's ID is the
// process's. Fields after the command name, which may hold spaces or parentheses, start at the
// state; utime and stime are the 12th and 13th of them.
func readThread(pid int) (threadSample, error) {
	content, err := os.ReadFile(fmt.Sprintf("/proc/%d/task/%d/stat", pid, pid))
	if err != nil {
		return threadSample{}, err
	}
	return parseThreadStat(string(content))
}

func parseThreadStat(content string) (threadSample, error) {
	end := strings.LastIndexByte(content, ')')
	if end < 0 {
		return threadSample{}, errors.New("unreadable thread state")
	}
	fields := strings.Fields(content[end+1:])
	if len(fields) < 13 || len(fields[0]) != 1 {
		return threadSample{}, errors.New("unreadable thread state")
	}
	user, err := strconv.ParseUint(fields[11], 10, 64)
	if err != nil {
		return threadSample{}, errors.New("unreadable thread state")
	}
	system, err := strconv.ParseUint(fields[12], 10, 64)
	if err != nil {
		return threadSample{}, errors.New("unreadable thread state")
	}
	return threadSample{state: fields[0][0], cpu: user + system}, nil
}

// busyCPU is the CPU, in clock ticks, that makes a tick busy: half a CPU-second, scaled down when
// the container may use less than one CPU (cgroup v2 cpu.max), so a throttled container is judged
// against what it can get. At least one clock tick.
func busyCPU(cpuMaxFile string) uint64 {
	threshold := float64(clockTicksPerSecond) / 2
	if content, err := os.ReadFile(cpuMaxFile); err == nil {
		fields := strings.Fields(string(content))
		if len(fields) == 2 && fields[0] != "max" {
			quota, quotaErr := strconv.ParseFloat(fields[0], 64)
			period, periodErr := strconv.ParseFloat(fields[1], 64)
			if quotaErr == nil && periodErr == nil && quota > 0 && period > 0 && quota < period {
				threshold *= quota / period
			}
		}
	}
	return max(uint64(threshold), 1)
}

// stallRule names the rule that found a stall.
type stallRule string

const (
	ruleBusy stallRule = "busy"
	ruleIdle stallRule = "idle"
)

// stallWindow describes the ticks since workerd's last sign of life.
type stallWindow struct {
	silent, busy, idle int
	// cpu is what the thread used over the window, in clock ticks.
	cpu    uint64
	states map[byte]int
}

func (w stallWindow) describeStates() string {
	letters := make([]string, 0, len(w.states))
	for state := range w.states {
		letters = append(letters, string(state))
	}
	sort.Strings(letters)
	parts := make([]string, 0, len(letters))
	for _, letter := range letters {
		parts = append(parts, fmt.Sprintf("%s %d", letter, w.states[letter[0]]))
	}
	return strings.Join(parts, ", ")
}

// stallClassifier holds the counts. It reads no clock and no process: each call is one tick.
type stallClassifier struct {
	busyLimit, idleLimit int
	busyCPU              uint64
	window               stallWindow
	last                 threadSample
	// fired is true from a finding until the next sign of life, so one stall is reported once.
	fired bool
}

func newStallClassifier(seconds int, busyCPU uint64, first threadSample) *stallClassifier {
	return &stallClassifier{busyLimit: seconds, idleLimit: seconds * idleRuleFactor, busyCPU: busyCPU, last: first}
}

// tick takes one tick's evidence and returns the rule that found a stall, if one did in this tick.
// recovered is the window that ended when a sign of life followed a finding.
func (c *stallClassifier) tick(life bool, sample threadSample) (rule stallRule, window stallWindow, recovered *stallWindow) {
	used := sample.cpu - min(c.last.cpu, sample.cpu)
	c.last = sample
	if life {
		if c.fired {
			ended := c.window
			recovered = &ended
		}
		c.window = stallWindow{}
		c.fired = false
		return "", stallWindow{}, recovered
	}
	if c.window.states == nil {
		c.window.states = map[byte]int{}
	}
	c.window.silent++
	c.window.cpu += used
	c.window.states[sample.state]++
	// A thread waiting on disk counts toward neither rule, even after using CPU earlier in the
	// tick: a slow disk must never look like a stall.
	switch {
	case sample.state == 'D':
	case used >= c.busyCPU:
		c.window.busy++
	case sample.state == 'S' || sample.state == 'T' || sample.state == 't':
		c.window.idle++
	}
	if c.fired {
		return "", c.window, nil
	}
	if c.window.busy >= c.busyLimit {
		c.fired = true
		return ruleBusy, c.window, nil
	}
	if c.window.idle >= c.idleLimit {
		c.fired = true
		return ruleIdle, c.window, nil
	}
	return "", c.window, nil
}

// stallReport is what the check found, for the log and the host's exit.
type stallReport struct {
	rule   stallRule
	window stallWindow
}

func (r stallReport) describe(settings stallSettings) string {
	var what string
	if r.rule == ruleBusy {
		what = fmt.Sprintf("its main thread was busy for %d one-second ticks with no answer", r.window.busy)
	} else {
		what = fmt.Sprintf("its main thread was sleeping or stopped for %d one-second ticks with no answer", r.window.idle)
	}
	action := "log only, workerd left running (EXECUTOR_HOST_STALL_RESTART=true would restart it)"
	if settings.restart {
		action = "restarting: stopping workerd and exiting so the container restarts"
	}
	return fmt.Sprintf("Executor stopped responding: %s (rule %s, limit %d; %d silent ticks: %d busy, %d sleeping or stopped; main thread used %.2f CPU-seconds; states %s); %s",
		what, r.rule, map[stallRule]int{ruleBusy: settings.seconds, ruleIdle: settings.seconds * idleRuleFactor}[r.rule],
		r.window.silent, r.window.busy, r.window.idle, float64(r.window.cpu)/clockTicksPerSecond, r.window.describeStates(), action)
}

// errWorkerdStalled ends the host after the check stopped a stalled workerd. The host exits with it
// whatever workerd's own exit was: a workerd that honours SIGTERM exits 0, and a restart policy of
// on-failure would then leave the container stopped.
var errWorkerdStalled = errors.New("workerd stopped responding and was stopped; exiting so the container restarts")

// lifeSigns records that workerd answered. The proxy marks it on every response it receives from
// workerd, and the check's own probe on every answer.
type lifeSigns struct{ seen atomic.Bool }

func (l *lifeSigns) mark() {
	if l != nil {
		l.seen.Store(true)
	}
}

// take reports whether workerd answered since the last call.
func (l *lifeSigns) take() bool { return l.seen.Swap(false) }

// lifeTransport marks a sign of life for every response that came back from workerd. Errors are
// not: the proxy makes its own 502 and 503 answers for them.
type lifeTransport struct {
	http.RoundTripper
	life *lifeSigns
}

func (t lifeTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	response, err := t.RoundTripper.RoundTrip(request)
	if err == nil {
		t.life.mark()
	}
	return response, err
}

// hostProbeHeader marks the check's own /health request, which the product answers without
// recording a trace: one a second would fill the telemetry store. Only this host sends it: the
// proxy removes it from every request it forwards, and requests an app sends to its own instance
// lose it too.
const hostProbeHeader = "x-executor-host-probe"

// healthProbe asks the product's /health over its private socket, with a fresh connection each
// time. An answer of any status came from the product's thread, so it is a sign of life.
func healthProbe(socket string, timeout time.Duration) func(context.Context) bool {
	client := &http.Client{Timeout: timeout, Transport: &http.Transport{
		DisableKeepAlives: true,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		},
	}}
	return func(ctx context.Context) bool {
		request, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://product.internal/health", nil)
		request.Header.Set("x-executor-client-ip", "127.0.0.1")
		request.Header.Set(hostProbeHeader, "1")
		response, err := client.Do(request)
		if err != nil {
			return false
		}
		io.Copy(io.Discard, response.Body)
		response.Body.Close()
		return true
	}
}

// watchStalls runs the check until done closes. It starts counting when armed closes, the
// product's first ready answer, so start-up and migrations never count. Each tick it reads the
// thread, takes the signs of life and starts a probe if none is outstanding; the probe never holds
// a tick. In log-only mode it logs each stall once and keeps watching; in restart mode it sends the
// first stall on stalled and returns.
func watchStalls(settings stallSettings, armed <-chan struct{}, ticks <-chan time.Time, sample func() (threadSample, error), probe func(context.Context) bool, life *lifeSigns, busyCPU uint64, log io.Writer, stalled chan<- stallReport, done <-chan struct{}) {
	select {
	case <-armed:
	case <-done:
		return
	}
	// Without /proc (macOS development) there is no thread to read, then or later.
	if _, err := os.Stat("/proc/self/stat"); err != nil {
		fmt.Fprintf(log, "Stall check is off: this system has no /proc (%v)\n", err)
		return
	}
	action := "log only"
	if settings.restart {
		action = "restart"
	}
	fmt.Fprintf(log, "Stall check armed: busy rule %d ticks, idle rule %d ticks, busy at %.2f CPU-seconds a tick, action %s\n",
		settings.seconds, settings.seconds*idleRuleFactor, float64(busyCPU)/clockTicksPerSecond, action)
	classifier := newStallClassifier(settings.seconds, busyCPU, threadSample{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var outstanding atomic.Bool
	life.take()
	// The first reading, taken as the check arms, only sets the starting point for the CPU the
	// thread uses; so does the first reading after any that failed.
	baseline := false
	unreadable := false
	for first := true; ; first = false {
		if !first {
			select {
			case <-done:
				return
			case <-ticks:
			}
		}
		current, err := sample()
		counted := false
		switch {
		case errors.Is(err, os.ErrNotExist):
			// workerd has exited and been reaped; the host's own wait ends the host.
			return
		case err != nil:
			// The check must not switch itself off without saying so. It counts nothing while it
			// cannot read the thread and tries again every tick: a read costs about a microsecond,
			// and a failure that passes leaves the check working. A sign of life stays marked
			// until a tick can use it.
			if !unreadable {
				fmt.Fprintf(log, "Stall check cannot read workerd's main thread (%v); it counts nothing until it can, and tries again every tick\n", err)
				unreadable = true
			}
		case unreadable || !baseline:
			// The CPU used since the last good reading, if any, may span many ticks, so this
			// reading only takes a new starting point.
			if unreadable {
				fmt.Fprintln(log, "Stall check reads workerd's main thread again")
			}
			unreadable = false
			baseline = true
			classifier.last = current
		default:
			counted = true
		}
		if counted {
			rule, window, recovered := classifier.tick(life.take(), current)
			if recovered != nil {
				fmt.Fprintf(log, "Executor answered again after %d silent ticks (%d busy, %d sleeping or stopped; main thread used %.2f CPU-seconds; states %s)\n",
					recovered.silent, recovered.busy, recovered.idle, float64(recovered.cpu)/clockTicksPerSecond, recovered.describeStates())
			}
			if rule != "" {
				report := stallReport{rule: rule, window: window}
				fmt.Fprintln(log, report.describe(settings))
				if settings.restart {
					select {
					case stalled <- report:
					case <-done:
					}
					return
				}
			}
		}
		if outstanding.CompareAndSwap(false, true) {
			go func() {
				defer outstanding.Store(false)
				if probe(ctx) {
					life.mark()
				}
			}()
		}
	}
}

// stopStalled ends a stalled workerd: SIGTERM, then SIGKILL after grace. It returns
// errWorkerdStalled whatever workerd's exit, so the host exits non-zero.
func stopStalled(process *os.Process, stopped <-chan error, grace time.Duration) error {
	process.Signal(syscall.SIGTERM)
	select {
	case <-stopped:
	case <-time.After(grace):
		process.Kill()
		<-stopped
	}
	return errWorkerdStalled
}

// stallGrace is how long a stalled workerd has to exit on SIGTERM before SIGKILL.
const stallGrace = 5 * time.Second

// stallProbeTimeout bounds the check's /health request. A probe that times out is no sign of life;
// the counts never depend on how long it waited.
const stallProbeTimeout = 10 * time.Second
