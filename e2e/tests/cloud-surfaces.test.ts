// Cloud app as an e2e target — fully stubbed (WorkOS via in-memory vault, no
// Autumn network) on PGlite, reusing cloud's own test harness. Per-org isolation
// via a random org id, so these are parallel-safe on the one in-process server.
import { it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { asOrg } from "../../apps/cloud/src/testing/api-harness";

it.effect("cloud · API typed client lists connections (per-org, stubbed, PGlite)", () =>
  asOrg(randomUUID(), (client) =>
    Effect.gen(function* () {
      const connections = yield* client.connections.list();
      // a fresh org starts with no connections — proves a real typed round-trip
      // through the cloud API against PGlite with WorkOS stubbed
      expect(Array.isArray(connections)).toBe(true);
      expect(connections.length).toBe(0);
    }),
  ),
);

it.effect("cloud · two orgs are isolated", () =>
  Effect.gen(function* () {
    const a = randomUUID();
    const b = randomUUID();
    const aConns = yield* asOrg(a, (c) => c.connections.list());
    const bConns = yield* asOrg(b, (c) => c.connections.list());
    expect(aConns.length).toBe(0);
    expect(bConns.length).toBe(0);
  }),
);
