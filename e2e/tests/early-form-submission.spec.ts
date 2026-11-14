import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { createHash, randomBytes } from "node:crypto";
import { Actors, password } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { authorizeBrowserMcp } from "../support/mcp-oauth.ts";
import { Target, driver } from "../support/platform.ts";
import { targetHosts } from "../support/role-hosts.ts";
import { scenarios } from "../test-plan.ts";

/**
 * An MCP client opens the consent page in its own tab, as a real client does, and Connect is
 * pressed before the page hydrates. Consent runs on the browser origin; Cloud serves MCP on its
 * own host, which the client names as its resource.
 */
const approveBeforeHydration = Effect.gen(function* () {
  const actors = yield* Actors,
    browser = yield* Browser,
    target = yield* Target;
  const hosts = targetHosts(target);
  yield* browser.login(actors.owner);
  yield* browser.omitNetworkTrace;
  const token = yield* Effect.scoped(
    Effect.gen(function* () {
      const tab = yield* Effect.acquireRelease(
        browser.use("Open the assistant's sign-in tab", (page) => page.context().newPage()),
        (tab) => driver("Close the assistant's sign-in tab", () => tab.close()).pipe(Effect.orDie),
      );
      return yield* authorizeBrowserMcp(tab, hosts.browser, {
        resource: `${hosts.mcp}/mcp`,
        client: "Early assistant",
        beforeHydration: true,
      });
    }),
  );
  expect(token).toBeDefined();
});

