package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// A thread's state from a tick: its letter and the CPU it used in the tick, in clock ticks.
type step struct {
	life  bool
	state byte
	used  uint64
}

// run feeds steps to a classifier and returns the rule each tick found ("" for none).
func run(c *stallClassifier, steps []step) []stallRule {
	cpu := c.last.cpu
	found := make([]stallRule, 0, len(steps))
	for _, s := range steps {
		cpu += s.used
		rule, _, _ := c.tick(s.life, threadSample{state: s.state, cpu: cpu})
		found = append(found, rule)
	}
	return found
}

func repeat(n int, s step) []step {
	steps := make([]step, n)
	for i := range steps {
		steps[i] = s
	}
	return steps
}

func firedAt(found []stallRule) (int, stallRule) {
	for i, rule := range found {
		if rule != "" {
			return i, rule
		}
	}
	return -1, ""
}

func TestParseThreadStat(t *testing.T) {
	// A command name may hold spaces and parentheses; fields count from the last ')'.
	sample, err := parseThreadStat("4242 (work (er) d) R 1 4242 4242 0 -1 4194560 100 0 0 0 1234 56 0 0 20 0 9 0 100 0 0")
	if err != nil {
		t.Fatal(err)
	}
	if sample.state != 'R' || sample.cpu != 1290 {
		t.Fatalf("sample = %c %d", sample.state, sample.cpu)
	}
	if _, err := parseThreadStat("4242 (workerd) R 1"); err == nil {
		t.Fatal("a short line was read")
	}
}

func TestBusyTicksFireAtTheLimit(t *testing.T) {
	c := newStallClassifier(5, 50, threadSample{state: 'S'})
	at, rule := firedAt(run(c, repeat(10, step{state: 'R', used: 99})))
	if at != 4 || rule != ruleBusy {
		t.Fatalf("fired at tick %d by %q, want tick 4 by busy", at, rule)
	}
}

func TestOneStallIsReportedOnce(t *testing.T) {
	c := newStallClassifier(3, 50, threadSample{state: 'S'})
	found := run(c, repeat(20, step{state: 'R', used: 99}))
	count := 0
	for _, rule := range found {
		if rule != "" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("reported %d times", count)
	}
	// After a sign of life the next stall is reported again.
	run(c, []step{{life: true, state: 'S'}})
	if at, _ := firedAt(run(c, repeat(3, step{state: 'R', used: 99}))); at != 2 {
		t.Fatalf("the next stall fired at tick %d", at)
	}
}

func TestTheBusyCPUIsTheThreshold(t *testing.T) {
	// A silent tick that used exactly the busy CPU counts as busy; one clock tick less does not.
	c := newStallClassifier(3, 50, threadSample{state: 'S'})
	if at, rule := firedAt(run(c, repeat(3, step{state: 'R', used: 50}))); at != 2 || rule != ruleBusy {
		t.Fatalf("at the busy CPU: fired at tick %d by %q, want tick 2 by busy", at, rule)
	}
	c = newStallClassifier(3, 50, threadSample{state: 'S'})
	if at, rule := firedAt(run(c, repeat(100, step{state: 'R', used: 49}))); at != -1 {
		t.Fatalf("below the busy CPU: fired at tick %d by %q", at, rule)
	}
}

