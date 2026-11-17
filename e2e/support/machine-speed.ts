/**
 * How fast this machine is now, against a reference. CI's runners do the same work up to about
 * three times slower on weekday afternoons than at night or at weekends, on every runner size
 * (`.reference` report runner-speed-16-nov, 9-16 Nov). The catalog-scale scenario calibrates its
 * search budget with it, and a scenario or hook that times out records it (lifecycle.ts), so a
 * time-out in a slow hour reads as one.
 */
import { createHash } from "node:crypto";
import { Effect } from "effect";

/**
 * `machineWork` on the reference machine: CI's `blacksmith-8vcpu` scale lane in its normal hours
 * (weekends, and weekdays 00-12Z), where the catalog-scale search took a median 5.0 s (38 runs,
 * 9-16 Nov). Derived from a host whose search took 18.0-19.9 times its `machineWork`: 5,000 ms /
 * 18.9. Re-derive it from CI itself: the median `machine` of the "Search the whole catalog,
 * calibrated" line in the scale lane's job logs, over normal-hours runs.
 */
export const referenceMachineWorkMs = 265;

const machineBuffer = Buffer.alloc(1 << 20, 7);

/**
 * A fixed piece of CPU work with no product code in it: an integer loop and SHA-256 over a fixed
 * 1 MiB buffer, three times, in milliseconds (about 0.3 s). It runs in the test process; the
 * server's processes slow with it (in CI's slow hours the scale lane's `bun` and workerd CPU seconds
 * stretched 2.3x and 2.7x for the same work, the test process 2.0x, so it errs low).
 */
export const machineWorkMs = (): number => {
  const started = performance.now();
  let digest = "";
  for (let pass = 0; pass < 3; pass++) {
    let x = 0x9e3779b9;
    for (let i = 0; i < 60_000_000; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
    }
    digest += String(x);
    for (let i = 0; i < 72; i++)
      digest = createHash("sha256").update(machineBuffer).update(digest).digest("hex");
  }
  if (digest.length !== 64) throw new Error("machine work produced no digest");
  return Math.round(performance.now() - started);
};

export const machineWork = Effect.sync(machineWorkMs);

/**
 * What a time-out says about the machine, as one line: `timed out at 120 s (bound 120 s; machine
 * 1.9× slower than reference: 615 ms against 265 ms)`, or that it ran at reference speed or faster.
 */
export const timeoutLine = (boundMs: number, elapsedMs: number, machineMs: number) => {
  const slowdown = machineMs / referenceMachineWorkMs;
  const speed =
    slowdown >= 1.1
      ? `machine ${slowdown.toFixed(1)}× slower than reference: ${machineMs} ms against ${referenceMachineWorkMs} ms`
      : `machine at reference speed or faster: ${machineMs} ms against ${referenceMachineWorkMs} ms, so not a slow runner`;
  return `timed out at ${Math.round(elapsedMs / 1000)} s (bound ${Math.round(boundMs / 1000)} s; ${speed})`;
};
