// The connect handoff as a DEVELOPER SESSION — the way a human actually
// tests this: chat with a real agent in a real terminal, the agent wires up
// the API over MCP and drops a connect link in the chat, you open the link
// in a browser and paste your key, then come back to the terminal and ask
// the agent to prove the connection works.
//
// Replay brain, real hands: the LLM is a scripted local server
// (clients/replay-brain.ts) so the conversation is deterministic, but
// EVERYTHING else is real — the installed OpenCode binary renders the TUI,
// does MCP OAuth against this deployment, executes the brain's tool calls
// through the real /mcp endpoint, and the pasted key round-trips through the
// real add-account UI into a connection that hits the real emulated provider
// (resend.emulators.dev), whose request ledger is the final evidence.
//
// The terminal PTY stays open for the WHOLE session (one terminal.cast,
// one timeline); the browser hop runs concurrently as the "user" and the
// chat resumes when it's done. A Desk surface can later film both windows
// as one screen recording without changing this scenario's shape.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "@effect/vitest";
import { Effect, Exit, Fiber } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Cli, Mcp, OpenCode, RunDir, Target } from "../src/services";
import {
  serveReplayBrain,
  type BrainContext,
  type BrainResponse,
} from "../src/clients/replay-brain";

const SERVER_NAME = "executor";
const EMULATOR_BASE = "https://resend.emulators.dev";

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

/** Resend subset spec pointed at the emulator, with an explicit apiKey
 *  template so the add-account modal renders a paste-a-token flow. */
const resendSpec = {
  openapi: "3.0.3",
  info: { title: "Resend (emulated)", version: "1.0.0" },
  paths: {
    "/emails": {
      post: {
        operationId: "sendEmail",
        tags: ["emails"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  from: { type: "string" },
                  to: { type: "string" },
                  subject: { type: "string" },
                  html: { type: "string" },
                },
                required: ["from", "to", "subject"],
              },
            },
          },
        },
        responses: { "200": { description: "sent" } },
      },
    },
  },
} as const;

const addSpecCode = (slug: string) => `
const added = await tools.executor.openapi.addSpec({
  spec: { kind: "blob", value: ${JSON.stringify(JSON.stringify(resendSpec))} },
  slug: ${JSON.stringify(slug)},
  baseUrl: ${JSON.stringify(EMULATOR_BASE)},
  authenticationTemplate: [{
    type: "apiKey",
    label: "API key",
    headers: { Authorization: ["Bearer ", { type: "variable", name: "apiKey" }] },
  }],
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

// Lines the terminal waits for — the brain says them, the PTY assertion
// reads them off the rendered TUI. Kept short and ASCII so terminal line
// wrapping and glyph rendering can't break the substring match.
const SAY_LINK_READY = "Open this link to connect your Resend account";
const SAY_EMAIL_SENT = "Test email sent";

interface SessionState {
  handoffUrl: string | undefined;
  browserDone: boolean;
  scriptNotes: string[];
}

/** The scripted side of the conversation, as inspection of the transcript —
 *  no turn counting, so approval-pause detours and OpenCode's side requests
 *  (title generation etc.) don't derail it. */
const makeBrainScript = (input: {
  readonly integration: string;
  readonly emailSubject: string;
  readonly state: SessionState;
}) => {
  const { integration, emailSubject, state } = input;
  return (ctx: BrainContext): BrainResponse => {
    // OpenCode's very first request can fire before its MCP tool registry
    // loads (zero tools offered). Stall politely; it re-asks with tools.
    if (ctx.toolNames.length === 0) {
      return { text: "One moment…" };
    }
    // Agent returned a tool result — continue the current job.
    if (ctx.lastRole === "tool" && ctx.lastToolResult !== undefined) {
      const result = ctx.lastToolResult;

      // Approval gate: resume whatever paused.
      const paused = /executionId[":\s]+"?([\w-]+)/.exec(result);
      if (result.includes("Execution paused") && paused?.[1]) {
        return {
          tool: { name: "resume", args: { executionId: paused[1], action: "accept" } },
        };
      }

      const handoffUrl = /https?:\/\/[^"\s\\]+\/integrations\/[^"\s\\]+/.exec(result)?.[0];
      if (handoffUrl) {
        state.handoffUrl = handoffUrl;
        return {
          text: `${SAY_LINK_READY}:\n\n${handoffUrl}\n\nTell me once you've pasted your API key.`,
        };
      }

      if (result.includes('"toolCount"')) {
        return {
          text: "The Resend API is registered. Creating your connect link…",
          tool: { name: "execute", args: { code: createHandoffCode(integration) } },
        };
      }

      if (result.includes(emailSubject) || /"ok":\s*true/.test(result)) {
        return { text: `${SAY_EMAIL_SENT} - your Resend connection works.` };
      }

      state.scriptNotes.push(`unexpected tool result: ${result.slice(0, 300)}`);
      return { text: "Something unexpected came back — stopping here." };
    }

    // Fresh human turn.
    if (/add the resend api/i.test(ctx.lastUser)) {
      return {
        text: "I'll register the Resend API in your Executor now.",
        tool: { name: "execute", args: { code: addSpecCode(integration) } },
      };
    }
    if (/send a test email/i.test(ctx.lastUser)) {
      return {
        text: "Sending a test email through your new connection…",
        tool: { name: "execute", args: { code: sendEmailCode(integration, emailSubject) } },
      };
    }
    // OpenCode side requests (session titles, warm-up pings).
    return { text: "Connect Resend" };
  };
};

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

const sleep = (ms: number) => new Promise<void>((tick) => setTimeout(tick, ms));

