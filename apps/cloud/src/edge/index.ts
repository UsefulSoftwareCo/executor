// ---------------------------------------------------------------------------
// Edge concerns — request middleware that runs before the app's own mcp + api
// dispatch. These proxy or tunnel to external services without touching the
// Effect app layer. Marketing is dispatched even earlier, from server.ts, so a
// public page never loads the TanStack Start graph.
// ---------------------------------------------------------------------------

export { sentryTunnelMiddleware } from "./sentry-tunnel";
export { posthogProxyMiddleware } from "./posthog";
export { docsProxyMiddleware } from "./docs";
export { openAiAppsChallengeMiddleware } from "./openai-apps-challenge";
