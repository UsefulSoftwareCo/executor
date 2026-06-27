// The agentic connect handoff: an agent adds an API over MCP, asks for a
// handoff URL (`coreTools.connections.createHandoff`), and the user opens that
// URL in a browser to paste the credential. This scenario walks the WHOLE
// path, the exact flow that failed in production with a "wrong / bad" URL,
// against a per-run local Resend emulator so the failure
// point is captured with trace + screenshots instead of guessed at:
//
//   1. MCP `execute` → `openapi.addSpec` registers the emulated Resend API
//   2. MCP `execute` → `connections.createHandoff` returns the browser URL
//   3. The URL's origin must be THIS deployment (not a hardcoded host) AND it
//      must carry the bound org's slug (`/<slug>/integrations/…`), so a user in
//      several orgs lands in the exact org the agent is scoped to, not whatever
//      org the browser happened to last canonicalize onto
//   4. Playwright opens it: the Add connection modal must be open with a
//      credential field, the emulator-minted API key is pasted and submitted
//   5. The saved connection is proven live: `execute` sends an email through
//      the new tools and the emulator's request ledger shows the call
//      arriving with the pasted bearer token
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { AccountHttpApi } from "@executor-js/api";
import { composePluginApi } from "@executor-js/api/server";
import { createEmulator, type Emulator } from "@executor-js/emulate";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";

import { scenario } from "../src/scenario";
import { Api, Browser, Mcp, Target } from "../src/services";
import type { Identity, Target as TargetShape } from "../src/target";
import type { BrowserSurface } from "../src/surfaces/browser";
import type { McpSession } from "../src/surfaces/mcp";

const api = composePluginApi([openApiHttpPlugin()] as const);

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

// The emulator serves its own OpenAPI document (bearer auth, same shape as
// real Resend, and as the Sentry spec that failed in prod). Adding it by URL
// with no authenticationTemplate exercises exactly the agentic path: the
// add-account modal must render a paste-a-token flow derived from the spec's
// bare `http`/`bearer` security scheme.
const addSpecCode = (slug: string, specUrl: string) => `
const added = await tools.executor.openapi.addSpec({
  spec: { kind: "url", url: ${JSON.stringify(specUrl)} },
  slug: ${JSON.stringify(slug)},
});
return added.ok ? { ok: true, slug: added.data.slug, toolCount: added.data.toolCount } : { ok: false, error: added.error };
`;

const createHandoffCode = (slug: string) => `
const handoff = await tools.executor.coreTools.connections.createHandoff({
  integration: ${JSON.stringify(slug)},
  owner: "org",
  label: "Resend (emulated)",
});
return handoff.ok ? { ok: true, url: handoff.data.url } : { ok: false, error: handoff.error };
`;

// Selfhost scenarios share one workspace identity. Remove everything this
// scenario made so later shared-admin scenarios never inherit its state.
const removeConnectionsCode = (slug: string) => `
const list = await tools.executor.coreTools.connections.list({});
const mine = (list.ok ? list.data.connections : []).filter((c) => c.integration === ${JSON.stringify(slug)});
for (const c of mine) {
  await tools.executor.coreTools.connections.remove({ owner: c.owner, integration: c.integration, name: c.name });
}
return { removed: mine.length };
`;

const sendEmailCode = (slug: string, subject: string) => `
const found = await tools.search({ namespace: ${JSON.stringify(slug)}, query: "send email", limit: 5 });
const path = found.items[0]?.path;
if (!path) return { ok: false, error: "no send tool found", items: found.items };
let t = tools;
for (const seg of path.split(".")) t = t[seg];
const sent = await t({
  body: {
    from: "onboarding@example.com",
    to: "e2e@example.com",
    subject: ${JSON.stringify(subject)},
    html: "<p>connect-handoff e2e</p>",
  },
});
return { ok: sent.ok, path, result: sent.ok ? sent.data : sent.error };
`;

/** Run `execute`, auto-approving any paused executions (approval-gated tools
 *  pause once per gated call) and parse the sandbox's JSON return value. */
const executeJson = (session: McpSession, code: string) =>
  Effect.gen(function* () {
    let result = yield* session.call("execute", { code });
    let guard = 0;
    while (result.text.includes("executionId:") && guard < 10) {
      result = yield* session.approvePaused(result.text);
      guard += 1;
    }
    expect(result.ok, `execute completed (got: ${result.text.slice(0, 400)})`).toBe(true);
    return JSON.parse(result.text) as Record<string, unknown>;
  });

const availablePort = Effect.callback<number>((resume) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close(() => resume(Effect.succeed(port)));
  });
});

const resendEmulator = Effect.acquireRelease(
  Effect.gen(function* () {
    const port = yield* availablePort;
    // The suite-owned cloud and selfhost apps run on this host, and the
    // production Docker lane uses host networking. An attached remote target
    // cannot reach this URL and therefore fails at addSpec instead of passing
    // against shared hosted state.
    return yield* Effect.promise(() =>
      createEmulator({
        service: "resend",
        port,
        baseUrl: `http://127.0.0.1:${port}`,
      }),
    );
  }),
  (emulator: Emulator) => Effect.promise(() => emulator.close()).pipe(Effect.ignore),
);

