/**
 * Desktop-only renderer crash reporting.
 *
 * This bundle is served identically to `executor web`, self-host, and the
 * desktop app, so nothing is baked in at build time. Inside the desktop app
 * the preload bridge (`window.executor`) hands over a DSN at runtime —
 * everywhere else the bridge is absent (or returns null in DSN-less builds)
 * and Sentry is never imported, let alone initialized.
 *
 * Handled UI errors are reported through `reportRendererHandledError`, which
 * the root route hands to `ExecutorProvider`. Letting them fall through to
 * `globalThis.reportError` instead — as this module used to — filed them via
 * Sentry's global `onerror` handler, i.e. as UNHANDLED crashes, with the
 * surface/action context dropped on the floor. Until the DSN arrives (and in
 * every build without one) the global-event fallback still applies, so nothing
 * is lost in self-host.
 */
import {
  createSentryFrontendErrorReporter,
  reportViaGlobalErrorEvent,
  type FrontendErrorReporter,
} from "@executor-js/react/api/error-reporting";

interface CrashReportingConfig {
  readonly dsn: string;
  readonly release: string;
  readonly environment: string;
  readonly runId: string;
}

interface CrashReportingBridge {
  readonly getCrashReporting?: () => Promise<CrashReportingConfig | null>;
}

let initializedReporter: FrontendErrorReporter | null = null;

/**
 * The reporter the renderer's `ExecutorProvider` uses. Stable identity, so it
 * can be passed as a prop, and safe to call before (or without) Sentry init.
 */
export const reportRendererHandledError: FrontendErrorReporter = (error, context) => {
  (initializedReporter ?? reportViaGlobalErrorEvent)(error, context);
};

export const initDesktopCrashReporting = (): void => {
  if (typeof window === "undefined") return;
  const bridge = (window as Window & { readonly executor?: CrashReportingBridge }).executor;
  if (typeof bridge?.getCrashReporting !== "function") return;
  const init = async () => {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: crash reporting must never take the app down with it
    try {
      const config = await bridge.getCrashReporting?.();
      if (!config?.dsn) return;
      const Sentry = await import("@sentry/browser");
      Sentry.init({
        dsn: config.dsn,
        release: config.release,
        environment: config.environment,
        sendDefaultPii: false,
        tracesSampleRate: 0,
        initialScope: {
          tags: {
            process: "renderer",
            runId: config.runId,
          },
        },
      });
      initializedReporter = createSentryFrontendErrorReporter((error, applyScope) => {
        Sentry.captureException(error, (scope) => {
          applyScope(scope);
          return scope;
        });
      });
    } catch {
      // Reporting failures stay silent — there is nowhere left to report them.
    }
  };
  void init();
};
