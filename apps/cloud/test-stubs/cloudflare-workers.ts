// Stub for `cloudflare:workers` used by node-pool integration tests.
// Production code paths that read real bindings (Hyperdrive, LOADER,
// Durable Objects) aren't exercised by these tests.
//
// `db.ts#resolveConnectionString` reads `env.DATABASE_URL` from *this*
// module (the `cloudflare:workers` import), so we bridge selected keys
// from `process.env` into this stub at import time. Without this bridge
// the test DbService would dial the default postgres port instead of the
// PGlite socket server started by `scripts/test-globalsetup.ts`.
import { vi } from "@effect/vitest";

export const waitUntil = vi.fn<(work: Promise<unknown>) => void>();

export const env: Record<string, unknown> = {
  DATABASE_URL: process.env.DATABASE_URL,
  WORKOS_API_KEY: process.env.WORKOS_API_KEY,
  WORKOS_CLIENT_ID: process.env.WORKOS_CLIENT_ID,
  WORKOS_COOKIE_PASSWORD: process.env.WORKOS_COOKIE_PASSWORD,
};
export class WorkerEntrypoint {}
export class DurableObject {}
export class WorkflowEntrypoint {}
export class RpcTarget {}
export const exports: Record<string, unknown> = {};
