// Env-gated stub layers that turn `vite dev` into a fully-stubbed, logged-in
// instance — one target every surface (browser / API / MCP / CLI) can drive,
// replacing the bespoke in-process harnesses + e2e-server wiring.
//
// Enabled by `EXECUTOR_E2E_STUB=1`. NEVER set in production — when unset, the
// served route composition is byte-for-byte the real `*Live` layers.
import { WorkOSTestLayer, makeWorkOSTestState } from "../auth/workos.test-layer";
import { AutumnTestLayer, makeAutumnTestState } from "../extensions/billing/service.test-layer";

export const E2E_STUB = process.env.EXECUTOR_E2E_STUB === "1";

// Multi-user stub WorkOS: the `wos-session` cookie value IS the user id, with
// per-user membership buckets — so each test/browser picks a fresh user and is
// isolated on the one shared instance (no reset). Swapped in for
// `CoreSharedServices`, it authenticates every surface (session routes,
// /account/me, SSR) with no real WorkOS.
const workos = makeWorkOSTestState({ memberships: [], multiUser: true });
const autumn = makeAutumnTestState({}); // no paid subscription → free plan → 3-org limit applies

export const E2EStubWorkOSLayer = WorkOSTestLayer(workos);
export const E2EStubAutumnLayer = AutumnTestLayer(autumn);
