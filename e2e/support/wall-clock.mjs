/** Test-process entry preload: advance wall time without changing timers or monotonic durations. */
const offset = Number(process.env.EXECUTOR_TEST_CLOCK_OFFSET_MS);
if (!Number.isSafeInteger(offset) || offset < 0 || offset > 86_400_000) {
  throw new Error("The isolated test process needs a valid wall-clock offset");
}

const LiveDate = globalThis.Date;
const now = () => LiveDate.now() + offset;
// Own the clock at the process boundary so source and installed-artifact tests
// exercise the same production entry point. This file is never packaged.
globalThis.Date = new Proxy(LiveDate, {
  apply: () => new LiveDate(now()).toString(),
  construct: (target, args, newTarget) =>
    Reflect.construct(target, args.length === 0 ? [now()] : args, newTarget),
  get: (target, key, receiver) => (key === "now" ? now : Reflect.get(target, key, receiver)),
});
