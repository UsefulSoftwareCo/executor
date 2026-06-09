// The cloud app as a target: the stubbed dev server (`vite dev` +
// EXECUTOR_E2E_STUB=1) — real SSR, real routes, real PGlite-backed DB, WorkOS
// and Autumn stubbed in-memory. Isolation: the stub resolves the user FROM the
// wos-session cookie value, so every identity is a fresh user (and org) on the
// one shared instance — no resets. Boot lives in setup/cloud.globalsetup.ts.
import { randomUUID } from "node:crypto";

import { Effect } from "effect";

import type { Identity, Target } from "../src/target";

export const CLOUD_PORT = Number(process.env.E2E_CLOUD_PORT ?? 4798);
export const CLOUD_DB_PORT = Number(process.env.E2E_CLOUD_DB_PORT ?? 5436);
export const CLOUD_BASE_URL = process.env.E2E_CLOUD_URL ?? `http://127.0.0.1:${CLOUD_PORT}`;

const freshId = () => randomUUID().slice(0, 8);

export const cloudTarget = (): Target => ({
  name: "cloud",
  baseUrl: CLOUD_BASE_URL,
  mcpUrl: `${CLOUD_BASE_URL}/mcp`,
  capabilities: new Set(["api", "browser", "billing"]),
  newIdentity: ({ org = true } = {}) =>
    Effect.promise(async (): Promise<Identity> => {
      const user = `user_${freshId()}`;
      // The stub WorkOS resolves the user FROM the cookie value; a bare value
      // is a fresh signed-in user with no organization yet.
      let value = user;
      if (org) {
        // Go through the REAL product flow: create the org via the session
        // route and adopt the refreshed `<user>|org:<org>` cookie it sets —
        // membership and session state come from the same path real users take.
        const response = await fetch(new URL("/api/auth/create-organization", CLOUD_BASE_URL), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: new URL(CLOUD_BASE_URL).origin,
            cookie: `wos-session=${value}`,
          },
          body: JSON.stringify({ name: `Org ${user}` }),
        });
        if (!response.ok) {
          throw new Error(`cloud newIdentity: create-organization → ${response.status}`);
        }
        const refreshed = (response.headers.getSetCookie?.() ?? [])
          .map((cookie) => /^wos-session=([^;]+)/.exec(cookie)?.[1])
          .find(Boolean);
        if (!refreshed) throw new Error("cloud newIdentity: no refreshed session cookie");
        value = decodeURIComponent(refreshed);
      }
      return {
        label: user,
        headers: { cookie: `wos-session=${value}` },
        cookies: [{ name: "wos-session", value }],
      };
    }),
});