func TestARecoveryReportsItsWindowOnce(t *testing.T) {
	// Three busy ticks fire the rule; a sleeping tick and a disk wait follow before the answer.
	c := newStallClassifier(2, 50, threadSample{state: 'S'})
	run(c, append(repeat(3, step{state: 'R', used: 60}), step{state: 'S'}, step{state: 'D'}))
	_, _, recovered := c.tick(true, threadSample{state: 'S', cpu: c.last.cpu})
	if recovered == nil {
		t.Fatal("the sign of life after a stall reported no recovery")
	}
	if recovered.silent != 5 || recovered.busy != 3 || recovered.idle != 1 || recovered.cpu != 180 {
		t.Fatalf("recovered %+v, want 5 silent, 3 busy, 1 idle, 180 clock ticks", *recovered)
	}
	if _, _, again := c.tick(true, threadSample{state: 'S', cpu: c.last.cpu}); again != nil {
		t.Fatalf("a second sign of life reported a recovery again: %+v", *again)
	}
	// A sign of life that ends a window which found no stall reports no recovery.
	c = newStallClassifier(5, 50, threadSample{state: 'S'})
	run(c, repeat(2, step{state: 'R', used: 60}))
	if _, _, quiet := c.tick(true, threadSample{state: 'S', cpu: c.last.cpu}); quiet != nil {
		t.Fatalf("a window with no stall reported a recovery: %+v", *quiet)
	}
}

func TestDiskWaitNeitherCountsNorResets(t *testing.T) {
	c := newStallClassifier(5, 50, threadSample{state: 'S'})
	steps := append(repeat(4, step{state: 'R', used: 99}), repeat(500, step{state: 'D', used: 1})...)
	steps = append(steps, step{state: 'R', used: 99})
	at, rule := firedAt(run(c, steps))
	if at != 504 || rule != ruleBusy {
		t.Fatalf("fired at tick %d by %q, want the busy tick after the disk wait", at, rule)
	}
	// Disk wait alone, for longer than either limit, never fires.
	c = newStallClassifier(5, 50, threadSample{state: 'S'})
	if at, rule := firedAt(run(c, repeat(1000, step{state: 'D', used: 0}))); at != -1 {
		t.Fatalf("disk wait fired at tick %d by %q", at, rule)
	}
}

func TestAStarvedThreadCountsUnderNeitherRule(t *testing.T) {
	// Runnable, but the machine gave it less than the busy CPU.
	c := newStallClassifier(5, 50, threadSample{state: 'S'})
	if at, rule := firedAt(run(c, repeat(1000, step{state: 'R', used: 10}))); at != -1 {
		t.Fatalf("a starved thread fired at tick %d by %q", at, rule)
	}
}

func TestASignOfLifeResets(t *testing.T) {
	c := newStallClassifier(5, 50, threadSample{state: 'S'})
	steps := []step{}
	for range 20 {
		steps = append(steps, repeat(4, step{state: 'R', used: 99})...)
		steps = append(steps, step{life: true, state: 'R', used: 99})
	}
	if at, rule := firedAt(run(c, steps)); at != -1 {
		t.Fatalf("a busy thread that answers fired at tick %d by %q", at, rule)
	}
}

func TestIdleRuleCountsSleepingAndStoppedTicks(t *testing.T) {
	c := newStallClassifier(4, 50, threadSample{state: 'S'})
	steps := append(repeat(10, step{state: 'S'}), repeat(9, step{state: 'T'})...)
	steps = append(steps, step{state: 'S'})
	at, rule := firedAt(run(c, steps))
	if at != 19 || rule != ruleIdle {
		t.Fatalf("fired at tick %d by %q, want tick 19 by idle", at, rule)
	}
}

func TestBusyCPUFollowsTheContainersQuota(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "cpu.max")
	cases := map[string]uint64{"max 100000": 50, "50000 100000": 25, "200000 100000": 50, "100 100000": 1}
	for content, want := range cases {
		os.WriteFile(file, []byte(content+"\n"), 0600)
		if got := busyCPU(file); got != want {
			t.Errorf("%q: %d clock ticks, want %d", content, got, want)
		}
	}
	if got := busyCPU(filepath.Join(directory, "missing")); got != 50 {
		t.Errorf("no cpu.max: %d", got)
	}
}

