// ---------------------------------------------------------------------------
// Edge concerns — the analytics/marketing request middlewares that run at the
// worker edge BEFORE the app's own mcp + api dispatch. None of these touch the
// Effect app layer; they proxy or tunnel to external services (the marketing
// worker, Sentry, PostHog).
// ---------------------------------------------------------------------------

export { marketingMiddleware } from "./marketing";
export { sentryTunnelMiddleware } from "./sentry-tunnel";
export { posthogProxyMiddleware } from "./posthog";
