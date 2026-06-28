// ---------------------------------------------------------------------------
// Edge concerns — the analytics/marketing/docs request middlewares that run at
// the worker edge BEFORE the app's own mcp + api dispatch. None of these touch
// the Effect app layer; they proxy or tunnel to external services (the
// marketing worker, Sentry, PostHog, Mintlify docs).
// ---------------------------------------------------------------------------

export { marketingMiddleware } from "./marketing";
export { sentryTunnelMiddleware } from "./sentry-tunnel";
export { posthogProxyMiddleware } from "./posthog";
export { docsProxyMiddleware } from "./docs";
export { openAiAppsChallengeMiddleware } from "./openai-apps-challenge";