func TestStallSettings(t *testing.T) {
	settings, err := readStallSettings(map[string]string{})
	if err != nil || settings.seconds != 60 || settings.restart {
		t.Fatalf("defaults: %+v %v", settings, err)
	}
	settings, err = readStallSettings(map[string]string{"EXECUTOR_HOST_STALL_SECONDS": "0", "EXECUTOR_HOST_STALL_RESTART": "true"})
	if err != nil || settings.seconds != 0 || !settings.restart {
		t.Fatalf("set: %+v %v", settings, err)
	}
	for _, bad := range []map[string]string{{"EXECUTOR_HOST_STALL_SECONDS": "-1"}, {"EXECUTOR_HOST_STALL_SECONDS": "1m"}, {"EXECUTOR_HOST_STALL_RESTART": "yes"}} {
		if _, err := readStallSettings(bad); err == nil {
			t.Errorf("%v was accepted", bad)
		}
	}
}

// syncWriter is a log the watcher writes to while the test reads it.
type syncWriter struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (w *syncWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.Write(p)
}

func (w *syncWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.String()
}

// failure is the error a fake thread reading returns, if any.
type failure struct{ err error }

// watcher runs watchStalls with a fake ticker and thread. tick advances one tick and waits for the
// watcher to read the thread for it.
type watcher struct {
	ticks   chan time.Time
	sampled chan struct{}
	state   atomic.Value
	cpu     atomic.Uint64
	probes  atomic.Int32
	answer  atomic.Bool
	// fail, when set, is the error the thread's next readings return.
	fail    atomic.Value
	log     *syncWriter
	stalled chan stallReport
	done    chan struct{}
	ended   chan struct{}
}

func startWatcher(t *testing.T, settings stallSettings, armed <-chan struct{}) *watcher {
	w := &watcher{ticks: make(chan time.Time), sampled: make(chan struct{}, 1), log: &syncWriter{}, stalled: make(chan stallReport, 1), done: make(chan struct{}), ended: make(chan struct{})}
	w.state.Store(byte('S'))
	w.fail.Store(failure{})
	sample := func() (threadSample, error) {
		defer func() {
			select {
			case w.sampled <- struct{}{}:
			default:
			}
		}()
		if err := w.fail.Load().(failure).err; err != nil {
			return threadSample{}, err
		}
		return threadSample{state: w.state.Load().(byte), cpu: w.cpu.Load()}, nil
	}
	probe := func(ctx context.Context) bool {
		w.probes.Add(1)
		return w.answer.Load()
	}
	go func() {
		defer close(w.ended)
		watchStalls(settings, armed, w.ticks, sample, probe, &lifeSigns{}, 50, w.log, w.stalled, w.done)
	}()
	t.Cleanup(func() {
		select {
		case <-w.done:
		default:
			close(w.done)
		}
		<-w.ended
	})
	return w
}

func (w *watcher) tick(t *testing.T, state byte, used uint64) {
	t.Helper()
	w.state.Store(state)
	w.cpu.Add(used)
	select {
	case w.ticks <- time.Now():
	case <-w.ended:
		t.Fatal("the watcher returned")
	}
	<-w.sampled
	// Let a probe the tick started finish before the next tick.
	time.Sleep(2 * time.Millisecond)
}

func TestTheCheckCountsNothingUntilArmed(t *testing.T) {
	armed := make(chan struct{})
	w := startWatcher(t, stallSettings{seconds: 2}, armed)
	for range 3 {
		select {
		case w.ticks <- time.Now():
			t.Fatal("the watcher took a tick before it was armed")
		case <-time.After(20 * time.Millisecond):
		}
	}
	close(armed)
	<-w.sampled
	// The watcher takes this tick only once it has logged that it armed.
	w.tick(t, 'S', 0)
	if !strings.Contains(w.log.String(), "Stall check armed: busy rule 2 ticks, idle rule 10 ticks, busy at 0.50 CPU-seconds a tick, action log only") {
		t.Fatalf("log: %q", w.log.String())
	}
}

