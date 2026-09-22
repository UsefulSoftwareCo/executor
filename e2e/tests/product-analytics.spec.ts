import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Schema, Schedule } from "effect";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Evidence } from "../support/evidence.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { captureBrowserAnalytics } from "../support/product-analytics.ts";

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
    withCase(
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
            page.getByRole("heading", { name: "Apps", exact: true }).waitFor(),
          );
        const interact = () =>
          browser.use("Interact with dashboard", (page) => page.mouse.click(900, 350));
        const recordedAfter = (count: number) =>
          browser.use("Wait for real snapshot transport", (page) =>
            expect
              .poll(() => page.mouse.click(1400, 900).then(() => snapshots().length), {
                timeout: 30000,
              })
              .toBeGreaterThan(count),
          );
        yield* open(dashboard);
        yield* appsReady();
        yield* interact();
        yield* recordedAfter(0);
        const first = snapshots().length;
        yield* browser.use("Insert synthetic private values", (page) =>
          page.evaluate(() => {
            const region = document.createElement("section");
            region.innerHTML =
              '<div title="PRIVATE_ATTRIBUTE" data-secret="PRIVATE_DATA">PRIVATE_TEXT</div><input value="PRIVATE_INPUT"><form>PRIVATE_FORM</form><pre>PRIVATE_SOURCE</pre><iframe srcdoc="PRIVATE_FRAME"></iframe>';
            document.body.append(region);
            console.log("PRIVATE_CONSOLE");
          }),
        );
        yield* interact();
        yield* recordedAfter(first);
        yield* open(`/org/${actors.organization.slug}/api-keys`);
        yield* browser.use("Wait for excluded API keys page", (page) =>
          page.getByRole("heading", { name: "API keys", exact: true }).waitFor(),
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
          "PRIVATE_TEXT",
          "PRIVATE_INPUT",
          "PRIVATE_FORM",
          "PRIVATE_SOURCE",
          "PRIVATE_FRAME",
          "PRIVATE_CONSOLE",
          "PRIVATE_QUERY",
          "/api-keys",
        ])
          expect(recorded).not.toContain(privateValue);
        expect(recorded).toContain("$snapshot_data");
        expect(recorded).toContain('"type":2');
        expect(recorded).toContain("***");
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
      }),
    ),
  );
});
