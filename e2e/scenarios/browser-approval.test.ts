// Browser approval of a gated MCP action, end to end through the real console.
//
// A `require_approval` policy turns a built-in tool into an action that pauses
// for a human. The MCP session runs in `elicitation_mode=browser`, so the gated
// `execute` does not let the model resume inline — it pauses and hands back an
// `approvalUrl`. A real browser (signed in as the same identity) opens that
// console page and clicks Approve / Decline; meanwhile `resume` long-polls for
// the decision. Approve lets the tool run and return its result; Decline blocks
// it. This is the leg unit tests structurally cannot cover: a human clicking the
// button in the rendered ResumeApprovalPage.
//
// The policy is removed in an `ensuring` finalizer — a leaked require_approval
// gate on a shared built-in tool would pause unrelated scenarios.
//
// Cross-target: runs on every host that wires browser approval (cloud's Durable
// Object, self-host's in-process store, Cloudflare's DO). The host differences —
// where the approval URL points, which engine holds the pause — are invisible
// here; the scenario only drives the rendered console page.
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";

import { scenario } from "../src/scenario";
import { Api, Browser, Mcp, Target } from "../src/services";
import { type McpBrowserApproval, parseBrowserApproval } from "../src/surfaces/mcp";
import type { BrowserSurface } from "../src/surfaces/browser";
import type { Identity } from "../src/target";

const coreApi = composePluginApi([] as const);

// Gating a built-in read tool keeps the scenario hermetic — no external server
// to host a destructive tool. The gate, not the tool, is what's under test: any
// action the engine pauses on flows through the same approval path.
const GATE_TOOL = "executor.coreTools.policies.list";

// The gated call returns the policy listing, which includes the policy we just
// created — so the created policy's id appears in the result iff the tool
// actually ran (i.e. the human approved).
const GATED_CODE = `
const result = await tools.executor.coreTools.policies.list({});
return JSON.stringify(result);
`;

/** Open the console approval page as `identity` and click Approve or Decline. */
const decideInBrowser = (
  browser: BrowserSurface,
  identity: Identity,
  approval: McpBrowserApproval,
  decision: "Approve" | "Decline",
): Effect.Effect<void> =>
  browser.session(identity, async ({ page, step }) => {
    await step(
      `Open the approval page and ${decision.toLowerCase()} the paused action`,
      async () => {
        await page.goto(approval.approvalUrl, { waitUntil: "networkidle" });
        await page.getByRole("button", { name: decision }).click();
        // The page confirms the decision was recorded ("Approve sent" / "Decline sent").
        await page.getByText(`${decision} sent`).waitFor();
      },
    );
  });

scenario(
  "MCP · a gated action approved in the browser runs to completion",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const api = yield* Api;
    const browser = yield* Browser;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const client = yield* api.client(coreApi, identity);

    const policy = yield* client.policies.create({
      payload: { owner: "org", pattern: GATE_TOOL, action: "require_approval" },
    });

    yield* Effect.gen(function* () {
      const session = mcp.session(identity, { elicitationMode: "browser" });
      const tools = yield* session.listTools();
      expect(tools).toContain("execute");

      const paused = yield* session.call("execute", { code: GATED_CODE });
      const approval = parseBrowserApproval(paused);
      expect(approval.approvalUrl, "approval URL targets the resume page").toContain(
        `/resume/${approval.executionId}`,
      );

      // `resume` blocks for the human's decision; approve it in the browser
      // concurrently, then the resumed call returns the gated tool's result.
      const [resumed] = yield* Effect.all(
        [
          session.awaitResume(approval.executionId),
          decideInBrowser(browser, identity, approval, "Approve"),
        ],
        { concurrency: "unbounded" },
      );

      expect(resumed.ok, "the approved execution completed without error").toBe(true);
      expect(resumed.text, "the gated tool ran and returned the policy listing").toContain(
        policy.id,
      );
    }).pipe(
      Effect.ensuring(
        client.policies
          .remove({ params: { policyId: policy.id }, payload: { owner: "org" } })
          .pipe(Effect.ignore),
      ),
    );
  }),
);

scenario(
  "MCP · a gated action declined in the browser is blocked",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const api = yield* Api;
    const browser = yield* Browser;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const client = yield* api.client(coreApi, identity);

    const policy = yield* client.policies.create({
      payload: { owner: "org", pattern: GATE_TOOL, action: "require_approval" },
    });

    yield* Effect.gen(function* () {
      const session = mcp.session(identity, { elicitationMode: "browser" });
      yield* session.listTools();

      const paused = yield* session.call("execute", { code: GATED_CODE });
      const approval = parseBrowserApproval(paused);

      const [resumed] = yield* Effect.all(
        [
          session.awaitResume(approval.executionId),
          decideInBrowser(browser, identity, approval, "Decline"),
        ],
        { concurrency: "unbounded" },
      );

      // The decision propagated (resume returned rather than hanging) and the
      // gated tool never ran — its output (the policy id) is absent.
      expect(resumed.text, "the gated tool did not run after a decline").not.toContain(policy.id);
    }).pipe(
      Effect.ensuring(
        client.policies
          .remove({ params: { policyId: policy.id }, payload: { owner: "org" } })
          .pipe(Effect.ignore),
      ),
    );
  }),
);
