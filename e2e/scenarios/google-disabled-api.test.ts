// A Google 403 for a DISABLED API must NOT read as an expired credential.
//
// Production case (2026-07-10): a user's "Personal Google" connection showed
// the red Expired badge although its OAuth token was alive and refreshing.
// The org's Google OAuth client lives in a GCP project without the Gmail /
// Drive / Calendar APIs enabled, so the health probe gets Google's
// SERVICE_DISABLED 403 ("Gmail API has not been used in project ... or it is
// disabled"). The old status-only classifier mapped every 401/403 to
// "expired", so a healthy credential rendered as Expired and the UI told the
// user to reconnect - advice that cannot fix a disabled upstream API.
//
// The scenario replays that exact journey against the Google emulator: a real
// OAuth grant probes healthy; then the upstream starts answering the probe
// operation with Google's real SERVICE_DISABLED body (fault injection - the
// token stays valid, exactly like prod). The fixed classifier reads the error
// body and reports "misconfigured": on screen that is the amber "API
// disabled" badge with Google's own remediation text (including the console
// link that enables the API), and no reconnect prompt.
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

import { createEmulatorInstance } from "../src/emulator-instance";
import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import type { Identity, Target as TargetShape } from "../src/target";
import type { BrowserSurface } from "../src/surfaces/browser";

const api = composePluginApi([openApiHttpPlugin()] as const);
type Client = HttpApiClient.ForApi<typeof api>;
const GOOGLE_AUTH_TEMPLATE = AuthTemplateSlug.make("googleOAuth2");
const CONNECTION = ConnectionName.make("main");

// The Gmail preset's declared health check, and the probe the fault hijacks.
const GMAIL_HEALTH_OPERATION = "gmail.users.labels.list";

// Google's real error body for an API that is not enabled in the OAuth
// client's GCP project. Verbatim shape from production: HTTP 403 with reason
// `accessNotConfigured` - an authorization-configuration error, NOT an
// expired/revoked credential.
const DISABLED_API_MESSAGE =
  "Gmail API has not been used in project 000000000000 before or it is disabled. " +
  "Enable it by visiting https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=000000000000 then retry.";
