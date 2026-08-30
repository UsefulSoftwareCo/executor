import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect, Schedule } from "effect";
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

import { createEmulatorInstance } from "../src/emulator-instance";
import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import type { Identity, Target as TargetShape } from "../src/target";
import { type BrowserSurface, visit } from "../src/surfaces/browser";

const api = composePluginApi([openApiHttpPlugin()] as const);
type Client = HttpApiClient.ForApi<typeof api>;
const GOOGLE_AUTH_TEMPLATE = AuthTemplateSlug.make("googleOAuth2");
const CONNECTION = ConnectionName.make("main");
const GOOGLE_EMULATOR_ACCOUNT_EMAIL = "testuser@gmail.com";
const googleDiscoveryUrl = (service: string, version: string) =>
  `https://www.googleapis.com/discovery/v1/apis/${service}/${version}/rest`;

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

const createGoogleEmulator = Effect.gen(function* () {
  // Through the shared helper: it bounds and retries the one request in this
  // scenario that leaves the runner, so a blip on the way to the edge doesn't
  // read as a Google health-check failure.
  const baseUrl = yield* createEmulatorInstance("google", "google-health");
  const client = yield* Effect.promise(() => connectEmulator({ baseUrl }));
  return { client, baseUrl };
});

const addGooglePresetFromDirectUrl = (
  browser: BrowserSurface,
  identity: Identity,
  presetName: string,
  presetId: string,
  presetUrl: string,
  slug: string,
) =>
  browser.session(identity, async ({ page, step }) => {
    await step(`Open the ${presetName} preset add flow directly`, async () => {
      const search = new URLSearchParams({ preset: presetId, url: presetUrl });
      await visit(page, `/integrations/add/openapi?${search}`);
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
  readonly newConnection?: boolean;
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

    return yield* runGoogleOAuthFlow(input, redirectUri);
  });

/** Run one authorize+complete round through the already-registered app. Split
 *  from `connectGoogleAccount` so a scenario can connect a SECOND account
 *  through the same app (`newConnection: true`) without re-registering it. */
const runGoogleOAuthFlow = (
  input: {
    readonly client: Client;
    readonly target: TargetShape;
    readonly integration: IntegrationSlug;
    readonly oauthClient: OAuthClientSlug;
    readonly newConnection?: boolean;
  },
  redirectUriOverride?: string,
) =>
  Effect.gen(function* () {
    const redirectUri =
      redirectUriOverride ?? new URL("/api/oauth/callback", input.target.baseUrl).toString();
    const started = yield* input.client.oauth.start({
      payload: {
        client: input.oauthClient,
        clientOwner: "org",
        owner: "org",
        name: CONNECTION,
        integration: input.integration,
        template: GOOGLE_AUTH_TEMPLATE,
        redirectUri,
        ...(input.newConnection === true ? { newConnection: true } : {}),
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
    return completed;
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
        presetId: "google-calendar",
        presetUrl: googleDiscoveryUrl("calendar", "v3"),
        slug: IntegrationSlug.make("google_calendar"),
        oauthClient: OAuthClientSlug.make(unique("google_calendar_oauth")),
        expectedHealthOperation: "calendar.calendarList.list",
        expectedLedgerOperation: "calendar.calendarList.list",
        emulatorPathPrefix: "/calendar/v3",
      },
      {
        presetName: "Gmail",
        presetId: "google-gmail",
        presetUrl: googleDiscoveryUrl("gmail", "v1"),
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
          yield* addGooglePresetFromDirectUrl(
            browser,
            identity,
            row.presetName,
            row.presetId,
            row.presetUrl,
            String(row.slug),
          );

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

          const connections = yield* client.connections.list({
            query: { owner: "org", integration: row.slug },
          });
          const connected = connections.find((connection) => connection.name === CONNECTION);
          expect(
            connected?.identityLabel,
            `${row.presetName} stores OAuth identity from the id_token before health checks`,
          ).toBe(GOOGLE_EMULATOR_ACCOUNT_EMAIL);
          expect(
            connected?.lastHealth,
            `${row.presetName} has not run a health check before the explicit probe`,
          ).toBeNull();

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

          // Check this row's ledger entry HERE, not after both rows have run.
          // `ledger.list(n)` is the last n entries, and connecting the second
          // account is easily a hundred emulator requests, so the first row's
          // health check can be evicted from the window before a combined
          // assertion at the end ever looks for it — which reads as "Calendar's
          // health check never reached the emulator" when it plainly did (the
          // probe above came back healthy, and only the emulator can answer
          // that). The hosted emulator also acknowledges a request before its
          // ledger entry is readable, so poll rather than read once.
          const reached = yield* Effect.promise(() => emulator.client.ledger.list(50)).pipe(
            Effect.map((ledger) =>
              ledger.some((entry) => entry.operationId === row.expectedLedgerOperation),
            ),
            Effect.repeat({
              schedule: Schedule.spaced("500 millis"),
              until: (seen) => seen,
              times: 19,
            }),
          );
          expect(
            reached,
            `${row.presetName}'s health check reached the Google emulator as ${row.expectedLedgerOperation}`,
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

scenario(
  "Google · OAuth catalog connection without a health check is healthy from the grant",
  { timeout: 300_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const { client: makeClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeClient(api, identity);
    const emulator = yield* createGoogleEmulator;
    const slug = IntegrationSlug.make("google_sheets");
    const oauthClient = OAuthClientSlug.make(unique("google_sheets_oauth"));

    yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* addGooglePresetFromDirectUrl(
          browser,
          identity,
          "Google Sheets",
          "google-sheets",
          googleDiscoveryUrl("sheets", "v4"),
          String(slug),
        );

        const stored = yield* client.integrations.healthCheckGet({ params: { slug } });
        expect(stored, "Google Sheets catalog preset declares no health check").toBeNull();

        yield* connectGoogleAccount({
          client,
          emulator: emulator.client,
          emulatorBaseUrl: emulator.baseUrl,
          target,
          integration: slug,
          oauthClient,
        });

        const connections = yield* client.connections.list({
          query: { owner: "org", integration: slug },
        });
        const connected = connections.find((connection) => connection.name === CONNECTION);
        expect(
          connected?.identityLabel,
          "Google Sheets stores grant identity before any probe is configured",
        ).toBe(GOOGLE_EMULATOR_ACCOUNT_EMAIL);
        expect(
          connected?.lastHealth,
          "Google Sheets has not run a health check before the explicit check",
        ).toBeNull();

        const health = yield* client.connections.checkHealth({
          params: { owner: "org", integration: slug, name: CONNECTION },
          query: { ifStaleMs: 0 },
        });
        expect(
          health.status,
          `Google Sheets no-probe health is healthy: ${JSON.stringify(health)}`,
        ).toBe("healthy");
        expect(health.detail).toBe("Credential resolved (no probe configured).");

        const refreshed = yield* client.connections.list({
          query: { owner: "org", integration: slug },
        });
        expect(
          refreshed.find((connection) => connection.name === CONNECTION)?.identityLabel,
          "Google Sheets still shows the OAuth grant identity after no-probe health",
        ).toBe(GOOGLE_EMULATOR_ACCOUNT_EMAIL);

        // Reconnecting the SAME connection must not clobber a curated label
        // with the grant identity.
        yield* client.connections.update({
          params: { owner: "org", integration: slug, name: CONNECTION },
          payload: { identityLabel: "Finance account" },
        });
        yield* runGoogleOAuthFlow({ client, target, integration: slug, oauthClient });
        const reconnected = yield* client.connections.list({
          query: { owner: "org", integration: slug },
        });
        expect(
          reconnected.find((connection) => connection.name === CONNECTION)?.identityLabel,
          "reconnect keeps the curated label over the grant identity",
        ).toBe("Finance account");

        // A `newConnection` connect under a taken name mints a SECOND
        // connection with a suffixed name instead of replacing the first.
        const second = yield* runGoogleOAuthFlow({
          client,
          target,
          integration: slug,
          oauthClient,
          newConnection: true,
        });
        expect(String(second.name), "second account mints a suffixed connection").toBe(
          `${String(CONNECTION)}2`,
        );
        expect(second.identityLabel, "second account label comes from the grant identity").toBe(
          GOOGLE_EMULATOR_ACCOUNT_EMAIL,
        );
        const both = yield* client.connections.list({
          query: { owner: "org", integration: slug },
        });
        expect(
          both.map((connection) => String(connection.name)).sort(),
          "both accounts coexist",
        ).toEqual([String(CONNECTION), `${String(CONNECTION)}2`]);
      }),
      Effect.gen(function* () {
        for (const name of [CONNECTION, ConnectionName.make(`${String(CONNECTION)}2`)]) {
          yield* client.connections
            .remove({
              params: { owner: "org", integration: slug, name },
            })
            .pipe(Effect.ignore);
        }
        yield* client.oauth
          .removeClient({ params: { slug: oauthClient }, payload: { owner: "org" } })
          .pipe(Effect.ignore);
        yield* client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
      }),
    );
  }),
);
