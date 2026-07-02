// Secrets never cross the agent boundary: a confidential OAuth app is registered
// through a BROWSER handoff, not by passing the client secret as a tool argument.
//
// This is the regression guard for the secret-leak fix. The agent-facing
// `oauth.clients.create` used to take a `clientSecret`, which meant a confidential
// app's secret flowed through the LLM context window. That field is gone; the
// agent now calls `oauth.clients.createHandoff`, which returns a deep link into
// the web UI where the HUMAN types the secret, exactly like a pasted connection
// credential (`connections.createHandoff`).
//
// Three scenarios:
//   1. `createHandoff` returns a correct, secret-free deep link and is NOT
//      approval-gated (it is the safe path). A smuggled `clientSecret` argument
//      never appears in the URL.
//   2. `oauth.clients.create` still pauses for human approval (the write gate
//      survived the secret removal) and writes nothing when declined.
//   3. Watch-it: the agent hands off, a human opens the URL and types the secret
//      into the Register-OAuth-app form (auto-opened and pre-filled from the
//      handoff), the app registers, and the agent completes a client-credentials
//      connection against the Microsoft emulator without ever seeing the secret.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { AccountHttpApi } from "@executor-js/api";
import { composePluginApi } from "@executor-js/api/server";
import { connectEmulator, type EmulatorClient, type IssuedCredential } from "@executor-js/emulate";
import { MICROSOFT_CLIENT_CREDENTIALS_AUTH_TEMPLATE_SLUG } from "@executor-js/plugin-microsoft";
import { microsoftHttpPlugin } from "@executor-js/plugin-microsoft/api";
import { ConnectionName, IntegrationSlug, OAuthClientSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Mcp, Target } from "../src/services";
import type { McpSession } from "../src/surfaces/mcp";

const microsoftApi = composePluginApi([microsoftHttpPlugin()] as const);

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

// A sentinel the agent tries to smuggle as a `clientSecret` argument the handoff
// tool does not declare. The secret must never reach the returned URL (nor any
// part of the agent-visible response), proving the boundary drops it.
const SMUGGLED_SECRET = "SMUGGLED_SECRET_DO_NOT_LEAK_4f1a9c";

/** Run `execute`, auto-approving any paused (approval-gated) calls, and parse the
 *  sandbox's JSON return value. Mirrors the connect-handoff helper. */
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

// ---------------------------------------------------------------------------
// 1. The handoff URL: secret-free, correctly addressed, and not approval-gated.
// ---------------------------------------------------------------------------

const createHandoffCode = (input: {
  readonly integration: string;
  readonly slug: string;
  readonly clientId: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
}) => `
const handoff = await tools.executor.coreTools.oauth.clients.createHandoff({
  integration: ${JSON.stringify(input.integration)},
  owner: "user",
  slug: ${JSON.stringify(input.slug)},
  grant: "client_credentials",
  clientId: ${JSON.stringify(input.clientId)},
  authorizationUrl: ${JSON.stringify(input.authorizationUrl)},
  tokenUrl: ${JSON.stringify(input.tokenUrl)},
});
return handoff.ok
  ? { ok: true, url: handoff.data.url, instructions: handoff.data.instructions }
  : { ok: false, error: handoff.error };
`;

// The same call, but with a `clientSecret` the tool does not declare. Whatever
// the boundary does with the excess field (drop or reject), the secret VALUE
// must not appear anywhere in the agent-visible result.
const smuggleSecretCode = (input: {
  readonly integration: string;
  readonly slug: string;
  readonly clientId: string;
  readonly tokenUrl: string;
}) => `
const handoff = await tools.executor.coreTools.oauth.clients.createHandoff({
  integration: ${JSON.stringify(input.integration)},
  slug: ${JSON.stringify(input.slug)},
  grant: "client_credentials",
  clientId: ${JSON.stringify(input.clientId)},
  tokenUrl: ${JSON.stringify(input.tokenUrl)},
  clientSecret: ${JSON.stringify(SMUGGLED_SECRET)},
});
return JSON.stringify(handoff);
`;

