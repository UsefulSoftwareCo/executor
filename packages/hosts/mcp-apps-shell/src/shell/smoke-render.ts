/**
 * Render an artifact once, server-side, to find out whether it renders at all.
 *
 * The failure this exists for: a model writes `<ChartTooltipContent />` without
 * a `<ChartContainer>`, `create-artifact` accepts it, the row saves, and then
 * the page dies with `useChart must be used within a <ChartContainer />`. The
 * artifact is broken, the user sees an error box, and the model — which got a
 * success back — has no idea. Rendering it once at create time moves that
 * discovery to the only moment it is cheap: the model is still holding the
 * code, and can fix it and retry before anyone sees it.
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
 * inner renderer mounts, with the same QueryClient defaults. Anything that
 * drifts is a bug in one shared source rather than a divergence between two.
 *
 * The one deliberate difference is the transport: every tool call returns a
 * promise that never settles, so every query stays `isPending` and the
 * component renders its loading state. That is exactly the state the user sees
 * first in the real frame, and it is the state a first-render crash happens in.
 *
 * ## Why `renderToReadableStream`
 *
 * It is exported under every `react-dom/server` condition this runs on (node,
 * bun, workerd's `server.edge`), it needs no DOM, and — unlike
 * `renderToStaticMarkup`, which ignores the option entirely — it calls `onError`
 * with the COMPONENT STACK. That stack is most of the value of the message the
 * model gets back: "useChart must be used within a <ChartContainer />" plus "at
 * ChartTooltipContent, at BarChart, at App" is a fix; the message alone is a
 * search. The bytes are read and discarded; only the error matters.
 *
 * ## Boundedness
 *
 * A render that throws is bounded by definition. A render that LOOPS is not,
 * and cannot be: a synchronous `while (true)` in a component body cannot be
 * preempted from the outside in JavaScript, so no timeout can rescue it. Such
 * an artifact would hang this request exactly as pathological `execute` code
 * hangs its own — the host's request timeout is the backstop, and solving it
 * properly is the halting problem. What IS guarded is the asynchronous side:
 * the stream is raced against a deadline, so a component that suspends forever
 * (rather than spinning) resolves as `ok` instead of hanging.
 */

import { StrictMode, createElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { compileJsx, evaluateComponent } from "./component-runtime";
import * as Components from "./components";
import { createToolsProxy } from "./tools-proxy";

/** What a smoke render can conclude. `ok` covers both "rendered" and "we could
 *  not tell" — only `failed` is ever a reason to refuse a create. */
export type SmokeRenderResult =
  | { readonly status: "ok" }
  | {
      readonly status: "failed";
      readonly message: string;
      readonly componentStack?: string;
    };

/** The QueryClient the inner renderer builds, to the same defaults. Retries and
 *  focus refetching are off there because an artifact's queries are proxied
 *  through the host; here it matters that nothing is scheduled at all. */
const makeQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });

/**
 * A transport whose promise never settles.
 *
 * Not a rejection and not a canned value: a rejection would put every query
 * into its error branch (so the smoke render would only ever exercise the error
 * path, and a component with no error handling would look broken when it is
 * not), and a canned value would be a data-shape guess. Pending is the honest
 * answer — nothing was fetched — and it is the state the real frame is in for
 * the first paint.
 */
const neverSettles = (): Promise<never> => new Promise<never>(() => {});

/** The component stack React reports alongside a render throw, when it has one.
 *  React 19 passes `{ componentStack }` as the second argument to `onError`. */
type RenderErrorInfo = { readonly componentStack?: string };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** How long the render may take before it is abandoned as inconclusive. Only
 *  reachable by a component that suspends without ever resolving; an ordinary
 *  artifact renders in single-digit milliseconds. */
const RENDER_DEADLINE_MS = 5_000;

/**
 * Compile and render `code` once. Throws nothing: every outcome is a result.
 *
 * A compile error or a missing `App` comes back as `failed` too — the model
 * gets the same message it would have seen in the frame, at the moment it can
 * still act on it.
 */
export const smokeRenderArtifact = async (code: string): Promise<SmokeRenderResult> => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: the whole purpose of this function is to convert a render throw into a value
  try {
    const compiled = compileJsx(code);
    const evaluated = evaluateComponent(compiled, createToolsProxy(neverSettles));
    if ("error" in evaluated) {
      return { status: "failed", message: evaluated.error };
    }

    const Component = evaluated.component;
    // React reports the throw through `onError` (which is where the component
    // stack lives) AND rejects the stream. The handler captures the FIRST
    // error, since a shell error boundary would have caught it there too.
    let failure: { message: string; componentStack?: string } | undefined;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), RENDER_DEADLINE_MS);

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: same reason as above, for the render itself
    try {
      // Written with `createElement` rather than JSX so this module stays a
      // plain `.ts` file. Hosts import it through the package entry, and two of
      // them (self-host, Cloudflare) typecheck without `jsx` configured — a
      // `.tsx` in their resolution graph is a hard error there even though they
      // never render anything themselves.
      const tree = createElement(
        StrictMode,
        null,
        createElement(
          Components.TooltipProvider,
          null,
          createElement(
            QueryClientProvider,
            { client: makeQueryClient() },
            createElement(Component),
          ),
        ),
      );
      const stream = await renderToReadableStream(tree, {
        signal: controller.signal,
        onError: (error: unknown, info: RenderErrorInfo) => {
          failure ??= {
            message: messageOf(error),
            ...(info.componentStack === undefined ? {} : { componentStack: info.componentStack }),
          };
        },
      });
      // The markup is discarded; draining it is only how the render is driven
      // to completion so a throw in a late child is still observed.
      await new Response(stream).text();
    } catch {
      // The stream's own rejection carries no component stack, so `onError`'s
      // record is preferred. Reaching here without one means the render was
      // aborted at the deadline rather than having thrown.
      if (failure) return { status: "failed", ...failure };
      return { status: "ok" };
    } finally {
      clearTimeout(deadline);
    }

    return failure ? { status: "failed", ...failure } : { status: "ok" };
  } catch (error) {
    // A throw from `compileJsx` or `evaluateComponent` — a syntax error, or
    // generated code that blew up at module scope. Same class, same answer.
    return { status: "failed", message: messageOf(error) };
  }
};
