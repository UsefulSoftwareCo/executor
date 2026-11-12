import { expect, layer } from "@effect/vitest";
import { Effect, Schema, Schedule } from "effect";
import { scenarios } from "../test-plan.ts";
import { App } from "../support/contracts.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Evidence } from "../support/evidence.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withCase, withHostedCase } from "../support/case.ts";
import { analyticsEvents } from "../support/collector-events.ts";
import { Target } from "../support/platform.ts";
import { captureBrowserAnalytics, renderBrowserReplay } from "../support/product-analytics.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Onboarding } from "../support/onboarding.ts";

const Event = Schema.Struct({
  event: Schema.String,
  distinct_id: Schema.optional(Schema.String),
  properties: Schema.Record(Schema.String, Schema.Json),
});
const isSnapshot = (event: Schema.Json) =>
  event !== null &&
  typeof event === "object" &&
  !Array.isArray(event) &&
  "event" in event &&
  event.event === "$snapshot";

layer(HostedLive, { excludeTestServices: true })("Product analytics", (it) => {
  it.effect(scenarios.productAnalytics.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          browser = yield* Browser,
          target = yield* Target;
        expect(target.metadata.mode).toBe("managed");
        const actor = yield* body(
          Schema.Struct({ user: Schema.Struct({ id: Schema.String }) }),
          yield* api.request(actors.owner, "GET", "/api/auth/get-session"),
        );
        // Cases share one collector, so only this case's organization is considered.
        const organizationEvents = analyticsEvents({ organization: actors.organization.id });
        const before = (yield* organizationEvents).length;
        const prefix = `/api/organizations/${actors.organization.id}`;
        // Reads are traced but never exported; dashboard refetches would otherwise dominate.
        expect((yield* api.request(actors.owner, "GET", `${prefix}/inventory`)).status).toBe(200);
        const response = yield* api.request(actors.owner, "POST", `${prefix}/feedback`, {
          message: "Synthetic feedback from the product analytics scenario",
        });
        expect(response.status).toBe(200);
        const events = yield* organizationEvents.pipe(
          Effect.map((events) => events.slice(before)),
          Effect.repeat({
            schedule: Schedule.spaced("100 millis"),
            until: (events) =>
              events.some(
                (event) =>
                  event.event === "product_operation_completed" &&
                  event.properties.area === "feedback",
              ),
          }),
          Effect.timeout("10 seconds"),
        );
        expect(
          events.filter(
            (event) =>
              event.event.startsWith("product_operation_") &&
              event.properties.operation === "inventory",
          ),
        ).toEqual([]);
        const completed = events.filter(
          (event) =>
            event.event === "product_operation_completed" && event.properties.area === "feedback",
        );
        expect(completed).toHaveLength(1);
        expect(completed[0]).toMatchObject({
          distinct_id: actor.user.id,
          properties: {
            source: "dashboard",
            operation: "submit",
            organization_id: actors.organization.id,
            ok: true,
            executor_test: true,
          },
        });
        expect(completed[0]?.properties.duration_ms).toEqual(expect.any(Number));
        yield* browser.login(actors.owner);
        const capture = yield* browser.use(
          "Intercept synthetic analytics",
          captureBrowserAnalytics,
        );
        const evidence = yield* Evidence;
        yield* Effect.addFinalizer(() =>
          evidence.json("analytics.json", capture).pipe(Effect.orDie),
        );
        const snapshots = () => capture.events.filter(isSnapshot);
        const dashboard = `/org/${actors.organization.slug}/apps`;
        const open = (url: string) =>
          browser.use("Navigate product page", (page) => page.goto(url));
        const appsReady = () =>
          browser.use("Wait for apps", (page) =>
            page.getByRole("heading", { level: 1, name: /^Apps(?:\s*\d+)?$/ }).waitFor(),
          );
        const interact = () =>
          browser.use("Interact with dashboard", (page) => page.mouse.click(900, 350));
        const recordedAfter = (count: number) =>
          browser.use("Wait for real snapshot transport", (page) =>
            expect
              .poll(() => page.mouse.click(900, 350).then(() => snapshots().length), {
                timeout: 30000,
              })
              .toBeGreaterThan(count),
          );
        yield* browser.use("Serve a linked application stylesheet", (page) =>
          page.route("**/replay-layout.css", (route) =>
            route.fulfill({
              contentType: "text/css",
              body: ".shell { --replay-stylesheet-probe: linked; }",
            }),
          ),
        );
        yield* open(dashboard);
        yield* appsReady();
        yield* browser.use("Load linked CSS before capturing the replay", (page) =>
          page.evaluate(
            () =>
              new Promise<void>((resolve, reject) => {
                const link = document.createElement("link");
                link.rel = "stylesheet";
                link.href = "/replay-layout.css";
                link.onload = () => resolve();
                link.onerror = () => reject(new Error("Replay fixture stylesheet did not load"));
                document.head.append(link);
              }),
          ),
        );
        yield* interact();
        yield* recordedAfter(0);
        expect(capture.requests.filter((path) => path.includes("recorder"))).toEqual([]);
        // No browser file names the build; the page reads its release from the document.
        // Replay snapshots carry no event properties; every other browser event does.
        const browserEvents = capture.events
          .filter(Schema.is(Event))
          .filter((event) => event.event !== "$snapshot");
        expect(browserEvents.map((event) => event.event)).toContain("$identify");
        expect(browserEvents.map((event) => event.properties.release)).toEqual(
          browserEvents.map(() => target.metadata.commit),
        );
        yield* browser.use("Wait for the embedded stylesheet recording", () =>
          expect
            .poll(() => JSON.stringify(snapshots()), { timeout: 30000 })
            .toContain("--replay-stylesheet-probe"),
        );
        const initialReplay = [...snapshots()];
        const liveLayout = yield* browser.use("Read live dashboard layout", (page) =>
          page.locator(".shell").evaluate((element) => ({
            display: getComputedStyle(element).display,
            columns: getComputedStyle(element).gridTemplateColumns,
            background: getComputedStyle(document.body).backgroundColor,
            linkedStyle: getComputedStyle(element).getPropertyValue("--replay-stylesheet-probe"),
            top: element.getBoundingClientRect().top,
          })),
        );
        expect(liveLayout.display).toBe("grid");
        expect(liveLayout.linkedStyle).toBe("linked");
        yield* browser.checkpoint("live-dashboard");
        const first = snapshots().length;
        yield* browser.use("Insert ordinary content and synthetic secrets", (page) =>
          page.evaluate(() => {
            const region = document.createElement("section");
            region.id = "replay-fields";
            region.innerHTML =
              '<div title="VISIBLE_ATTRIBUTE">VISIBLE_TEXT</div><a href="/visible-link">VISIBLE_LINK</a><form><label>Account name<input aria-label="Replay account name" value="PRIVATE_INPUT"></label><label>Password<input aria-label="Replay password" type="password" value="PRIVATE_PASSWORD"></label><label>Token<input aria-label="Replay token" type="password" data-private value="PRIVATE_TOKEN"></label><label>Numeric credential<input type="number" data-private value="9876543210123"></label><textarea data-private>PRIVATE_JSON</textarea></form><textarea aria-label="Replay textarea">PRIVATE_TEXTAREA</textarea><pre>VISIBLE_CODE</pre><div data-private title="PRIVATE_ATTRIBUTE" data-secret="PRIVATE_DATA" style="--secret:PRIVATE_STYLE">PRIVATE_TEXT<code>PRIVATE_SECRET</code></div><div data-product-private>PRIVATE_PRODUCT</div><iframe srcdoc="VISIBLE_FRAME<input type=&quot;password&quot; value=&quot;PRIVATE_FRAME_PASSWORD&quot;><span data-private>PRIVATE_FRAME_SECRET</span>"></iframe>';
            document.body.append(region);
            console.log("PRIVATE_CONSOLE");
          }),
        );
        yield* interact();
        yield* recordedAfter(first);
        yield* browser.use("Update ordinary and secret fields, then reveal a token", (page) =>
          page
            .getByLabel("Replay password")
            .fill("PRIVATE_PASSWORD_EDIT")
            .then(() =>
              page
                .getByLabel("Replay token")
                .evaluate((element) => element.setAttribute("type", "text")),
            )
            .then(() =>
              page.getByRole("textbox", { name: "Replay token" }).fill("PRIVATE_TOKEN_REVEALED"),
            )
            .then(() =>
              page.getByRole("textbox", { name: "Replay account name" }).fill("PRIVATE_INPUT_EDIT"),
            ),
        );
        yield* recordedAfter(snapshots().length);
        const fieldsReplay = [...snapshots()];
        const deployed = yield* api.request(
          actors.owner,
          "POST",
          `/api/organizations/${actors.organization.id}/apps/deploy`,
          {
            name: "Replay privacy probe",
            files: [
              {
                path: "index.ts",
                content: `
import { defineApp, query, object, string, router } from "apps";
export default defineApp({}, async () => ({ tools: router({
   echo: query({ input: object({ message: string() }) }, async (_, input) => {
    if (input.message === "PRIVATE_TOOL_FAILURE") throw new Error("PRIVATE_TOOL_ERROR");
    return { message: input.message, result: "PRIVATE_TOOL_RESULT" };
  }),
 }) }));`,
              },
              appsManifest,
            ],
          },
        );
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        yield* open(`/org/${actors.organization.slug}/apps/${app.id}?view=tools`);
        yield* browser.use("Run a tool with private input", (page) =>
          page
            .getByLabel("Message", { exact: true })
            .fill("PRIVATE_TOOL_INPUT")
            .then(() => page.getByRole("button", { name: "Run tool", exact: true }).click())
            .then(() => page.getByRole("region", { name: "Tool result" }).waitFor())
            .then(() => page.getByRole("region", { name: "Tool result" }).innerText())
            .then((result) => expect(result).toContain("PRIVATE_TOOL_RESULT")),
        );
        yield* recordedAfter(snapshots().length);
        yield* browser.checkpoint("tool-result-live");
        const toolError = yield* browser.use("Run a failing tool", (page) =>
          page
            .getByLabel("Message", { exact: true })
            .fill("PRIVATE_TOOL_FAILURE")
            .then(() => page.getByRole("button", { name: "Run tool", exact: true }).click())
            .then(() => page.getByRole("alert").innerText()),
        );
        yield* recordedAfter(snapshots().length);
        yield* browser.checkpoint("tool-error-live");
        yield* open(`/account/tokens?organization=${actors.organization.slug}`);
        yield* browser.use("Wait for excluded tokens page", (page) =>
          page.getByRole("heading", { name: "Tokens", exact: true }).waitFor(),
        );
        yield* browser.use("Insert a sentinel on the excluded tokens page", (page) =>
          page.evaluate(() => document.body.append("PRIVATE_API_KEY_PAGE")),
        );
        yield* open(`${dashboard}?private=PRIVATE_QUERY`);
        yield* appsReady();
        yield* open(dashboard);
        yield* appsReady();
        const returning = snapshots().length;
        yield* interact();
        yield* recordedAfter(returning);
        expect(capture.failures).toEqual([]);
        const recorded = JSON.stringify(snapshots());
        expect(toolError.length).toBeGreaterThan(0);
        for (const privateValue of [
          toolError,
          "PRIVATE_INPUT",
          "PRIVATE_TEXTAREA",
          "PRIVATE_TOOL_INPUT",
          "PRIVATE_TOOL_RESULT",
          "PRIVATE_TOOL_FAILURE",
          "PRIVATE_ATTRIBUTE",
          "PRIVATE_DATA",
          "PRIVATE_STYLE",
          "PRIVATE_TEXT",
          "PRIVATE_SECRET",
          "PRIVATE_PRODUCT",
          "PRIVATE_PASSWORD",
          "PRIVATE_TOKEN",
          "9876543210123",
          "PRIVATE_JSON",
          "PRIVATE_FRAME_PASSWORD",
          "PRIVATE_FRAME_SECRET",
          "PRIVATE_CONSOLE",
          "PRIVATE_QUERY",
          "PRIVATE_API_KEY_PAGE",
        ])
          expect(recorded).not.toContain(privateValue);
        for (const visibleValue of [
          "VISIBLE_ATTRIBUTE",
          "VISIBLE_TEXT",
          "VISIBLE_LINK",
          "VISIBLE_CODE",
          "VISIBLE_FRAME",
        ])
          expect(recorded).toContain(visibleValue);
        expect(recorded).toContain("$snapshot_data");
        expect(recorded).toContain('"type":2');
        yield* browser.use("Clear signed-in session", (page) => page.context().clearCookies());
        yield* open("/login?redirect=%2Forg%2Fprivate%2Fapps");
        yield* browser.use("Wait for sign-in", (page) =>
          page.getByRole("heading", { name: /sign in/i }).waitFor(),
        );
        const signedOut = snapshots().length;
        yield* browser.use("Enter private sign-in value", (page) =>
          page.getByRole("textbox").first().fill("PRIVATE_LOGIN@example.test"),
        );
        yield* open("/home");
        expect(snapshots()).toHaveLength(signedOut);
        yield* browser.use("Render captured dashboard replay", (page) =>
          renderBrowserReplay(page, initialReplay),
        );
        const replayLayout = yield* browser.use("Read replay layout", (page) =>
          page
            .frameLocator("iframe")
            .locator(".shell")
            .evaluate((element) => ({
              display: getComputedStyle(element).display,
              columns: getComputedStyle(element).gridTemplateColumns,
              background: getComputedStyle(element.ownerDocument.body).backgroundColor,
              linkedStyle: getComputedStyle(element).getPropertyValue("--replay-stylesheet-probe"),
              top: element.getBoundingClientRect().top,
            })),
        );
        yield* browser.use("Check that replay navigation is readable", (page) =>
          page
            .frameLocator("iframe")
            .getByRole("heading", { name: /^Apps(?:\s*\d+)?$/ })
            .waitFor(),
        );
        yield* browser.checkpoint("readable-dashboard-replay");
        expect(replayLayout).toEqual(liveLayout);
        yield* browser.use("Render captured field updates", (page) =>
          renderBrowserReplay(page, fieldsReplay),
        );
        yield* browser.use("Check readable content and masked input values in playback", (page) => {
          const replay = page.frameLocator("iframe");
          return replay
            .locator("#replay-fields")
            .innerText()
            .then((text) => expect(text).toContain("VISIBLE_TEXT"))
            .then(() => replay.getByRole("textbox", { name: "Replay account name" }).inputValue())
            .then((value) => expect(value).toMatch(/^\*+$/))
            .then(() => replay.locator("#replay-fields").innerHTML())
            .then((html) => expect(html).not.toContain("PRIVATE_"));
        });
      }),
    ),
  );

  it.effect(scenarios.productAnalyticsOnboarding.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          onboarding = yield* Onboarding,
          evidence = yield* Evidence,
          target = yield* Target;
        expect(target.metadata.mode).toBe("managed");
        const capture = yield* browser.use(
          "Intercept synthetic analytics",
          captureBrowserAnalytics,
        );
        yield* Effect.addFinalizer(() =>
          evidence.json("onboarding-analytics.json", capture).pipe(Effect.orDie),
        );
        const snapshots = () => capture.events.filter(isSnapshot);
        const recorded = (from = 0) => JSON.stringify(snapshots().slice(from));
        // Moving the pointer adds replay events without pressing any control on the page.
        const recordedAfter = (count: number) =>
          browser.use("Wait for real snapshot transport", (page) => {
            let step = 0;
            return expect
              .poll(
                () =>
                  page.mouse
                    .move(4 + (step++ % 2) * 6, 4 + (step % 3) * 6)
                    .then(() => snapshots().length),
                { timeout: 30000 },
              )
              .toBeGreaterThan(count);
          });
        const open = (url: string, heading: string) =>
          browser.use(`Open ${heading}`, (page) =>
            page
              .goto(url)
              .then(() => page.getByRole("heading", { name: heading, exact: true }).waitFor()),
          );
        /**
         * Mark a page that must not record, once it has hydrated and handled its URL, after
         * checking it is still the page that was opened. The OAuth callback removes its query.
         */
        const markExcluded = (url: string, sentinel: string) =>
          Effect.gen(function* () {
            const path = url.split("?")[0];
            yield* browser.use(`Open excluded ${path}`, (page) => page.goto(url));
            const opened = yield* browser.use(`Mark excluded ${path}`, (page) =>
              page.evaluate((sentinel) => {
                document.body.append(sentinel);
                return location.pathname;
              }, sentinel),
            );
            expect(opened).toBe(path);
          });

        yield* onboarding.emailSignIn(yield* onboarding.freshEmail);
        yield* browser.use("Decline passkey enrollment when it is offered", (page) => {
          const decline = page.getByRole("button", { name: "Not now", exact: true });
          return decline
            .or(page.getByLabel("Team name", { exact: true }))
            .first()
            .waitFor()
            .then(() => decline.count())
            .then((offered) => (offered > 0 ? decline.click() : undefined));
        });
        yield* browser.use("Team creation is open", (page) =>
          page
            .getByLabel("Team name", { exact: true })
            .waitFor()
            .then(() => expect(new URL(page.url()).pathname).toBe("/create")),
        );
        const suggested = yield* browser.use("Read the suggested team name", (page) =>
          page.getByLabel("Team name", { exact: true }).inputValue(),
        );
        expect(suggested.length).toBeGreaterThan(1);
        yield* recordedAfter(0);
        const teamName = `Replay team ${crypto.randomUUID().slice(0, 8)}`;
        yield* browser.use("Type the team name", (page) =>
          page.getByLabel("Team name", { exact: true }).fill(teamName),
        );
        yield* recordedAfter(snapshots().length);
        const creation = recorded();
        expect(creation).toContain("Create your team");
        expect(creation).not.toContain(suggested);
        expect(creation).not.toContain(teamName);
        const created = snapshots().length;

        yield* browser.use("Create the team", (page) =>
          page
            .getByRole("button", { name: "Continue", exact: true })
            .click()
            .then(() =>
              page.waitForURL((url) => /^\/org\/[^/]+\/setup\/accounts$/u.test(url.pathname)),
            )
            .then(() =>
              page.getByRole("heading", { name: "Connect your accounts", exact: true }).waitFor(),
            ),
        );
        const setup = yield* browser.use("Read the setup path", (page) =>
          Promise.resolve(new URL(page.url()).pathname.replace(/\/accounts$/u, "")),
        );
        yield* recordedAfter(created);
        expect(recorded(created)).toContain("Connect your accounts");
        const accounts = snapshots().length;
        yield* browser.use("Insert setup content and synthetic secrets", (page) =>
          page.evaluate(() => {
            const region = document.createElement("section");
            region.innerHTML =
              '<div>VISIBLE_SETUP_TEXT</div><form><label>Account label<input value="PRIVATE_SETUP_INPUT"></label><label>API token<input type="password" value="PRIVATE_SETUP_TOKEN"></label><label>Client secret<input type="password" data-private value="PRIVATE_SETUP_CLIENT_SECRET"></label></form><div data-private>PRIVATE_SETUP_SECRET</div>';
            document.body.append(region);
          }),
        );
        yield* recordedAfter(accounts);
        yield* browser.use("Wait for the inserted setup content", () =>
          expect.poll(() => recorded(accounts), { timeout: 30000 }).toContain("VISIBLE_SETUP_TEXT"),
        );

        const guide = snapshots().length;
        yield* open(`${setup}/assistant?assistant=claude`, "Add Executor to Claude");
        yield* recordedAfter(guide);
        expect(recorded(guide)).toContain("Add Executor to");

        yield* markExcluded(
          `${setup}/accounts?code=PRIVATE_OAUTH_CODE&state=PRIVATE_OAUTH_STATE`,
          "PRIVATE_SETUP_OAUTH_RETURN",
        );
        yield* markExcluded(
          `${setup}/assistant?assistant=claude&private=PRIVATE_QUERY`,
          "PRIVATE_SETUP_UNKNOWN_QUERY",
        );
        yield* markExcluded(
          "/oauth/callback?code=PRIVATE_OAUTH_CODE&state=PRIVATE_OAUTH_STATE",
          "PRIVATE_OAUTH_CALLBACK",
        );
        yield* markExcluded(
          "/mcp/authorize?client_id=replay-client&state=PRIVATE_MCP_STATE",
          "PRIVATE_MCP_CONSENT",
        );
        const returning = snapshots().length;
        yield* open(`${setup}/assistant`, "Connect your assistant");
        yield* recordedAfter(returning);
        expect(recorded(returning)).toContain("Connect your assistant");

        expect(capture.failures).toEqual([]);
        const all = recorded();
        for (const privateValue of [
          "PRIVATE_SETUP_INPUT",
          "PRIVATE_SETUP_TOKEN",
          "PRIVATE_SETUP_CLIENT_SECRET",
          "PRIVATE_SETUP_SECRET",
          "PRIVATE_OAUTH_CODE",
          "PRIVATE_OAUTH_STATE",
          "PRIVATE_QUERY",
          "PRIVATE_MCP_STATE",
          "PRIVATE_SETUP_OAUTH_RETURN",
          "PRIVATE_SETUP_UNKNOWN_QUERY",
          "PRIVATE_OAUTH_CALLBACK",
          "PRIVATE_MCP_CONSENT",
        ])
          expect(all).not.toContain(privateValue);
        expect(all).toContain("VISIBLE_SETUP_TEXT");
      }).pipe(Effect.provide(Onboarding.layer)),
    ),
  );
});