scenario(
  "OAuth client · createHandoff returns a secret-free deep link and is not approval-gated",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeApiClient } = yield* Api;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const session = mcp.session(identity);

    // The bound org's slug, read from the same surface the console shell reads —
    // the handoff URL must canonicalize onto exactly this org.
    const accountClient = yield* makeApiClient(AccountHttpApi, identity);
    const me = yield* accountClient.account.me();
    const orgSlug = me.organization?.slug;
    expect(orgSlug, "the bound organization advertises a URL slug").toBeTruthy();

    const integration = unique("oauthhf");
    const clientSlug = unique("app");
    const clientId = unique("client-id");
    const authorizationUrl = "https://issuer.example.com/oauth2/v2.0/authorize";
    const tokenUrl = "https://issuer.example.com/oauth2/v2.0/token";

    // createHandoff is a pure URL builder — it must NOT pause for approval (it is
    // the safe path that routes the secret to the human, mirroring
    // `connections.createHandoff`).
    const raw = yield* session.call("execute", {
      code: createHandoffCode({
        integration,
        slug: clientSlug,
        clientId,
        authorizationUrl,
        tokenUrl,
      }),
    });
    expect(raw.text, "createHandoff is not approval-gated (no pause)").not.toContain(
      "executionId:",
    );
    expect(raw.ok, `createHandoff execute completed (got: ${raw.text.slice(0, 400)})`).toBe(true);
    const handoff = JSON.parse(raw.text) as { ok: boolean; url?: string; instructions?: string };
    expect(handoff.ok, `createHandoff succeeded: ${raw.text.slice(0, 400)}`).toBe(true);

    const url = new URL(String(handoff.url));
    expect(url.origin, `handoff URL (${handoff.url}) targets this deployment`).toBe(
      new URL(target.baseUrl).origin,
    );
    expect(url.pathname, `handoff URL (${handoff.url}) carries the bound org slug`).toBe(
      `/${orgSlug}/integrations/${integration}`,
    );
    // The flags that flip the integration's Add-account flow into the
    // Register-OAuth-app form, pre-filled with the agent's non-secret fields.
    expect(url.searchParams.get("addAccount")).toBe("1");
    expect(url.searchParams.get("oauthClient")).toBe("1");
    expect(url.searchParams.get("owner")).toBe("user");
    expect(url.searchParams.get("clientSlug")).toBe(clientSlug);
    expect(url.searchParams.get("grant")).toBe("client_credentials");
    expect(url.searchParams.get("clientId")).toBe(clientId);
    expect(url.searchParams.get("authorizationUrl")).toBe(authorizationUrl);
    expect(url.searchParams.get("tokenUrl")).toBe(tokenUrl);

    // No secret leaves the host: there is no secret-bearing field on the tool,
    // so the URL carries none.
    expect(url.searchParams.get("clientSecret"), "no clientSecret param").toBeNull();
    expect(url.searchParams.get("secret"), "no secret param").toBeNull();

    // The instructions steer the agent away from ever asking for the secret.
    expect(String(handoff.instructions)).toMatch(/client secret/i);
    expect(String(handoff.instructions)).toMatch(/chat/i);

    // Adversarial: an agent that tries to smuggle a secret as an undeclared
    // argument gets it dropped — the value never appears in the response.
    const smuggled = yield* session.call("execute", {
      code: smuggleSecretCode({ integration, slug: clientSlug, clientId, tokenUrl }),
    });
    expect(
      smuggled.text.includes(SMUGGLED_SECRET),
      "a smuggled client secret never reaches the agent-visible handoff result",
    ).toBe(false);
  }),
);

// ---------------------------------------------------------------------------
// 2. The write path stays gated: `oauth.clients.create` (now secret-free) still
//    pauses for human approval, and a decline writes nothing.
// ---------------------------------------------------------------------------

const createPublicClientCode = (slug: string) => `
const result = await tools.executor.coreTools.oauth.clients.create({
  owner: "user",
  slug: ${JSON.stringify(slug)},
  authorizationUrl: "https://issuer.example.com/authorize",
  tokenUrl: "https://issuer.example.com/token",
  grant: "authorization_code",
  clientId: ${JSON.stringify(unique("public-client"))},
});
return JSON.stringify(result);
`;

const listClientsCode = `
const result = await tools.executor.coreTools.oauth.clients.list({});
return JSON.stringify(result.ok ? result.data.clients.map((c) => c.slug) : { error: result.error });
`;

scenario(
  "OAuth client · oauth.clients.create still pauses for human approval and a decline writes nothing",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const session = mcp.session(identity);
    const slug = unique("gated-app");

    yield* session.listTools();

    // Nothing has registered a policy here — the only thing that can pause this
    // call is the tool's own `requiresApproval` annotation, which must have
    // survived dropping the client secret from the input.
    const paused = yield* session.call("execute", { code: createPublicClientCode(slug) });
    expect(paused.text, "oauth.clients.create pauses for approval (annotation guard)").toContain(
      "Execution paused",
    );
    expect(paused.text, "paused result carries the executionId").toContain("executionId:");

    // Decline: the client must not be written.
    const match = /\bexecutionId:\s*(\S+)/.exec(paused.text);
    expect(match, "paused result carries an executionId to resume").not.toBeNull();
    yield* session.call("resume", { executionId: match![1], action: "decline" });

    const slugs = JSON.parse((yield* session.call("execute", { code: listClientsCode })).text) as
      | ReadonlyArray<string>
      | { error: unknown };
    expect(
      Array.isArray(slugs) && slugs.includes(slug),
      "a declined oauth.clients.create never registered the client",
    ).toBe(false);
  }),
);

