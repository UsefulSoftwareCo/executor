/**
 * Desktop-only renderer crash reporting.
 *
 * This bundle is served identically to `executor web`, self-host, and the
 * desktop app, so nothing is baked in at build time. Inside the desktop app
 * the preload bridge (`window.executor`) hands over a DSN at runtime —
 * everywhere else the bridge is absent (or returns null in DSN-less builds)
 * and Sentry is never imported, let alone initialized.
 *
 * Handled UI errors already flow through `globalThis.reportError` (see
 * packages/react error-reporting), which Sentry's global handlers pick up
 * once initialized — no reporter rewiring needed.
 */

interface CrashReportingConfig {
  readonly dsn: string;
  readonly release: string;
  readonly environment: string;
  readonly runId: string;
}

interface CrashReportingBridge {
  readonly getCrashReporting?: () => Promise<CrashReportingConfig | null>;
}

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
    } catch {
      // Reporting failures stay silent — there is nowhere left to report them.
    }
  };
  void init();
};
