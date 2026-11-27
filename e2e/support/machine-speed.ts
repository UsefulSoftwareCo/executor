import { createHash } from "node:crypto";
import { Effect } from "effect";

export const referenceMachineWorkMs = 265;

const machineBuffer = Buffer.alloc(1 << 20, 7);

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

export const timeoutLine = (boundMs: number, elapsedMs: number, machineMs: number) => {
  const slowdown = machineMs / referenceMachineWorkMs;
  const speed =
    slowdown >= 1.1
      ? `machine ${slowdown.toFixed(1)}× slower than reference: ${machineMs} ms against ${referenceMachineWorkMs} ms`
      : `machine at reference speed or faster: ${machineMs} ms against ${referenceMachineWorkMs} ms, so not a slow runner`;
  return `timed out at ${Math.round(elapsedMs / 1000)} s (bound ${Math.round(boundMs / 1000)} s; ${speed})`;
};