func TestLogOnlyLogsAStallOnceAndKeepsWatching(t *testing.T) {
	armed := make(chan struct{})
	close(armed)
	w := startWatcher(t, stallSettings{seconds: 3}, armed)
	<-w.sampled
	for range 10 {
		w.tick(t, 'R', 99)
	}
	log := w.log.String()
	if strings.Count(log, "Executor stopped responding") != 1 {
		t.Fatalf("log: %q", log)
	}
	for _, want := range []string{"rule busy, limit 3", "3 silent ticks: 3 busy, 0 sleeping or stopped", "main thread used 2.97 CPU-seconds", "states R 3", "log only, workerd left running"} {
		if !strings.Contains(log, want) {
			t.Errorf("log lacks %q: %q", want, log)
		}
	}
	select {
	case report := <-w.stalled:
		t.Fatalf("log-only sent %+v", report)
	default:
	}
	// One probe at a time, never more than one a tick and one as the check arms.
	if probes := w.probes.Load(); probes < 1 || probes > 11 {
		t.Fatalf("%d probes over 10 ticks", probes)
	}
	// The probe answers from the next tick on; its answer counts on a tick after it arrives.
	w.answer.Store(true)
	for range 100 {
		if strings.Contains(w.log.String(), "Executor answered again") {
			break
		}
		w.tick(t, 'S', 0)
	}
	if !regexp.MustCompile(`Executor answered again after 1\d silent ticks \(10 busy, \d+ sleeping or stopped`).MatchString(w.log.String()) {
		t.Fatalf("log: %q", w.log.String())
	}
	// A second busy window, after the first ended with its answer: one more stall, then exactly
	// one more answer, however long workerd keeps answering after it.
	w.answer.Store(false)
	for range 10 {
		if strings.Count(w.log.String(), "Executor stopped responding") == 2 {
			break
		}
		w.tick(t, 'R', 99)
	}
	w.answer.Store(true)
	for range 100 {
		if strings.Count(w.log.String(), "Executor answered again") == 2 {
			break
		}
		w.tick(t, 'S', 0)
	}
	for range 10 {
		w.tick(t, 'S', 0)
	}
	log = w.log.String()
	if stalls, answers := strings.Count(log, "Executor stopped responding"), strings.Count(log, "Executor answered again"); stalls != 2 || answers != 2 {
		t.Fatalf("%d stalls and %d answers over two busy windows, want one answer per stall: %q", stalls, answers, log)
	}
}

func TestRestartModeSendsTheStall(t *testing.T) {
	armed := make(chan struct{})
	close(armed)
	w := startWatcher(t, stallSettings{seconds: 2, restart: true}, armed)
	<-w.sampled
	for range 9 {
		w.tick(t, 'T', 0)
	}
	select {
	case report := <-w.stalled:
		t.Fatalf("sent %+v before the idle limit", report)
	default:
	}
	w.state.Store(byte('T'))
	w.ticks <- time.Now()
	select {
	case report := <-w.stalled:
		if report.rule != ruleIdle || report.window.idle != 10 {
			t.Fatalf("report %+v", report)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no stall sent")
	}
	if !strings.Contains(w.log.String(), "rule idle, limit 10; 10 silent ticks: 0 busy, 10 sleeping or stopped; main thread used 0.00 CPU-seconds; states T 10); restarting") {
		t.Fatalf("log: %q", w.log.String())
	}
}

func TestProxiedResponsesAreSignsOfLife(t *testing.T) {
	life := &lifeSigns{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500) }))
	defer upstream.Close()
	transport := lifeTransport{RoundTripper: http.DefaultTransport, life: life}
	request, _ := http.NewRequest("GET", upstream.URL, nil)
	response, err := transport.RoundTrip(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if !life.take() {
		t.Fatal("an answer of any status from workerd is a sign of life")
	}
	if life.take() {
		t.Fatal("take did not clear")
	}
	// A request that reaches no one gets the proxy's own error, which is not.
	request, _ = http.NewRequest("GET", "http://127.0.0.1:1/", nil)
	if _, err := transport.RoundTrip(request); err == nil {
		t.Fatal("expected an error")
	}
	if life.take() {
		t.Fatal("a failed request counted as a sign of life")
	}
}

