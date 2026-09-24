import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Schema, Schedule } from "effect";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Evidence } from "../support/evidence.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { captureBrowserAnalytics, renderBrowserReplay } from "../support/product-analytics.ts";

const Event = Schema.Struct({
  event: Schema.String,
  distinct_id: Schema.optional(Schema.String),
  properties: Schema.Record(Schema.String, Schema.Json),
});
const Batch = Schema.Struct({ batch: Schema.Array(Event) });
const readEvents = (text: string) =>
  text
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => Schema.decodeUnknownSync(Schema.fromJsonString(Batch))(line).batch);

layer(HostedLive, { excludeTestServices: true })("Product analytics", (it) => {
  it.effect(scenarios.productAnalytics.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          browser = yield* Browser,
          target = yield* Target,
          fs = yield* FileSystem.FileSystem;
        expect(target.metadata.mode).toBe("managed");
        const actor = yield* body(
          Schema.Struct({ user: Schema.Struct({ id: Schema.String }) }),
          yield* api.request(actors.owner, "GET", "/api/auth/get-session"),
        );
        const before = readEvents(
          yield* fs.readFileString(`${target.directory}/analytics.ndjson`),
        ).length;
        const response = yield* api.request(
          actors.owner,
          "GET",
          `/api/organizations/${actors.organization.id}/inventory`,
        );
        expect(response.status).toBe(200);
        const events = yield* fs.readFileString(`${target.directory}/analytics.ndjson`).pipe(
          Effect.map((text) => readEvents(text).slice(before)),
          Effect.repeat({
            schedule: Schedule.spaced("100 millis"),
            until: (events) =>
              events.some(
                (event) =>
                  event.event === "product_operation_completed" &&
                  event.properties.operation === "inventory",
              ),
          }),
          Effect.timeout("10 seconds"),
        );
        const completed = events.filter(
          (event) =>
            event.event === "product_operation_completed" &&
            event.properties.operation === "inventory",
        );
        expect(completed).toHaveLength(1);
        expect(completed[0]).toMatchObject({
          distinct_id: actor.user.id,
          properties: {
            source: "dashboard",
            area: "organization",
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
        const snapshots = () =>
          capture.events.filter(
            (event) =>
              event !== null &&
              typeof event === "object" &&
              !Array.isArray(event) &&
              "event" in event &&
              event.event === "$snapshot",
          );
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
              '<div title="VISIBLE_ATTRIBUTE">VISIBLE_TEXT</div><a href="/visible-link">VISIBLE_LINK</a><form><label>Account name<input aria-label="Replay account name" value="VISIBLE_INPUT"></label><label>Password<input aria-label="Replay password" type="password" value="PRIVATE_PASSWORD"></label><label>Token<input aria-label="Replay token" type="password" data-private value="PRIVATE_TOKEN"></label><label>Numeric credential<input type="number" data-private value="9876543210123"></label><textarea data-private>PRIVATE_JSON</textarea></form><pre>VISIBLE_CODE</pre><div data-private title="PRIVATE_ATTRIBUTE" data-secret="PRIVATE_DATA" style="--secret:PRIVATE_STYLE">PRIVATE_TEXT<code>PRIVATE_SECRET</code></div><div data-product-private>PRIVATE_PRODUCT</div><iframe srcdoc="VISIBLE_FRAME<input type=&quot;password&quot; value=&quot;PRIVATE_FRAME_PASSWORD&quot;><span data-private>PRIVATE_FRAME_SECRET</span>"></iframe>';
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
              page.getByRole("textbox", { name: "Replay account name" }).fill("VISIBLE_EDIT"),
            ),
        );
        yield* browser.use("Wait for the readable input update", () =>
          expect
            .poll(() => JSON.stringify(snapshots()), { timeout: 30000 })
            .toContain("VISIBLE_EDIT"),
        );
        const fieldsReplay = [...snapshots()];
        yield* open(`/org/${actors.organization.slug}/api-keys`);
        yield* browser.use("Wait for excluded API keys page", (page) =>
          page.getByRole("heading", { name: "API keys", exact: true }).waitFor(),
        );
        yield* browser.use("Insert a sentinel on the excluded API keys page", (page) =>
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
        for (const privateValue of [
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
          "VISIBLE_INPUT",
          "VISIBLE_EDIT",
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
        yield* browser.use("Check ordinary content and input values in playback", (page) => {
          const replay = page.frameLocator("iframe");
          return replay
            .locator("#replay-fields")
            .innerText()
            .then((text) => expect(text).toContain("VISIBLE_TEXT"))
            .then(() => replay.getByRole("textbox", { name: "Replay account name" }).inputValue())
            .then((value) => expect(value).toBe("VISIBLE_EDIT"))
            .then(() => replay.locator("#replay-fields").innerHTML())
            .then((html) => expect(html).not.toContain("PRIVATE_"));
        });
      }),
    ),
  );
});
