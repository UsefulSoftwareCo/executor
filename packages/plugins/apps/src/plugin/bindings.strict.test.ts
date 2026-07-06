import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { buildBridge, type ClientResolver } from "./bindings";
import type { ConnectionDecl } from "../pipeline/descriptor";
import type { ScopeDbHandle } from "../seams/scope-db";

// ---------------------------------------------------------------------------
// Strict HandleBridge dispatch (Fix 4, grafted from build A). The bridge is the
// ONE channel out of the sandbox, so its dispatch must reject anything
// malformed, reserved, undeclared, or out-of-range rather than resolve it.
// ---------------------------------------------------------------------------

const okDb: ScopeDbHandle = {
  sql: () => Effect.succeed([]),
  exec: () => Effect.succeed([]),
  tableVersion: () => Effect.succeed(0),
  versions: () => Effect.succeed(new Map()),
};

const okResolver: ClientResolver = {
  call: () => Effect.succeed({ ok: true }),
};

const fails = <A, E>(effect: Effect.Effect<A, E>): Promise<boolean> =>
  Effect.runPromiseExit(effect).then((exit) => exit._tag === "Failure");

describe("HandleBridge strict dispatch", () => {
  const declared: Record<string, ConnectionDecl> = {
    gh: { kind: "single", integration: "github" },
    inboxes: { kind: "array", integration: "gmail" },
  };
  const bindings = {
    gh: { kind: "single", connection: "gh-main" } as const,
    inboxes: { kind: "array", connections: ["a", "b"] } as const,
  };
  const bridge = buildBridge({ declared, bindings, db: okDb, resolver: okResolver });

  it("rejects an empty method path", async () => {
    expect(await fails(bridge.call({ root: "gh", path: [], args: [] }))).toBe(true);
  });

  it("rejects a reserved root", async () => {
    expect(await fails(bridge.call({ root: "__proto__", path: ["x"], args: [] }))).toBe(true);
  });

  it("rejects an undeclared root", async () => {
    expect(await fails(bridge.call({ root: "ghost", path: ["x"], args: [] }))).toBe(true);
  });

  it("rejects an out-of-range fan-out index", async () => {
    expect(
      await fails(bridge.call({ root: "inboxes#5", path: ["messages", "list"], args: [] })),
    ).toBe(true);
  });

  it("rejects an index on a single-connection role", async () => {
    expect(await fails(bridge.call({ root: "gh#0", path: ["repos", "list"], args: [] }))).toBe(
      true,
    );
  });

  it("rejects an unsupported db call", async () => {
    expect(await fails(bridge.call({ root: "db", path: ["drop"], args: [] }))).toBe(true);
  });

  it("routes a valid single-connection call through the resolver", async () => {
    const out = await Effect.runPromise(
      bridge.call({ root: "gh", path: ["repos", "list"], args: [{}] }),
    );
    expect(out).toEqual({ ok: true });
  });

  it("routes a valid fan-out element through the resolver", async () => {
    const out = await Effect.runPromise(
      bridge.call({ root: "inboxes#1", path: ["messages", "list"], args: [{}] }),
    );
    expect(out).toEqual({ ok: true });
  });
});