// ---------------------------------------------------------------------------
// 3. Watch-it: the whole secret-free path, end to end, against the hosted
//    Microsoft emulator. The agent hands off; the human types the secret in the
//    browser; the agent connects.
// ---------------------------------------------------------------------------

const EMULATOR_BASE = "https://microsoft.emulators.dev";

const handoffForBrowserCode = (input: {
  readonly integration: string;
  readonly slug: string;
  readonly clientId: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
}) => `
const handoff = await tools.executor.coreTools.oauth.clients.createHandoff({
  integration: ${JSON.stringify(input.integration)},
  owner: "org",
  slug: ${JSON.stringify(input.slug)},
  grant: "client_credentials",
  clientId: ${JSON.stringify(input.clientId)},
  authorizationUrl: ${JSON.stringify(input.authorizationUrl)},
  tokenUrl: ${JSON.stringify(input.tokenUrl)},
  label: "Microsoft Graph (emulated)",
});
return handoff.ok ? { ok: true, url: handoff.data.url } : { ok: false, error: handoff.error };
`;

const listClientSlugsCode = `
const result = await tools.executor.coreTools.oauth.clients.list({});
return result.ok ? { ok: true, slugs: result.data.clients.map((c) => c.slug) } : { ok: false, error: result.error };
`;

const startConnectionCode = (input: {
  readonly slug: string;
  readonly integration: string;
  readonly connection: string;
  readonly template: string;
}) => `
const started = await tools.executor.coreTools.oauth.start({
  client: ${JSON.stringify(input.slug)},
  clientOwner: "org",
  owner: "org",
  name: ${JSON.stringify(input.connection)},
  integration: ${JSON.stringify(input.integration)},
  template: ${JSON.stringify(input.template)},
});
return started.ok ? { ok: true, status: started.data.status } : { ok: false, error: started.error };
`;

const requireOAuthClientCredential = (credential: IssuedCredential) =>
  Effect.gen(function* () {
    if (
      credential.client_id &&
      credential.client_secret &&
      credential.authorization_url &&
      credential.token_url
    ) {
      return {
        clientId: credential.client_id,
        clientSecret: credential.client_secret,
        authorizationUrl: credential.authorization_url,
        tokenUrl: credential.token_url,
      };
    }
    return yield* Effect.die("Microsoft emulator returned incomplete OAuth client credentials.");
  });