const disabledApiBody = {
  error: {
    code: 403,
    message: DISABLED_API_MESSAGE,
    errors: [
      { message: DISABLED_API_MESSAGE, domain: "usageLimits", reason: "accessNotConfigured" },
    ],
    status: "PERMISSION_DENIED",
  },
};

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
  const baseUrl = yield* createEmulatorInstance("google", "disabled-api");
  const client = yield* Effect.promise(() => connectEmulator({ baseUrl }));
  return { client, baseUrl };
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
      payload: { baseUrl: input.emulatorBaseUrl },
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
  "Google · a disabled upstream API reads as API disabled with the enable link, not Expired",
  { timeout: 300_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const { client: makeClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeClient(api, identity);
    const emulator = yield* createGoogleEmulator;
    const slug = IntegrationSlug.make("google_gmail");
    const oauthClient = OAuthClientSlug.make(unique("google_gmail_oauth"));

    yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* addGooglePresetFromCatalog(browser, identity, "Gmail", String(slug));

        const stored = yield* client.integrations.healthCheckGet({ params: { slug } });
        expect(stored?.operation, "the Gmail preset declares its labels probe").toBe(
          GMAIL_HEALTH_OPERATION,
        );

        yield* connectGoogleAccount({
          client,
          emulator: emulator.client,
          emulatorBaseUrl: emulator.baseUrl,
          target,
          integration: slug,
          oauthClient,
        });

        // Baseline: the freshly granted token probes healthy against the
        // emulator - same as prod the day the account was connected.
        const healthy = yield* client.connections.checkHealth({
          params: { owner: "org", integration: slug, name: CONNECTION },
          query: { ifStaleMs: 0 },
        });
        expect(healthy.status, `the fresh grant probes healthy: ${JSON.stringify(healthy)}`).toBe(
          "healthy",
        );

        // The upstream flips: the probe operation now answers with Google's
        // real SERVICE_DISABLED 403. ONLY that route faults - the OAuth token
        // endpoints stay live, so the credential itself remains valid and
        // refreshable, exactly the production condition. Generous `times`
        // covers the UI's automatic revalidations on top of explicit checks.
        yield* Effect.promise(() =>
          emulator.client.faults.arm({
            match: { operationId: GMAIL_HEALTH_OPERATION },
            response: { status: 403, body: disabledApiBody },
            times: 100,
          }),
        );
        yield* Effect.promise(() => emulator.client.ledger.clear());

        // The fix under test: a 403 that means "enable this API in your GCP
        // project" classifies as misconfigured, not as a dead credential.
        const verdict = yield* client.connections.checkHealth({
          params: { owner: "org", integration: slug, name: CONNECTION },
          query: { ifStaleMs: 0 },
        });
        expect(
          verdict.status,
          `the SERVICE_DISABLED 403 classifies as misconfigured: ${JSON.stringify(verdict)}`,
        ).toBe("misconfigured");
        expect(verdict.httpStatus, "the probe observed the 403").toBe(403);
        expect(
          verdict.detail,
          "the stored detail names the real cause (a disabled API, not an expired token)",
        ).toContain("has not been used in project");

        // The 403 came from the armed fault on the probe route - the token
        // was never rejected by the emulator's auth layer.
        const ledger = yield* Effect.promise(() => emulator.client.ledger.list(50));
        const probeEntry = ledger.find((entry) => entry.operationId === GMAIL_HEALTH_OPERATION);
        expect(probeEntry?.faulted, "the probe was answered by the armed fault").toBe(true);

        yield* browser.session(identity, async ({ page, step }) => {
          const connections = page.locator("section").filter({
            has: page.getByRole("heading", { level: 3, name: "Connections" }),
          });

          await step(
            "The connection shows the amber API disabled badge - not Expired - with no clicks",
            async () => {
              await page.goto(`/integrations/${slug}`, { waitUntil: "networkidle" });
              await connections
                .getByText("API disabled", { exact: true })
                .waitFor({ timeout: 30_000 });
              await connections.getByLabel("Status: API disabled").waitFor();
              // The dead-credential story must be gone entirely.
              expect(
                await connections.getByText("Expired", { exact: true }).count(),
                "no Expired badge on a misconfigured connection",
              ).toBe(0);
            },
          );

          await step(
            "The row carries Google's own instruction, console link included",
            async () => {
              const detail = connections.getByText(/has not been used in project/);
              await detail.waitFor();
              const consoleLink = connections.getByRole("link", {
                name: /console\.developers\.google\.com/,
              });
              await consoleLink.waitFor();
              expect(
                await consoleLink.getAttribute("href"),
                "the enable-API console link is clickable",
              ).toContain("console.developers.google.com");
              // Visible in FULL, not just present in the DOM: a one-line
              // truncate keeps the link in the tree while clipping it from
              // view, which is exactly the regression this guards against.
              // A clipped element overflows horizontally; a wrapped one
              // grows taller instead.
              const clipped = await detail.evaluate(
                (el) =>
                  el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
              );
              expect(clipped, "the remediation text wraps instead of clipping").toBe(false);
              const linkVisible = await consoleLink.evaluate((el) => {
                const rect = el.getBoundingClientRect();
                const detailRect = el.closest("p")?.getBoundingClientRect();
                return detailRect ? rect.right <= detailRect.right + 1 : false;
              });
              expect(linkVisible, "the console link sits inside the visible detail box").toBe(true);
            },
          );

          await step(
            "Check now explains the disabled API instead of prescribing reconnect",
            async () => {
              await connections.locator('button[aria-haspopup="menu"]').click();
              await page.getByRole("menuitem", { name: "Check now" }).click();
              await page
                .getByText(/has not been used in project/)
                .first()
                .waitFor({ timeout: 30_000 });
              expect(
                await page.getByText("Connection expired, reconnect to restore access").count(),
                "the reconnect toast never fires for a configuration 403",
              ).toBe(0);
            },
          );
        });
      }),
      Effect.gen(function* () {
        yield* client.connections
          .remove({ params: { owner: "org", integration: slug, name: CONNECTION } })
          .pipe(Effect.ignore);
        yield* client.oauth
          .removeClient({ params: { slug: oauthClient }, payload: { owner: "org" } })
          .pipe(Effect.ignore);
        yield* client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
      }),
    );
  }),
);