// A workerd that honours SIGTERM exits 0. The host must still exit with an error, or a restart
// policy of on-failure would leave the container stopped.
// startTrapped starts a shell that handles SIGTERM with trap and returns once the shell says the
// trap is in place, with a channel that gets its Wait result.
func startTrapped(t *testing.T, trap string) (*exec.Cmd, chan error) {
	t.Helper()
	command := exec.Command("sh", "-c", "trap '"+trap+"' TERM; echo ready; while :; do sleep 0.05; done")
	output, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(output).ReadString('\n')
	if err != nil || line != "ready\n" {
		command.Process.Kill()
		t.Fatalf("the child did not say its trap was in place: %q %v", line, err)
	}
	stopped := make(chan error, 1)
	go func() { stopped <- command.Wait() }()
	return command, stopped
}

func TestStoppingAStalledWorkerdReturnsAnErrorWhenItExitsCleanly(t *testing.T) {
	command, stopped := startTrapped(t, "exit 0")
	err := stopStalled(command.Process, stopped, 5*time.Second)
	if !errors.Is(err, errWorkerdStalled) {
		t.Fatalf("err = %v", err)
	}
	if code := command.ProcessState.ExitCode(); code != 0 {
		t.Fatalf("the child exited %d, not cleanly; the case is not exercised", code)
	}
}

func TestStoppingAStalledWorkerdKillsItAfterTheGrace(t *testing.T) {
	command, stopped := startTrapped(t, "")
	started := time.Now()
	err := stopStalled(command.Process, stopped, 300*time.Millisecond)
	if !errors.Is(err, errWorkerdStalled) {
		t.Fatalf("err = %v", err)
	}
	if waited := time.Since(started); waited < 300*time.Millisecond {
		t.Fatalf("killed after %s, before the grace", waited)
	}
	status := command.ProcessState.Sys().(syscall.WaitStatus)
	if !status.Signaled() || status.Signal() != syscall.SIGKILL {
		t.Fatalf("status %v", status)
	}
}

// A count past the ceiling is refused at start, where five times it could otherwise overflow and
// make the idle rule fire on a healthy server's first silent tick.
func TestStallSecondsHaveACeiling(t *testing.T) {
	settings, err := readStallSettings(map[string]string{"EXECUTOR_HOST_STALL_SECONDS": "3600", "EXECUTOR_HOST_STALL_RESTART": "true"})
	if err != nil || settings.seconds != 3600 {
		t.Fatalf("3600: %+v %v", settings, err)
	}
	c := newStallClassifier(settings.seconds, 50, threadSample{state: 'S'})
	if rule, _, _ := c.tick(false, threadSample{state: 'S'}); rule != "" || c.idleLimit != 18000 {
		t.Fatalf("at the ceiling: rule %q, idle limit %d", rule, c.idleLimit)
	}
	for _, value := range []string{"3601", strconv.Itoa(int(^uint(0)>>1)/idleRuleFactor + 1), strconv.Itoa(int(^uint(0) >> 1))} {
		if _, err := readStallSettings(map[string]string{"EXECUTOR_HOST_STALL_SECONDS": value}); err == nil || !strings.Contains(err.Error(), "from 0 to 3600") {
			t.Errorf("%s: %v", value, err)
		}
	}
}

// A thread found waiting on disk counts toward neither rule even when it used a busy tick's CPU
// before it began to wait, and the busy ticks before it still count.
func TestDiskWaitWithBusyCPUCountsNeither(t *testing.T) {
	c := newStallClassifier(5, 50, threadSample{state: 'R'})
	steps := append(repeat(4, step{state: 'R', used: 99}), repeat(20, step{state: 'D', used: 60})...)
	steps = append(steps, step{state: 'R', used: 99})
	at, rule := firedAt(run(c, steps))
	if at != 24 || rule != ruleBusy {
		t.Fatalf("fired at tick %d by %q, want the busy tick after the disk wait", at, rule)
	}
}