layer(HostedLive, { excludeTestServices: true })("Early form submission", (it) => {
  it.effect(scenarios.earlyFormSubmission.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const browser = yield* Browser;
        const addresses: string[] = [];
        let releaseScripts = () => {};
        const scriptsHeld = new Promise<void>((resolve) => {
          releaseScripts = resolve;
        });
        yield* browser.use("Hold the dashboard's scripts so the page cannot hydrate", (page) => {
          page.on("framenavigated", (frame) => {
            if (frame === page.mainFrame()) addresses.push(frame.url());
          });
          return page.route(/\/assets\/[^/]+\.js$/, (route) =>
            scriptsHeld.then(() => route.fallback()),
          );
        });
        // One step: each step afterwards waits for the page to become interactive.
        expect(
          yield* browser.use(
            "Sign in on the server-rendered page before it is interactive",
            (page) =>
              page
                .goto("/login", { waitUntil: "commit" })
                .then(() => page.getByLabel("Email", { exact: true }).fill("owner@example.test"))
                .then(() => page.getByLabel("Password", { exact: true }).fill(password))
                .then(() => page.getByRole("button", { name: "Sign in", exact: true }).click())
                .then(() =>
                  page.evaluate(() => document.documentElement.hasAttribute("data-hydrated")),
                ),
          ),
          "the submission happened before hydration",
        ).toBe(false);
        // A native submission would have sent the fields in the address.
        const leaked = () =>
          addresses.filter(
            (address) =>
              new URL(address).searchParams.has("password") ||
              address.includes("owner%40example.test"),
          );
        expect(leaked(), "the early submission must not navigate with its fields").toEqual([]);
        yield* browser.use("Let the page hydrate", () => {
          releaseScripts();
          return Promise.resolve();
        });
        yield* browser.use("The held submission signs in once the page is interactive", (page) =>
          page.waitForURL(`**/org/${actors.organization.slug}/apps`),
        );
        expect(leaked()).toEqual([]);
      }),
    ),
  );
  it.effect(scenarios.earlyConsentDecision.title, (context) =>
    withHostedCase(context, approveBeforeHydration),
  );

  it.effect(scenarios.earlyConsentDecisionCloud.title, (context) =>
    withHostedCase(context, approveBeforeHydration),
  );
  it.effect(scenarios.earlyDeviceDecision.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          browser = yield* Browser,
          target = yield* Target;
        const hosts = targetHosts(target);
        // A device client asks to sign in; the owner reviews its code on the device page.
        const started = yield* driver("start a device sign-in", () =>
          fetch(`${hosts.browser}/api/auth/oauth2/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              client_name: "Early device",
              token_endpoint_auth_method: "none",
              grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
              response_types: [],
              scope: "executor offline_access",
            }),
          })
            .then((response) => response.json() as Promise<{ client_id: string }>)
            .then(({ client_id }) =>
              fetch(`${hosts.browser}/api/auth/oauth2/device-authorization`, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                  client_id,
                  scope: "executor offline_access",
                  resource: `${hosts.api}/api`,
                }),
              }),
            )
            .then((response) => response.json() as Promise<{ verification_uri_complete: string }>),
        );
        yield* browser.login(actors.owner);
        yield* browser.omitNetworkTrace;
        const addresses: string[] = [];
        let releaseScripts = () => {};
        const scriptsHeld = new Promise<void>((resolve) => {
          releaseScripts = resolve;
        });
        yield* browser.use("Hold the device page's scripts so it cannot hydrate", (page) => {
          page.on("framenavigated", (frame) => {
            if (frame === page.mainFrame()) addresses.push(frame.url());
          });
          return page.route(/\/assets\/[^/]+\.js$/u, (route) =>
            scriptsHeld.then(() => route.fallback()),
          );
        });
        // One step: each step afterwards waits for the page to become interactive. Connect waits
        // for an organization to be chosen, which needs the page's scripts; Deny does not.
        expect(
          yield* browser.use("Deny on the server-rendered device page", (page) =>
            page
              .goto(started.verification_uri_complete, { waitUntil: "commit" })
              .then(() => page.getByRole("button", { name: "Deny", exact: true }).click())
              .then(() =>
                page.evaluate(() => document.documentElement.hasAttribute("data-hydrated")),
              ),
          ),
          "the decision was made before hydration",
        ).toBe(false);
        const native = () =>
          addresses.filter((address) => new URL(address).searchParams.has("decision"));
        expect(native(), "the early decision must not be sent natively").toEqual([]);
        yield* browser.use("Let the device page hydrate", () => {
          releaseScripts();
          return Promise.resolve();
        });
        yield* browser.use("The held decision denies the request", (page) =>
          page.getByText("Request denied.", { exact: true }).waitFor({ state: "visible" }),
        );
        expect(native()).toEqual([]);
      }),
    ),
  );
  it.effect(scenarios.oneConsentDecision.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          browser = yield* Browser,
          target = yield* Target;
        const hosts = targetHosts(target);
        const redirect = "http://127.0.0.1:9/callback";
        const { client_id } = yield* driver("register a client", () =>
          fetch(`${hosts.browser}/api/auth/oauth2/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              client_name: "Twice decided client",
              redirect_uris: [redirect],
              token_endpoint_auth_method: "none",
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
            }),
          }).then((response) => response.json() as Promise<{ client_id: string }>),
        );
        const authorization = new URL(`${hosts.browser}/api/auth/oauth2/authorize`);
        authorization.search = new URLSearchParams({
          response_type: "code",
          client_id,
          redirect_uri: redirect,
          code_challenge: createHash("sha256")
            .update(randomBytes(32).toString("base64url"))
            .digest("base64url"),
          code_challenge_method: "S256",
          scope: "mcp offline_access",
          resource: `${hosts.mcp}/mcp`,
          state: randomBytes(16).toString("hex"),
        }).toString();
        yield* browser.login(actors.owner);
        yield* browser.omitNetworkTrace;
        const decisions: unknown[] = [];
        yield* browser.use("Record consent requests", (page) =>
          page.route(/\/api\/auth\/oauth2\/consent$/u, (route) => {
            decisions.push(route.request().postDataJSON());
            return route.fallback();
          }),
        );
        yield* browser.use("Open the consent page", (page) => page.goto(authorization.href));
        yield* browser.use("Connect is offered", (page) =>
          page.getByRole("button", { name: "Connect", exact: true }).waitFor(),
        );
        // A replayed early Cancel and a real Connect in the same moment: both buttons are still
        // enabled, so only the page's one-decision rule can keep the second from being sent.
        yield* browser.use("Submit Cancel, then Connect, before the page renders again", (page) =>
          Promise.all([
            page.waitForRequest((request) => request.url().startsWith(redirect)),
            page.evaluate(() => {
              const buttons = [
                ...document.querySelectorAll<HTMLButtonElement>("form.mcp-consent-actions button"),
              ];
              const cancel = buttons.find((button) => button.value === "decline");
              const connect = buttons.find((button) => button.value === "connect");
              if (
                cancel?.form == null ||
                connect === undefined ||
                cancel.disabled ||
                connect.disabled
              )
                throw new Error("Both decisions must be enabled");
              cancel.form.requestSubmit(cancel);
              cancel.form.requestSubmit(connect);
            }),
          ]),
        );
        expect(decisions).toEqual([expect.objectContaining({ accept: false })]);
      }),
    ),
  );
});
