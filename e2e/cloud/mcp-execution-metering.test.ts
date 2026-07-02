// Cloud-only (billing): every code execution run through the MCP session
// Durable Object is metered to Autumn, exactly like the HTTP executor plane.
// The MCP server is the PRIMARY execution surface (Claude/Cursor run code here,
// not over /api), so if the DO doesn't bill, the bulk of real usage silently
// never reaches the meter — the regression this pins.
//
// Black-box and end-to-end: drive a real @modelcontextprotocol/sdk client over
// StreamableHTTP (the exact transport an MCP client uses) against the production
// workerd + McpSessionDO topology, then read the usage the server ACTUALLY
// tracked from the Autumn ledger. The execution's own response can't prove it
// was billed — metering is fire-and-forget, decoupled from the user-facing
// result — so only the meter is the source of truth.
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { scenario } from "../src/scenario";
import { Autumn, Billing, Mcp, Target } from "../src/services";
import type { Identity } from "../src/target";

const emailOf = (identity: Identity): string => identity.credentials?.email ?? identity.label;

/** The org the bearer is scoped to — the Autumn customer id `trackExecution`
 *  meters against — read from the JWT's public claims. */
const orgIdOf = (bearer: string): string => {
  const claims = JSON.parse(Buffer.from(bearer.split(".")[1] ?? "", "base64url").toString()) as {
    readonly org_id?: string;
  };
  if (!claims.org_id) throw new Error("orgIdOf: bearer carries no org_id claim");
  return claims.org_id;
};

const textOf = (result: { content?: unknown; toolResult?: unknown }): string =>
  ((result.content ?? []) as Array<{ type: string; text?: string }>)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

const RUNS = 3;

scenario(
  "Billing · every MCP execution is metered to Autumn, one unit per run",
  { timeout: 180_000 },
  Effect.gen(function* () {
    // Gates: billing is enforced here AND the Autumn ledger is observable
    // (the suite booted the emulator). Yield before any work so a target
    // missing either capability skips cleanly.
    yield* Billing;
    const autumn = yield* Autumn;
    const target = yield* Target;
    const mcp = yield* Mcp;

    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));
    const customerId = orgIdOf(bearer);

    // A fresh org has metered nothing yet — the baseline the run is measured
    // against, and a guard that we're reading this customer's ledger in
    // isolation from every other scenario's executions.
    const before = yield* autumn.usageEvents({ customerId, featureId: "executions" });
    expect(before.length, "a brand-new org starts with zero metered executions").toBe(0);

    // A real MCP client over StreamableHTTP — the production code path.
    const client = new Client(
      { name: "executor-e2e-metering", version: "0.0.1" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(target.mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
    });
    const connected = yield* Effect.promise(() => client.connect(transport).then(() => client));

    yield* Effect.gen(function* () {
      // Run a handful of executions; each is one billable unit.
      for (let i = 1; i <= RUNS; i++) {
        const result = yield* Effect.promise(() =>
          connected.callTool({ name: "execute", arguments: { code: `return ${i} * 2;` } }),
        );
        expect(result.isError, `execution ${i} succeeds`).not.toBe(true);
        expect(textOf(result), `execution ${i} returns its value`).toContain(String(i * 2));
      }

      // The meter is the source of truth. Tracking is fire-and-forget, so poll
      // the ledger until all runs have landed.
      const after = yield* autumn.expectUsage({
        customerId,
        featureId: "executions",
        count: RUNS,
      });

      expect(
        after.length,
        "exactly one 'executions' usage event per run — no over- or under-counting",
      ).toBe(RUNS);
      expect(
        after.every((event) => event.value === 1),
        "each run meters a single unit",
      ).toBe(true);
    }).pipe(Effect.ensuring(Effect.promise(() => connected.close().catch(() => undefined))));
  }),
);
