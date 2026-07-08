import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { HttpApiClient } from "effect/unstable/httpapi";
import { composePluginApi } from "@executor-js/api/server";
import { connectEmulator, type EmulatorClient } from "@executor-js/emulate";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
} from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import type { Identity, Target as TargetShape } from "../src/target";
import type { BrowserSurface } from "../src/surfaces/browser";

const api = composePluginApi([openApiHttpPlugin()] as const);
type Client = HttpApiClient.ForApi<typeof api>;
const GOOGLE_AUTH_TEMPLATE = AuthTemplateSlug.make("googleOAuth2");
const CONNECTION = ConnectionName.make("main");

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

const decodeHtml = (value: string): string =>
  value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");

const inputFields = (html: string): Record<string, string> => {
  const fields: Record<string, string> = {};
  for (const input of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = input[0];
    const name = tag.match(/\bname=["']([^"']+)["']/i)?.[1];
    const value = tag.match(/\bvalue=["']([^"']*)["']/i)?.[1] ?? "";
    if (name) fields[decodeHtml(name)] = decodeHtml(value);
  }
  return fields;
};

const formAction = (html: string, fallback: string): string => {
  const action = html.match(/<form\b[^>]*\baction=["']([^"']+)["']/i)?.[1];
  return action ? decodeHtml(action) : fallback;
};

const completeGoogleConsent = (authorizationUrl: string) =>
  Effect.promise(async () => {
    const page = await fetch(authorizationUrl);
    if (!page.ok) throw new Error(`Google emulator authorize failed: ${page.status}`);
    const html = await page.text();
    const callback = await fetch(formAction(html, authorizationUrl), {
      method: "POST",
      body: new URLSearchParams(inputFields(html)),
      redirect: "manual",
    });
    const location = callback.headers.get("location");
    if (callback.status !== 302 || !location) {
      throw new Error(`Google emulator consent did not redirect: ${callback.status}`);
    }
    const code = new URL(location).searchParams.get("code");
    if (!code) throw new Error("Google emulator callback did not include a code");
    return code;
  });

const createGoogleEmulator = Effect.promise(async () => {
  const response = await fetch("https://google.emulators.dev/_emulate/instances", {
    method: "POST",
  });
  if (!response.ok) throw new Error(`Google emulator instance failed: ${response.status}`);
  const instance = (await response.json()) as { readonly providerBaseUrl: string };
  const client = await connectEmulator({ baseUrl: instance.providerBaseUrl });
  return { client, baseUrl: instance.providerBaseUrl };
});

const addGooglePresetFromCatalog = (
  browser: BrowserSurface,
  identity: Identity,
  presetName: string,
  slug: string,
) =>
  browser.session(identity, async ({ page, step }) => {
    await step(`Open ${presetName} from the connect catalog`, async () => {
      await page.goto("/integrations", { waitUntil: "networkidle" });
      await page
        .getByRole("button", { name: /Connect/ })
        .first()
        .click();
      const dialog = page.getByRole("dialog", { name: "Connect an integration" });
      await dialog.waitFor();
      await dialog.getByPlaceholder(/Search or paste a URL/).fill(presetName);
      await dialog.getByRole("link", { name: new RegExp(`^${presetName}\\b`) }).click();
    });

    await step(`Add the ${presetName} integration`, async () => {
      await page.waitForURL(/\/integrations\/add\/openapi/);
      await page.getByRole("heading", { name: "Add OpenAPI integration" }).waitFor();
      const button = page.getByRole("button", { name: "Add integration" });
      await button.waitFor({ timeout: 120_000 });
      await button.click({ timeout: 120_000 });
      await page.waitForURL(new RegExp(`/integrations/${slug}\\b`), { timeout: 120_000 });
    });
  });