scenario(
  "OAuth client · agent hands off, the human enters the secret in the browser, and the app connects",
  { timeout: 240_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeApiClient } = yield* Api;
    const mcp = yield* Mcp;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();
    const session = mcp.session(identity);
    const client = yield* makeApiClient(microsoftApi, identity);

    const accountClient = yield* makeApiClient(AccountHttpApi, identity);
    const me = yield* accountClient.account.me();
    const orgSlug = me.organization?.slug;
    expect(orgSlug, "the bound organization advertises a URL slug").toBeTruthy();

    const integration = unique("msgraph");
    const clientSlug = unique("msgraph_app");
    const connection = "machine";
    const template = MICROSOFT_CLIENT_CREDENTIALS_AUTH_TEMPLATE_SLUG;

    // The hosted emulator mints a real-shaped client-credentials app and records
    // every token exchange — the ledger is shared, so key everything off the
    // unique minted clientId.
    const emulator: EmulatorClient = yield* Effect.promise(() =>
      connectEmulator({ baseUrl: EMULATOR_BASE, service: "microsoft" }),
    );
    const minted = yield* Effect.promise(() =>
      emulator.credentials.mint({ type: "oauth-client-credentials", name: "Executor E2E Graph" }),
    );
    const oauth = yield* requireOAuthClientCredential(minted);

    yield* Effect.ensuring(
      Effect.gen(function* () {
        // Register the Microsoft Graph integration so the console has an OAuth
        // method to register a client against.
        yield* client.microsoft.addGraph({
          payload: {
            presetIds: ["users"],
            customScopes: [],
            slug: integration,
            name: "Microsoft Graph Emulator",
            baseUrl: emulator.baseUrl,
            specUrl: emulator.openapiUrl,
          },
        });

        // 1. The agent asks for a browser handoff URL — it has the client id and
        //    endpoints (discovered/known), but never the secret.
        const handoff = yield* executeJson(
          session,
          handoffForBrowserCode({
            integration,
            slug: clientSlug,
            clientId: oauth.clientId,
            authorizationUrl: oauth.authorizationUrl,
            tokenUrl: oauth.tokenUrl,
          }),
        );
        expect(handoff.ok, `createHandoff succeeded: ${JSON.stringify(handoff)}`).toBe(true);
        const handoffUrl = String(handoff.url);

        const parsed = new URL(handoffUrl);
        expect(parsed.origin, `handoff URL (${handoffUrl}) targets this deployment`).toBe(
          new URL(target.baseUrl).origin,
        );
        expect(parsed.pathname).toBe(`/${orgSlug}/integrations/${integration}`);
        // The agent's URL carries the client id but NOT the secret.
        expect(handoffUrl).toContain(oauth.clientId);
        expect(
          handoffUrl.includes(oauth.clientSecret),
          "the handoff URL never carries the client secret",
        ).toBe(false);

        // 2. The human opens the URL: the Register-OAuth-app form is open and
        //    pre-filled from the handoff. They type ONLY the secret.
        yield* browser.session(identity, async ({ page, step }) => {
          await step("Open the agent's handoff URL", async () => {
            await page.goto(handoffUrl, { waitUntil: "networkidle" });
          });

          await step("The Register-OAuth-app form auto-opens, pre-filled", async () => {
            await page
              .getByRole("heading", { name: "Register OAuth app" })
              .waitFor({ timeout: 20_000 });
            // The agent's non-secret fields pre-filled — this is the whole point
            // of the handoff: the human verifies, they don't re-type.
            await expect
              .poll(() => page.locator("#oauth-client-id").inputValue())
              .toBe(oauth.clientId);
            await expect
              .poll(() => page.locator("#grant-client_credentials").isChecked())
              .toBe(true);
          });

          await step("The human types the client secret (only the secret)", async () => {
            const secret = page.locator("#oauth-client-secret");
            await secret.waitFor({ timeout: 15_000 });
            await secret.fill(oauth.clientSecret);
          });

          await step("Register the app", async () => {
            await page.getByRole("button", { name: "Register app" }).click();
            // onCreated returns to the Add-connection view — the register form closes.
            await page
              .getByRole("heading", { name: "Register OAuth app" })
              .waitFor({ state: "hidden", timeout: 20_000 });
          });
        });

        // 3. The agent discovers the browser-registered client and completes the
        //    connection — client credentials need no user consent.
        const listed = yield* executeJson(session, listClientSlugsCode);
        expect(
          (listed.slugs as ReadonlyArray<string> | undefined)?.includes(clientSlug),
          `the agent sees the human-registered client: ${JSON.stringify(listed)}`,
        ).toBe(true);

        const started = yield* executeJson(
          session,
          startConnectionCode({
            slug: clientSlug,
            integration,
            connection,
            template: String(template),
          }),
        );
        expect(started.ok, `oauth.start succeeded: ${JSON.stringify(started)}`).toBe(true);
        expect(started.status, "client-credentials OAuth connected without browser consent").toBe(
          "connected",
        );

        // 4. The emulator ledger proves Executor exchanged THIS app's credentials.
        const ledger = yield* Effect.promise(() => emulator.ledger.list());
        const tokenRequest = ledger.find(
          (entry) =>
            entry.path === "/oauth2/v2.0/token" &&
            JSON.stringify(entry.request.body ?? "").includes(oauth.clientId),
        );
        expect(
          tokenRequest?.response.status,
          "the emulator recorded a client-credentials token exchange for this app",
        ).toBe(200);
        expect(tokenRequest?.request.body).toMatchObject({ grant_type: "client_credentials" });
      }),
      // Best-effort teardown: selfhost shares one workspace, so remove everything.
      Effect.gen(function* () {
        yield* client.connections
          .remove({
            params: {
              owner: "org",
              integration: IntegrationSlug.make(integration),
              name: ConnectionName.make(connection),
            },
          })
          .pipe(Effect.ignore);
        yield* client.oauth
          .removeClient({
            params: { slug: OAuthClientSlug.make(clientSlug) },
            payload: { owner: "org" },
          })
          .pipe(Effect.ignore);
        yield* client.microsoft.removeGraph({ params: { slug: integration } }).pipe(Effect.ignore);
      }).pipe(Effect.ignore),
    );
  }),
);
