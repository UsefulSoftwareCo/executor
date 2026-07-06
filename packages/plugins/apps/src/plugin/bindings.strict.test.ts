import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { buildBridge, resolveIntegrationBindings, type ClientResolver } from "./bindings";
import type { IntegrationDecl } from "../pipeline/descriptor";
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
  listConnections: ({ integration }) =>
    Effect.succeed([
      {
        address: `tools.${integration}.user.main`,
        integration,
        name: "main",
        owner: "user",
      },
    ]),
  resolveConnection: ({ connection }) =>
    Effect.succeed(
      connection === "tools.github.user.main" || connection === "main"
        ? {
            address: "tools.github.user.main",
            integration: "github",
            name: "main",
            owner: "user",
          }
        : null,
    ),
  call: () => Effect.succeed({ ok: true }),
};

const fails = <A, E>(effect: Effect.Effect<A, E>): Promise<boolean> =>
  Effect.runPromiseExit(effect).then((exit) => exit._tag === "Failure");

describe("HandleBridge strict dispatch", () => {
  const declared: Record<string, IntegrationDecl> = {
    gh: { integration: "github" },
  };
  const bindings = {
    gh: "tools.github.user.main",
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

  it("rejects an index on an integration role", async () => {
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

  it("defaults a missing role property when exactly one connection exists", async () => {
    const resolved = await Effect.runPromise(resolveIntegrationBindings(declared, {}, okResolver));
    expect(resolved.bindings).toEqual({ gh: "tools.github.user.main" });
    expect(resolved.input).toEqual({});
  });

  it("fails when several connections exist and the role property is missing", async () => {
    const resolver: ClientResolver = {
      ...okResolver,
      listConnections: () =>
        Effect.succeed([
          { address: "tools.github.user.one", integration: "github" },
          { address: "tools.github.user.two", integration: "github" },
        ]),
    };
    expect(await fails(resolveIntegrationBindings(declared, {}, resolver))).toBe(true);
  });

  it("fails when a requested connection belongs to a different integration", async () => {
    const resolver: ClientResolver = {
      ...okResolver,
      resolveConnection: () =>
        Effect.succeed({ address: "tools.gmail.user.main", integration: "gmail" }),
    };
    expect(
      await fails(resolveIntegrationBindings(declared, { gh: "tools.gmail.user.main" }, resolver)),
    ).toBe(true);
  });

  it("fails when a requested connection is unknown", async () => {
    expect(
      await fails(
        resolveIntegrationBindings(declared, { gh: "tools.github.user.missing" }, okResolver),
      ),
    ).toBe(true);
  });
});