const connectGoogleAccount = (input: {
  readonly client: Client;
  readonly emulator: EmulatorClient;
  readonly emulatorBaseUrl: string;
  readonly integrationBaseUrl?: string;
  readonly target: TargetShape;
  readonly integration: IntegrationSlug;
  readonly oauthClient: OAuthClientSlug;
}) =>
  Effect.gen(function* () {
    const redirectUri = new URL("/api/oauth/callback", input.target.baseUrl).toString();
    const credential = yield* Effect.promise(() =>
      input.emulator.credentials.mint({
        type: "oauth-authorization-code",
        redirect_uris: [redirectUri],
      }),
    );
    if (!credential.client_id || !credential.client_secret) {
      return yield* Effect.die(`Google emulator did not mint an OAuth client`);
    }

    yield* input.client.openapi.configure({
      params: { slug: input.integration },
      payload: { baseUrl: input.integrationBaseUrl ?? input.emulatorBaseUrl },
    });
    yield* input.client.oauth.createClient({
      payload: {
        owner: "org",
        slug: input.oauthClient,
        grant: "authorization_code",
        authorizationUrl: `${input.emulatorBaseUrl}/o/oauth2/v2/auth`,
        tokenUrl: `${input.emulatorBaseUrl}/oauth2/token`,
        clientId: credential.client_id,
        clientSecret: credential.client_secret,
        originIntegration: input.integration,
      },
    });

    const started = yield* input.client.oauth.start({
      payload: {
        client: input.oauthClient,
        clientOwner: "org",
        owner: "org",
        name: CONNECTION,
        integration: input.integration,
        template: GOOGLE_AUTH_TEMPLATE,
        redirectUri,
      },
    });
    expect(started.status, "OAuth starts with an emulator redirect").toBe("redirect");
    if (started.status !== "redirect") return yield* Effect.die("OAuth unexpectedly connected");

    const code = yield* completeGoogleConsent(started.authorizationUrl);
    const completed = yield* input.client.oauth.complete({
      payload: { state: started.state, code },
    });
    expect(completed.integration, "OAuth completion creates the connection").toBe(
      input.integration,
    );
  });

scenario(
  "Google · Calendar and Gmail catalog health checks run against the emulator",
  { timeout: 300_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const { client: makeClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeClient(api, identity);
    const emulator = yield* createGoogleEmulator;

    const rows = [
      {
        presetName: "Google Calendar",
        slug: IntegrationSlug.make("google_calendar"),
        oauthClient: OAuthClientSlug.make(unique("google_calendar_oauth")),
        expectedHealthOperation: "calendar.calendarList.list",
        expectedLedgerOperation: "calendar.calendarList.list",
        emulatorPathPrefix: "/calendar/v3",
      },
      {
        presetName: "Gmail",
        slug: IntegrationSlug.make("google_gmail"),
        oauthClient: OAuthClientSlug.make(unique("google_gmail_oauth")),
        expectedHealthOperation: "gmail.users.labels.list",
        expectedLedgerOperation: "gmail.users.labels.list",
        emulatorPathPrefix: "",
      },
    ] as const;

    yield* Effect.ensuring(
      Effect.gen(function* () {
        for (const row of rows) {
          yield* addGooglePresetFromCatalog(browser, identity, row.presetName, String(row.slug));

          const stored = yield* client.integrations.healthCheckGet({ params: { slug: row.slug } });
          expect(stored?.operation, `${row.presetName} stored health check`).toBe(
            row.expectedHealthOperation,
          );

          yield* connectGoogleAccount({
            client,
            emulator: emulator.client,
            emulatorBaseUrl: emulator.baseUrl,
            integrationBaseUrl: `${emulator.baseUrl}${row.emulatorPathPrefix ?? ""}`,
            target,
            integration: row.slug,
            oauthClient: row.oauthClient,
          });

          const tools = yield* client.tools.list({
            query: { integration: row.slug, connection: CONNECTION },
          });
          expect(
            tools.length,
            `${row.presetName} exposes tools for the connection`,
          ).toBeGreaterThan(0);

          const health = yield* client.connections.checkHealth({
            params: { owner: "org", integration: row.slug, name: CONNECTION },
            query: { ifStaleMs: 0 },
          });
          expect(
            health.status,
            `${row.presetName} health check is healthy: ${JSON.stringify(health)}`,
          ).toBe("healthy");
        }

        const ledger = yield* Effect.promise(() => emulator.client.ledger.list(100));
        for (const row of rows) {
          expect(
            ledger.some((entry) => entry.operationId === row.expectedLedgerOperation),
            `${row.presetName} health check reached the Google emulator`,
          ).toBe(true);
        }
      }),
      Effect.gen(function* () {
        for (const row of rows) {
          yield* client.connections
            .remove({
              params: { owner: "org", integration: row.slug, name: CONNECTION },
            })
            .pipe(Effect.ignore);
          yield* client.oauth
            .removeClient({ params: { slug: row.oauthClient }, payload: { owner: "org" } })
            .pipe(Effect.ignore);
          yield* client.openapi.removeSpec({ params: { slug: row.slug } }).pipe(Effect.ignore);
        }
      }),
    );
  }),
);