// Two handled ticks are two ticks, however long apart: a paused container or a sleeping host must
// not add the time it was frozen. The watcher's thread stays stopped and never answers, so no sign
// of life can hide a count taken from elapsed time.
func TestTheCheckCountsHandledTicksNotElapsedTime(t *testing.T) {
	armed := make(chan struct{})
	close(armed)
	w := startWatcher(t, stallSettings{seconds: 1, restart: true}, armed)
	<-w.sampled
	w.tick(t, 'T', 0)
	time.Sleep(5 * time.Second)
	w.tick(t, 'T', 0)
	select {
	case report := <-w.stalled:
		t.Fatalf("two handled ticks, five seconds apart, were reported as %+v", report)
	default:
	}
	// The idle rule's five ticks are still counted as ticks.
	for range 2 {
		w.tick(t, 'T', 0)
	}
	w.state.Store(byte('T'))
	w.ticks <- time.Now()
	select {
	case report := <-w.stalled:
		if report.window.idle != 5 {
			t.Fatalf("report %+v", report)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("five stopped ticks were not reported")
	}
}

// A thread the check cannot read is reported once and read again every tick; it never switches the
// check off. A workerd that has exited ends the watcher without a word: the host's wait owns that.
func TestAnUnreadableThreadIsReportedAndRetried(t *testing.T) {
	armed := make(chan struct{})
	close(armed)
	w := startWatcher(t, stallSettings{seconds: 2, restart: true}, armed)
	<-w.sampled
	w.fail.Store(failure{os.ErrPermission})
	for range 20 {
		w.tick(t, 'T', 0)
	}
	if count := strings.Count(w.log.String(), "Stall check cannot read workerd's main thread"); count != 1 {
		t.Fatalf("logged %d times: %q", count, w.log.String())
	}
	select {
	case report := <-w.stalled:
		t.Fatalf("unreadable ticks were counted: %+v", report)
	default:
	}
	w.fail.Store(failure{})
	w.tick(t, 'T', 0)
	if !strings.Contains(w.log.String(), "Stall check reads workerd's main thread again") {
		t.Fatalf("log: %q", w.log.String())
	}
	// Counting resumes from the reading after the gap.
	for range 9 {
		w.tick(t, 'T', 0)
	}
	w.state.Store(byte('T'))
	w.ticks <- time.Now()
	select {
	case report := <-w.stalled:
		if report.window.idle != 10 {
			t.Fatalf("report %+v", report)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the check did not resume counting")
	}

	gone := startWatcher(t, stallSettings{seconds: 2}, armed)
	<-gone.sampled
	gone.fail.Store(failure{fs.ErrNotExist})
	gone.ticks <- time.Now()
	select {
	case <-gone.ended:
	case <-time.After(5 * time.Second):
		t.Fatal("the watcher kept running after workerd exited")
	}
	if strings.Contains(gone.log.String(), "cannot read") {
		t.Fatalf("an exited workerd was reported as unreadable: %q", gone.log.String())
	}
}

// The check's own /health request carries the header that keeps it out of the trace store, and
// the proxy removes that header from every request it forwards, so no outside caller can send it.
func TestOnlyTheHostsProbeAsksForAnUntracedHealthCheck(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "product.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	seen := make(chan string, 4)
	upstream := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.URL.Path + " " + r.Header.Get(hostProbeHeader)
	})}
	go upstream.Serve(listener)
	defer upstream.Close()
	if !healthProbe(socket, time.Second)(context.Background()) {
		t.Fatal("the probe got no answer")
	}
	if got := <-seen; got != "/health 1" {
		t.Fatalf("the probe sent %q", got)
	}
	front := httptest.NewServer(productProxy(socket, workerdIdleTimeout))
	defer front.Close()
	request, _ := http.NewRequest("GET", front.URL+"/health", nil)
	request.Header.Set(hostProbeHeader, "1")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if got := <-seen; got != "/health " {
		t.Fatalf("the proxy forwarded %q", got)
	}
}