scenario(
  "Connect · developer session: agent chat → handoff link → paste key → verified send",
  { timeout: 360_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const mcp = yield* Mcp;
      const browser = yield* Browser;
      const opencode = yield* OpenCode;
      const cli = yield* Cli;
      const runDir = yield* RunDir;

      const integration = unique("resendsesh");
      const emailSubject = unique("dev-session");
      const apiKey = yield* mintEmulatorApiKey;
      const identity = yield* target.newIdentity();
      const email = identity.credentials?.email ?? identity.label;

      const state: SessionState = { handoffUrl: undefined, browserDone: false, scriptNotes: [] };
      const brain = yield* serveReplayBrain(makeBrainScript({ integration, emailSubject, state }));
      // The conversation transcript is evidence too — written even on failure.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() =>
          writeFileSync(
            join(runDir, "chat-brain.json"),
            JSON.stringify(
              { requests: brain.requests(), errors: brain.errors(), notes: state.scriptNotes },
              null,
              2,
            ),
          ),
        ),
      );

      const home = opencode.makeHome(SERVER_NAME, mcp.url, { chatBrainUrl: brain.baseUrl });
      yield* Effect.sync(() => opencode.warmUp(home));
      // Pre-download the openai-compatible provider package off camera, in a
      // project with the brain but NO MCP (touching /mcp before `mcp auth`
      // breaks the auth flow — see warmUp).
      yield* Effect.sync(() => {
        const warm = join(home.projectDir, "..", "chat-warmup");
        mkdirSync(warm, { recursive: true });
        writeFileSync(
          join(warm, "opencode.json"),
          JSON.stringify({
            autoupdate: false,
            share: "disabled",
            model: "replay/replay-model",
            provider: {
              replay: {
                name: "Replay",
                npm: "@ai-sdk/openai-compatible",
                options: { baseURL: brain.baseUrl, apiKey: "replay-key" },
                models: { "replay-model": { name: "Replay Model" } },
              },
            },
          }),
        );
        spawnSync("opencode", ["run", "-m", "replay/replay-model", "warmup ping"], {
          cwd: warm,
          env: home.env,
          timeout: 120_000,
        });
      });

      // The "user at the browser": waits for the agent to produce the link,
      // opens it, pastes the key — while the terminal session stays open.
      const browserWork = Effect.gen(function* () {
        yield* Effect.promise(async () => {
          const deadline = Date.now() + 240_000;
          while (state.handoffUrl === undefined) {
            if (Date.now() > deadline) throw new Error("handoff URL never appeared in chat");
            await sleep(300);
          }
        });
        yield* browser.session(identity, async ({ page, step }) => {
          await step("Open the connect link from the chat", async () => {
            await page.goto(state.handoffUrl ?? "", { waitUntil: "networkidle" });
            await page
              .getByRole("heading", { name: /Add connection/ })
              .waitFor({ timeout: 15_000 });
          });
          await step("Paste the Resend API key and connect", async () => {
            const credential = page.getByPlaceholder(/paste the value \/ token/i);
            await credential.waitFor({ timeout: 15_000 });
            await credential.fill(apiKey);
            await page.getByRole("button", { name: "Add connection", exact: true }).click();
            await page
              .getByRole("heading", { name: /Add connection/ })
              .waitFor({ state: "hidden", timeout: 20_000 });
          });
        });
      });
      const browserFiber = yield* Effect.forkChild(
        Effect.gen(function* () {
          const exit = yield* Effect.exit(browserWork);
          state.browserDone = true;
          return exit;
        }),
      );

      yield* cli.session(
        ["bash", "--norc"],
        async (term) => {
          await term.screen.waitForText("$", { timeoutMs: 10_000 });

          // MCP OAuth on camera, consent played off camera. Wait for the
          // flow's own completion text — the shell prompt was already on
          // screen before the command, so it can't gate anything.
          const consent = opencode.completeOAuthConsent(home, email, home.openedUrls().length);
          await term.keyboard.type(`opencode mcp auth ${SERVER_NAME}`);
          await term.keyboard.press("Enter");
          await consent;
          await term.screen.waitForText("Authentication successful", { timeoutMs: 60_000 });
          await sleep(1_500); // let the auth UI finish and the prompt repaint

          // Into the TUI for the conversation.
          await term.keyboard.type("opencode");
          await term.keyboard.press("Enter");
          await term.screen.waitForText("Replay Model", { timeoutMs: 90_000 });

          await term.keyboard.type(
            "Add the Resend API to my executor and give me a link to connect my account",
          );
          await term.keyboard.press("Enter");
          await term.screen.waitForText(SAY_LINK_READY, { timeoutMs: 180_000 });

          // The human walks over to the browser; the chat waits.
          const deadline = Date.now() + 180_000;
          while (!state.browserDone) {
            if (Date.now() > deadline) throw new Error("browser side never finished");
            await sleep(300);
          }

          await sleep(750); // let the TUI settle before the next message
          await term.keyboard.type("Connected, now send a test email to prove it works");
          await term.keyboard.press("Enter");
          await term.screen.waitForText(SAY_EMAIL_SENT, { timeoutMs: 180_000 });
        },
        {
          cwd: home.projectDir,
          env: { ...home.env, PS1: "$ ", BASH_SILENCE_DEPRECATION_WARNING: "1" },
          record: join(runDir, "terminal.cast"),
          viewport: { cols: 100, rows: 40 },
        },
      );

      const browserExit = yield* Fiber.join(browserFiber);
      expect(Exit.isSuccess(browserExit), `browser side succeeded: ${String(browserExit)}`).toBe(
        true,
      );
      expect(brain.errors(), "replay brain script ran clean").toEqual([]);
      expect(state.scriptNotes, "conversation followed the script").toEqual([]);

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