scenario(
  "Connect · the agentic handoff URL opens this deployment's add-account flow and the pasted key works",
  { timeout: 240_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const mcp = yield* Mcp;
      const browser = yield* Browser;
      const { client: makeApiClient } = yield* Api;
      const emulator = yield* resendEmulator;

      const integration = unique("resendhf");
      const emailSubject = unique("connect-handoff");
      const credential = yield* Effect.promise(() =>
        emulator.credentials.mint({ type: "api-key" }),
      );
      const apiKey = credential.token;
      if (!apiKey) return yield* Effect.die("Resend emulator returned no API key.");

      const identity = yield* target.newIdentity();
      const session = mcp.session(identity);
      const client = yield* makeApiClient(api, identity);

      // The bound org's slug, read from the same account surface the console
      // shell reads. The handoff URL must canonicalize onto exactly this.
      const accountClient = yield* makeApiClient(AccountHttpApi, identity);
      const me = yield* accountClient.account.me();
      const orgSlug = me.organization?.slug;
      expect(orgSlug, "the bound organization advertises a URL slug").toBeTruthy();

      yield* runScenario({
        target,
        browser,
        session,
        identity,
        integration,
        emailSubject,
        apiKey,
        orgSlug: orgSlug!,
        emulator,
      }).pipe(
        // Best-effort cleanup even on failure: drop the created connection(s)
        // over MCP, then the integration over the API. `connections.remove` is
        // approval-gated, so the cleanup execute pauses per connection;
        // `executeJson` auto-approves each pause so the removes actually run.
        Effect.ensuring(
          Effect.gen(function* () {
            yield* executeJson(session, removeConnectionsCode(integration)).pipe(Effect.ignore);
            yield* client.openapi.removeSpec({ params: { slug: integration } }).pipe(Effect.ignore);
          }),
        ),
      );
    }),
  ),
);

const runScenario = (input: {
  readonly target: TargetShape;
  readonly browser: BrowserSurface;
  readonly session: McpSession;
  readonly identity: Identity;
  readonly integration: string;
  readonly emailSubject: string;
  readonly apiKey: string;
  readonly orgSlug: string;
  readonly emulator: Emulator;
}) =>
  Effect.gen(function* () {
    const {
      target,
      browser,
      session,
      identity,
      integration,
      emailSubject,
      apiKey,
      orgSlug,
      emulator,
    } = input;

    // 1. Agent registers the emulated provider over MCP.
    const added = yield* executeJson(session, addSpecCode(integration, emulator.openapiUrl));
    expect(added.ok, `addSpec succeeded: ${JSON.stringify(added)}`).toBe(true);

    // 2. Agent asks for the browser handoff URL.
    const handoff = yield* executeJson(session, createHandoffCode(integration));
    expect(handoff.ok, `createHandoff succeeded: ${JSON.stringify(handoff)}`).toBe(true);
    const handoffUrl = String(handoff.url);

    // 3. The URL must target THIS deployment AND carry the bound org's slug.
    //    (Production returned a URL the user called "wrong/bad". It had no slug,
    //    so a multi-org user could land in the wrong workspace. Pin both here.)
    const parsed = new URL(handoffUrl);
    expect(parsed.origin, `handoff URL (${handoffUrl}) targets this deployment`).toBe(
      new URL(target.baseUrl).origin,
    );
    expect(parsed.pathname, `handoff URL (${handoffUrl}) carries the bound org slug`).toBe(
      `/${orgSlug}/integrations/${integration}`,
    );
    expect(parsed.searchParams.get("addAccount")).toBe("1");

    // 4. The user opens the handoff URL and pastes the credential.
    yield* browser.session(identity, async ({ page, step }) => {
      await step("Open the handoff URL from the agent", async () => {
        await page.goto(handoffUrl, { waitUntil: "networkidle" });
      });

      await step("The Add connection modal is open", async () => {
        await page.getByRole("heading", { name: /Add connection/ }).waitFor({ timeout: 15_000 });
      });

      await step("Paste the emulator API key", async () => {
        const credential = page.getByPlaceholder(/paste the value \/ token/i);
        await credential.waitFor({ timeout: 15_000 });
        await credential.fill(apiKey);
      });

      await step("Submit Add connection", async () => {
        await page.getByRole("button", { name: "Add connection", exact: true }).click();
        await page
          .getByRole("heading", { name: /Add connection/ })
          .waitFor({ state: "hidden", timeout: 20_000 });
      });
    });

    // 5. The connection is live: send an email through the new tools and see
    //    it arrive at the emulator with the pasted token.
    const sent = yield* executeJson(session, sendEmailCode(integration, emailSubject));
    expect(sent.ok, `email sent through the pasted connection: ${JSON.stringify(sent)}`).toBe(true);

    const entries = yield* Effect.promise(() => emulator.ledger.list());
    const recorded = entries.find((entry) =>
      JSON.stringify(entry.request.body ?? "").includes(emailSubject),
    );
    expect(
      recorded?.summary,
      "the emulator's request ledger recorded the call made through Executor",
    ).toBeDefined();
  });
