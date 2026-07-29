/**
 * Render an artifact once, in a sandbox, to find out whether it renders at all.
 *
 * The failure this exists for: a model writes `<ChartTooltipContent />` without
 * a `<ChartContainer>`, `create-artifact` accepts it, the row saves, and then
 * the page dies with `useChart must be used within a <ChartContainer />`. The
 * artifact is broken, the user sees an error box, and the model — which got a
 * success back — has no idea. Rendering it once at create time moves that
 * discovery to the only moment it is cheap: the model is still holding the
 * code, and can fix it and retry before anyone sees it.
 *
 * ## Where the code runs, and why that is the whole design
 *
 * The code being rendered was written by a model. It is untrusted, exactly as
 * untrusted as anything `execute` runs — so it runs in the same place: a
 * QuickJS sandbox from the kernel. It never runs in this process.
 *
 * That is not a precaution, it is the only defensible arrangement. An earlier
 * version of this file compiled the artifact and built its component with
 * `new Function` right here, in the trusted server, relying on the ~280-name
 * scope to shadow anything dangerous. Shadowing is not a sandbox: the scope
 * only binds identifiers the code chooses to mention, and `globalThis.process`
 * or `Function("return process")()` walk straight past it to the host's
 * environment — its secrets, its database handle, its network. There is no
 * version of that idea that is safe, so none of it survives here.
 *
 * What crosses the boundary now is a string in and a string out. `code` is
 * embedded as a JSON literal in the expression the sandbox evaluates, and a
 * JSON `SmokeRenderResult` comes back. The renderer itself — React,
 * react-dom/server, the component barrel, the tools proxy, the QueryClient —
 * is prebuilt into `smoke-harness-bundle.gen.ts` and lives entirely inside the
 * sandbox. This process holds no React at all.
 *
 * ## One path, every host
 *
 * QuickJS is a WASM interpreter, so `new Function` inside it is QuickJS
 * building a QuickJS function — not V8 compiling a string. workerd's ban on
 * runtime codegen is a ban on V8 codegen, which is why this same path works on
 * Cloudflare, and why the old "probe `new Function`, skip the check where it
 * throws" carve-out is gone along with the in-process evaluator. Cloud used to
 * silently smoke-render nothing; now it runs the real check like everyone else.
 *
 * ## What it does and does not catch
 *
 * It catches a SYNCHRONOUS FIRST-RENDER THROW: a missing provider, a
 * ReferenceError, a bad hook call, reading a property of something that is
 * undefined before any data has arrived. That last one is not a false positive
 * — `data` genuinely is undefined while a query is pending, so a component that
 * dereferences it without a guard crashes for real, every time, in front of the
 * user. Catching it is the point.
 *
 * It does NOT catch data-shape errors: code that only throws once a tool
 * returns a payload of an unexpected shape. Nothing is fetched here, and
 * inventing a plausible payload would be worse than not trying — it would
 * reject correct code whenever the guess was wrong. That class stays a runtime
 * error inside the frame, where the shell's error boundary already reports it.
 *
 * ## How it stays faithful to the real renderer
 *
 * Everything the component sees comes from the same modules the iframe uses:
 * `compileJsx`/`evaluateComponent` for the scope, `createToolsProxy` for
 * `tools`, and the same `TooltipProvider` + `QueryClientProvider` stack the
 * inner renderer mounts, with the same QueryClient defaults — all of it now
 * compiled into the harness rather than imported here. Anything that drifts is
 * a bug in one shared source rather than a divergence between two.
 *
 * The one deliberate difference is the transport: every tool call returns a
 * promise that never settles, so every query stays `isPending` and the
 * component renders its loading state. That is exactly the state the user sees
 * first in the real frame, and it is the state a first-render crash happens in.
 *
 * ## Boundedness
 *
 * The sandbox's interrupt handler preempts the interpreter, so a synchronous
 * `while (true)` in a component body is now stopped at the deadline. In-process
 * it could not be — no timeout can interrupt a spinning host thread — and such
 * an artifact hung the whole request. Getting that for free is a second reason
 * this belongs in the kernel.
 *
 * ## Fail open
 *
 * A missing harness bundle, an unavailable sandbox, a deadline: all `ok`.
 * "Inconclusive" must never read as "broken", because the cost of a false
 * rejection is a model unable to save correct code. Only a render error from
 * the artifact ITSELF returns `failed`.
 */

import { executeSealedBundle } from "@executor-js/runtime-quickjs";
import * as Effect from "effect/Effect";

import harnessBundle from "./smoke-harness-bundle.gen";
import type { SmokeRenderResult } from "./smoke-render-result";

export type { SmokeRenderResult } from "./smoke-render-result";

/** How long the render may take before it is abandoned as inconclusive. An
 *  ordinary artifact loads the harness and renders in a few hundred
 *  milliseconds; this only bounds pathological code. */
const RENDER_DEADLINE_MS = 10_000;

const OK: SmokeRenderResult = { status: "ok" };

/**
 * How the sandbox is reached. Indirected through a mutable binding for exactly
 * one reason: the fail-open contract is the most important behaviour here and
 * the hardest to provoke honestly — a real missing sandbox cannot be arranged
 * from a test without breaking the runtime for every other test in the file.
 * Swapping this seam simulates it at the boundary the host actually depends on.
 */
type SealedBundleRunner = typeof executeSealedBundle;

let runSealedBundle: SealedBundleRunner = executeSealedBundle;

/**
 * Replace the sandbox call for the duration of a scope. Test-only, and
 * `Disposable` so it cannot leak past the `using` that installed it.
 */
export const stubSealedBundle = (runner: SealedBundleRunner): Disposable => {
  const previous = runSealedBundle;
  runSealedBundle = runner;
  return {
    [Symbol.dispose]: () => {
      runSealedBundle = previous;
    },
  };
};

/** Narrow the sandbox's JSON back to the contract. Anything unrecognized is
 *  `ok` — see the fail-open note in the header. */
const parseResult = (json: string): SmokeRenderResult => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: parsing a value that crossed a sandbox boundary
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return OK;
    const record = parsed as { status?: unknown; message?: unknown; componentStack?: unknown };
    if (record.status !== "failed" || typeof record.message !== "string") return OK;
    return {
      status: "failed",
      message: record.message,
      ...(typeof record.componentStack === "string"
        ? { componentStack: record.componentStack }
        : {}),
    };
  } catch {
    return OK;
  }
};

/**
 * Render `code` once in a sandbox. Throws nothing: every outcome is a result.
 *
 * A compile error or a missing `App` comes back as `failed` too — the model
 * gets the same message it would have seen in the frame, at the moment it can
 * still act on it.
 */
export const smokeRenderArtifact = async (code: string): Promise<SmokeRenderResult> => {
  // No harness in this build. Nothing can be concluded, so conclude nothing.
  if (harnessBundle === null) return OK;

  return Effect.runPromise(
    runSealedBundle({
      bundle: harnessBundle,
      // The artifact's source crosses as a JSON string literal inside the
      // expression — the only value this process hands the sandbox, and never
      // as a global it could be reached through.
      call: `globalThis.__executorSmokeRender(${JSON.stringify(code)})`,
      timeoutMs: RENDER_DEADLINE_MS,
    }).pipe(
      Effect.map(parseResult),
      // A sandbox-side failure is not the artifact's fault. Log it and save.
      Effect.catch((error) =>
        Effect.as(Effect.logWarning("artifact smoke render was unavailable", error), OK),
      ),
    ),
  );
};
