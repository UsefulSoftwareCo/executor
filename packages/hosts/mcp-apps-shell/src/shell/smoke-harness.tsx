/**
 * The artifact smoke render, as it runs INSIDE the sandbox.
 *
 * This module is never imported by a host. It is bundled (React, the component
 * barrel, the tools proxy and all) into one self-contained script by
 * `bundleSmokeHarness`, and that script is what the QuickJS sandbox evaluates.
 * Nothing here runs in the trusted server process — which is the entire point,
 * since the code it renders was written by a model.
 *
 * The contract with the host is one global function and a JSON-shaped result:
 * `__executorSmokeRender(code)` resolves to `SmokeRenderResult`. It never
 * rejects; a render throw is a value, not an exception, so the host never has
 * to distinguish "the artifact is broken" from "the sandbox is broken".
 *
 * ## Host primitives QuickJS does not have
 *
 * `./smoke-harness-shims` supplies the few React's server renderer needs and
 * QuickJS lacks. It is imported first and for its side effects only: a bundler
 * initialises imports in order and before the importing module's own
 * statements, so that import is what guarantees the shims exist by the time
 * react-dom's module scope runs.
 */

// MUST be first: installs MessageChannel/TextEncoder/ReadableStream before
// react-dom's module scope reaches for them.
import "./smoke-harness-shims";

import { StrictMode, createElement } from "react";
import { renderToReadableStream } from "react-dom/server.browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { compileJsx, evaluateComponent } from "./component-runtime";
import * as Components from "./components";
import { createToolsProxy } from "./tools-proxy";
import type { SmokeRenderResult } from "./smoke-render-result";

/** The sandbox global, as a bag of names — the entry point is installed on it
 *  for the host to call. Same reasoning as in `./smoke-harness-shims`. */
const sandboxGlobal = globalThis as unknown as Record<string, unknown>;

// --------------------------------------------------------------------------
// The render itself. Mirrors the inner renderer's provider stack exactly, so a
// component that renders here renders in the frame.
// --------------------------------------------------------------------------

/** The QueryClient the inner renderer builds, to the same defaults. */
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

/** React 19 passes `{ componentStack }` as the second argument to `onError`. */
type RenderErrorInfo = { readonly componentStack?: string };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const render = async (code: string): Promise<SmokeRenderResult> => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: this function's whole purpose is turning a render throw into a value
  try {
    const compiled = compileJsx(code);
    const evaluated = evaluateComponent(compiled, createToolsProxy(neverSettles));
    if ("error" in evaluated) return { status: "failed", message: evaluated.error };

    // React reports the throw through `onError` (which is where the component
    // stack lives) AND rejects the stream. The handler captures the FIRST
    // error, since a shell error boundary would have caught it there too.
    let failure: { message: string; componentStack?: string } | undefined;

    const tree = createElement(
      StrictMode,
      null,
      createElement(
        Components.TooltipProvider,
        null,
        createElement(
          QueryClientProvider,
          { client: makeQueryClient() },
          createElement(evaluated.component),
        ),
      ),
    );

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: same reason, for the render itself
    try {
      const stream = await renderToReadableStream(tree, {
        onError: (error: unknown, info: RenderErrorInfo) => {
          failure ??= {
            message: messageOf(error),
            ...(info.componentStack === undefined ? {} : { componentStack: info.componentStack }),
          };
        },
      });
      // The markup is discarded; draining it is only how the render is driven
      // to completion so a throw in a late child is still observed.
      const reader = (stream as unknown as ReadableStream).getReader();
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // The stream's own rejection carries no component stack, so `onError`'s
      // record is preferred.
      if (failure) return { status: "failed", ...failure };
      return { status: "ok" };
    }

    return failure ? { status: "failed", ...failure } : { status: "ok" };
  } catch (error) {
    // A throw from `compileJsx` or `evaluateComponent` — a syntax error, or
    // generated code that blew up at module scope. Same class, same answer.
    return { status: "failed", message: messageOf(error) };
  }
};

/**
 * The sandbox's entry point, named for the host that calls it.
 *
 * Returns a JSON string rather than an object: the host reads the result out of
 * QuickJS across a boundary that only carries primitives, and a string keeps
 * that transfer explicit at both ends.
 */
sandboxGlobal["__executorSmokeRender"] = async (code: string): Promise<string> =>
  JSON.stringify(await render(code));