// A first reading that fails is handled as any later one: logged once and tried again every tick.
// The CPU the thread used across the gap is never counted.
func TestAFailedFirstReadingIsRetried(t *testing.T) {
	armed := make(chan struct{})
	w := startWatcher(t, stallSettings{seconds: 2, restart: true}, armed)
	w.fail.Store(failure{os.ErrPermission})
	close(armed)
	<-w.sampled
	for range 5 {
		w.tick(t, 'R', 1000)
	}
	if count := strings.Count(w.log.String(), "Stall check cannot read workerd's main thread"); count != 1 {
		t.Fatalf("logged %d times: %q", count, w.log.String())
	}
	w.fail.Store(failure{})
	w.tick(t, 'R', 1000)
	if !strings.Contains(w.log.String(), "Stall check reads workerd's main thread again") {
		t.Fatalf("log: %q", w.log.String())
	}
	select {
	case report := <-w.stalled:
		t.Fatalf("the gap was counted: %+v", report)
	default:
	}
	w.tick(t, 'R', 99)
	w.state.Store(byte('R'))
	w.cpu.Add(99)
	w.ticks <- time.Now()
	select {
	case report := <-w.stalled:
		if report.rule != ruleBusy || report.window.busy != 2 || report.window.cpu != 198 {
			t.Fatalf("report %+v", report)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the check did not count after its first good reading")
	}
}

// The busy rule reads a real thread's CPU from /proc: a child process whose one thread spins is
// found busy, through the same reader the host uses for workerd.
func TestTheProcReaderCarriesARealThreadsCPUIntoTheBusyRule(t *testing.T) {
	child := exec.Command("sh", "-c", "while :; do :; done")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		child.Process.Kill()
		child.Wait()
	}()
	armed := make(chan struct{})
	close(armed)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	stalled := make(chan stallReport, 1)
	done := make(chan struct{})
	ended := make(chan struct{})
	log := &syncWriter{}
	go func() {
		defer close(ended)
		watchStalls(stallSettings{seconds: 2, restart: true}, armed, ticker.C, func() (threadSample, error) { return readThread(child.Process.Pid) }, func(context.Context) bool { return false }, &lifeSigns{}, busyCPU("/nonexistent"), log, stalled, done)
	}()
	defer func() {
		close(done)
		<-ended
	}()
	select {
	case report := <-stalled:
		if report.rule != ruleBusy || report.window.busy != 2 || report.window.cpu < 100 || report.window.states['R'] < 1 {
			t.Fatalf("report %+v", report)
		}
	case <-time.After(15 * time.Second):
		t.Fatalf("a spinning thread was not found busy: %q", log.String())
	}
}

// The CPU workerd used before the check armed, starting and opening its storage, is the first
// reading's starting point, not a busy tick.
func TestCPUUsedBeforeArmingIsNotCounted(t *testing.T) {
	armed := make(chan struct{})
	w := startWatcher(t, stallSettings{seconds: 1, restart: true}, armed)
	w.state.Store(byte('R'))
	w.cpu.Store(5000)
	close(armed)
	<-w.sampled
	w.tick(t, 'R', 0)
	select {
	case report := <-w.stalled:
		t.Fatalf("CPU used before arming was counted: %+v", report)
	default:
	}
	w.state.Store(byte('R'))
	w.cpu.Add(99)
	w.ticks <- time.Now()
	select {
	case report := <-w.stalled:
		if report.window.busy != 1 || report.window.cpu != 99 {
			t.Fatalf("report %+v", report)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a busy tick after arming was not counted")
	}
}
