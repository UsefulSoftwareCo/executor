// The connect handoff as a DEVELOPER SESSION — the way a human actually
// tests this: an agent chat in a real terminal where the agent wires up the
// API over MCP and drops a connect link, a browser hop to paste the key,
// then back to the chat to prove the connection works with a live send.
//
// No inference, no third-party agent binary: the "agent" is the chat
// theater (src/clients/chat-theater.ts) presenting REAL mcporter MCP calls
// — OAuth, execute, approval pause/resume all genuine, every tool spinner
// on screen bracketing the actual call it narrates. The provider on the
// other side is real too (resend.emulators.dev); its request ledger is the
// final evidence.
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Cli, Mcp, RunDir, Target } from "../src/services";
import { withChatTheater } from "../src/clients/chat-theater";
import type { McpSession } from "../src/surfaces/mcp";

const EMULATOR_BASE = "https://resend.emulators.dev";

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

// The emulator serves its own OpenAPI document (bearer auth, base URL in
// `servers`) — adding by URL with nothing else is exactly what an agent
// does, and the platform derives the paste-a-token auth method from the
// spec's security scheme.
const EMULATOR_SPEC_URL = `${EMULATOR_BASE}/openapi.json`;

const addSpecCode = (slug: string) => `
const added = await tools.executor.openapi.addSpec({
  spec: { kind: "url", url: ${JSON.stringify(EMULATOR_SPEC_URL)} },
  slug: ${JSON.stringify(slug)},
});
return added.ok ? { ok: true, slug: added.data.slug, toolCount: added.data.toolCount } : { ok: false, error: added.error };
`;

const createHandoffCode = (slug: string) => `
const handoff = await tools.executor.coreTools.connections.createHandoff({
  integration: ${JSON.stringify(slug)},
  owner: "org",
  label: "Resend",
});
return handoff.ok ? { ok: true, url: handoff.data.url } : { ok: false, error: handoff.error };
`;

const sendEmailCode = (slug: string, subject: string) => `
const found = await tools.search({ namespace: ${JSON.stringify(slug)}, query: "send email", limit: 5 });
const path = found.items[0]?.path;
if (!path) return { ok: false, error: "no send tool found" };
let t = tools;
for (const seg of path.split(".")) t = t[seg];
const sent = await t({
  body: {
    from: "onboarding@example.com",
    to: "dev-session@example.com",
    subject: ${JSON.stringify(subject)},
    html: "<p>connect-handoff developer session</p>",
  },
});
return { ok: sent.ok, path, result: sent.ok ? sent.data : sent.error };
`;

/** Run `execute`, auto-approving a paused execution (policy elicitation)
 *  once, and parse the sandbox's JSON return value. */
const executeJson = (session: McpSession, code: string) =>
  Effect.gen(function* () {
    let result = yield* session.call("execute", { code });
    if (result.text.includes("executionId:")) {
      result = yield* session.approvePaused(result.text);
    }
    expect(result.ok, `execute completed (got: ${result.text.slice(0, 400)})`).toBe(true);
    return JSON.parse(result.text) as Record<string, unknown>;
  });

const mintEmulatorApiKey = Effect.promise(async () => {
  const response = await fetch(`${EMULATOR_BASE}/_emulate/credentials`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "api-key" }),
  });
  const body = (await response.json()) as { credential?: { token?: string } };
  const token = body.credential?.token;
  if (!token) throw new Error(`emulator credential mint failed: ${JSON.stringify(body)}`);
  return token;
});

scenario(
  "Connect · developer session: agent chat → handoff link → paste key → verified send",
  { timeout: 240_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const mcp = yield* Mcp;
      const browser = yield* Browser;
      const cli = yield* Cli;
      const runDir = yield* RunDir;

      const integration = unique("resendsesh");
      const emailSubject = unique("dev-session");
      const apiKey = yield* mintEmulatorApiKey;
      const identity = yield* target.newIdentity();
      const session = mcp.session(identity);

      yield* withChatTheater(
        cli,
        { title: "executor agent — connect Resend", record: join(runDir, "terminal.cast") },
        (chat) =>
          Effect.gen(function* () {
            // Real MCP OAuth + tool discovery happens behind this call.
            yield* chat.tool(
              { name: "executor (mcp)", result: (tools) => `${tools.length} tools available` },
              session.listTools(),
            );

            yield* chat.user(
              "Add the Resend API to my executor and give me a link to connect my account",
            );
            yield* chat.assistant("I'll register the Resend API in your Executor now.");
            const added = yield* chat.tool(
              { name: "execute", input: addSpecCode(integration) },
              executeJson(session, addSpecCode(integration)),
            );
            expect(added.ok, `addSpec succeeded: ${JSON.stringify(added)}`).toBe(true);

            yield* chat.assistant("Registered. Creating your connect link…");
            const handoff = yield* chat.tool(
              { name: "execute", input: createHandoffCode(integration) },
              executeJson(session, createHandoffCode(integration)),
            );
            expect(handoff.ok, `createHandoff succeeded: ${JSON.stringify(handoff)}`).toBe(true);
            const handoffUrl = String(handoff.url);
            expect(new URL(handoffUrl).origin, "handoff targets this deployment").toBe(
              new URL(target.baseUrl).origin,
            );

            yield* chat.assistant(
              `Open this link to connect your Resend account:\n\n${handoffUrl}\n\nTell me once you've pasted your API key.`,
            );

            // The browser hop — the terminal session stays open while the
            // "user" pastes the key; the paste is the real add-account UI.
            yield* chat.status("you, in the browser: opening the link and pasting the API key…");
            yield* browser.session(identity, async ({ page, step }) => {
              await step("Open the connect link from the chat", async () => {
                await page.goto(handoffUrl, { waitUntil: "networkidle" });
                await page
                  .getByRole("heading", { name: /Add connection/ })
                  .waitFor({ timeout: 15_000 });
              });
              await step("Paste the Resend API key and connect", async () => {
                // Affixed single-input bearer field: value input placeholder is
                // "token" (scoped to the dialog to stay unique).
                const credential = page.getByRole("dialog").getByPlaceholder("token");
                await credential.waitFor({ timeout: 15_000 });
                await credential.fill(apiKey);
                await page.getByRole("button", { name: "Add connection", exact: true }).click();
                await page
                  .getByRole("heading", { name: /Add connection/ })
                  .waitFor({ state: "hidden", timeout: 20_000 });
              });
            });

            yield* chat.user("Connected, now send a test email to prove it works");
            yield* chat.assistant("Sending a test email through your new connection…");
            const sent = yield* chat.tool(
              { name: "execute", input: sendEmailCode(integration, emailSubject) },
              executeJson(session, sendEmailCode(integration, emailSubject)),
            );
            expect(sent.ok, `email sent through the connection: ${JSON.stringify(sent)}`).toBe(
              true,
            );

            yield* chat.assistant("Test email sent - your Resend connection works.");
          }),
      );

      // Final evidence: the emulator's ledger saw the send from Executor.
      const ledger = yield* Effect.promise(async () =>
        (await fetch(`${EMULATOR_BASE}/_emulate/ledger`)).text(),
      );
      expect(
        ledger.includes(emailSubject),
        "the emulator request ledger recorded the test email",
      ).toBe(true);
    }),
  ),
);
