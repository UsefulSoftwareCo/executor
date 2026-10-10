/**
 * The dashboard sends the reads a page starts together as one batch. Each read names an endpoint
 * of the host's API, and the host answers it with that endpoint's own handler, middleware and
 * schemas under the batch request's identity, streaming each answer as it finishes.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { openInApp, openThroughBrowser } from "../support/in-app-navigation.ts";
import { appsManifest } from "../support/apps-release.ts";
import { batchedReads, batchPath } from "../support/read-batches.ts";
import { Evidence } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

const Viewer = Schema.Struct({ userId: Schema.String });
const App = Schema.Struct({ id: Schema.String });

/** One read in a batch, with the URL the same read has as the page's own request. */
interface Read {
  readonly group: string;
  readonly endpoint: string;
  readonly params?: Record<string, string>;
  readonly path: string;
  /** Anything else a read could try to carry. A batch ignores it. */
  readonly extra?: Record<string, unknown>;
}

/** What one read answers, and when its answer arrived after the batch was sent. */
interface Answer {
  readonly status: number;
  readonly body: string;
  readonly at?: number;
}

/**
 * Send `reads` as one batch from the page, reading each answer as it streams in, and each read
 * also as the page's own request.
 */
const batchFromPage = (reads: ReadonlyArray<Read>) =>
  Effect.flatMap(Browser, (browser) =>
    browser.use("Send the reads as one batch and as the page's own requests", (page) =>
      page.evaluate(
        ({ reads, batchPath }) => {
          const started = performance.now();
          const batched: Array<Answer | null> = reads.map(() => null);
          const decoder = new TextDecoder();
          let buffered = "";
          const receive = (text: string) => {
            buffered += text;
            const lines = buffered.split("\n");
            buffered = lines.pop() ?? "";
            for (const line of lines.filter((line) => line !== "")) {
              const answer = JSON.parse(line);
              batched[answer.id] = {
                status: answer.status,
                body: answer.text ?? "",
                at: performance.now() - started,
              };
            }
          };
          const drain = (
            reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
          ): Promise<void> =>
            reader === undefined
              ? Promise.resolve()
              : reader.read().then((chunk) => {
                  if (chunk.done) return;
                  receive(decoder.decode(chunk.value, { stream: true }));
                  return drain(reader);
                });
          return fetch(batchPath, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              reads: reads.map((read, id) => ({
                ...read.extra,
                id,
                group: read.group,
                endpoint: read.endpoint,
                params: read.params ?? {},
                query: {},
              })),
            }),
          }).then((response) =>
            drain(response.body?.getReader())
              .then(() =>
                Promise.all(
                  reads.map((read) =>
                    fetch(read.path).then((own) =>
                      own.text().then((body): Answer => ({ status: own.status, body })),
                    ),
                  ),
                ),
              )
              .then((direct) => ({ status: response.status, batched, direct })),
          );
        },
        { reads, batchPath },
      ),
    ),
  );

/** The answers without their arrival times, to compare with the page's own requests. */
const contents = (answers: ReadonlyArray<Answer | null>) =>
  answers.map((answer) => (answer === null ? null : { status: answer.status, body: answer.body }));

const deploy = (name: string, factory: string) =>
  Effect.gen(function* () {
    const actors = yield* Actors;
    const api = yield* Api;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name,
      files: [
        {
          path: "index.ts",
          content: `import { defineApp, query, object, router } from "apps";
export default defineApp({ accounts: {} }, async () => {
  ${factory}
  return { tools: router({ status: query({ description: "Status", input: object({}) }, async () => "ready") }) };
});`,
        },
        appsManifest,
      ],
    });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    const app = yield* body(App, deployed);
    yield* Effect.addFinalizer(() =>
      api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
    );
    return app;
  });

layer(HostedLive, { excludeTestServices: true })("Dashboard read batches", (it) => {
  it.effect(scenarios.dashboardReadBatches.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const api = yield* Api;
        const browser = yield* Browser;
        const organization = actors.organization.id;
        const prefix = `/api/organizations/${organization}`;
        const member = yield* body(Viewer, yield* api.request(actors.member, "GET", "/api/viewer"));
        const app = yield* deploy("Batched reads", "");
        // Its first evaluation takes two seconds.
        const slow = yield* deploy(
          "Slow batched read",
          "await new Promise((resolve) => setTimeout(resolve, 2000));",
        );
        const viewer: Read = { group: "viewer", endpoint: "get", path: "/api/viewer" };
        const source: Read = {
          group: "apps",
          endpoint: "source",
          params: { organization, app: app.id },
          path: `${prefix}/apps/${app.id}/source`,
        };

        // Signed out, a batch reads nothing a signed-out request could not.
        yield* browser.use("Open the product signed out", (page) => page.goto("/"));
        const signedOut = yield* batchFromPage([viewer, source]);
        expect(signedOut.status).toBe(200);
        expect(contents(signedOut.batched)).toEqual(signedOut.direct);
        expect(signedOut.direct.every((answer) => answer.status !== 200)).toBe(true);

        yield* browser.login(actors.member);
        yield* browser.use("Open the organization's apps", (page) =>
          page.goto(`/org/${actors.organization.slug}`),
        );
        // A member reads its own identity. The app source is for administrators: that read is
        // refused by its own middleware, with the endpoint's own error.
        const answered = yield* batchFromPage([viewer, source]);
        expect(answered.status).toBe(200);
        expect(contents(answered.batched)).toEqual(answered.direct);
        expect(answered.direct.map((answer) => answer.status)).toEqual([200, 403]);
        expect(JSON.parse(answered.direct[0]?.body ?? "null")).toMatchObject({
          userId: member.userId,
        });
        expect(JSON.parse(answered.direct[1]?.body ?? "null")).toHaveProperty("_tag");

        // A read cannot name another session, client address or method.
        const forged = yield* batchFromPage(
          [viewer, source].map((read) => ({
            ...read,
            extra: {
              headers: [["cookie", "better-auth.session_token=forged"]],
              cookie: "better-auth.session_token=forged",
              "x-forwarded-for": "203.0.113.7",
              method: "POST",
            },
          })),
        );
        expect(contents(forged.batched)).toEqual(answered.direct);

        // Only reads of the API travel in a batch: writes and unknown endpoints refuse it whole.
        const refuse = (reads: ReadonlyArray<unknown>) =>
          browser.use("Send a batch the dashboard never sends", (page) =>
            page.evaluate(
              ({ reads, batchPath }) =>
                fetch(batchPath, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ reads }),
                }).then((response) => response.status),
              { reads, batchPath },
            ),
          );
        const read = (group: string, endpoint: string, params = {}) => ({
          id: 0,
          group,
          endpoint,
          params,
          query: {},
        });
        expect(yield* refuse([read("apps", "deploy", { organization })])).toBe(400);
        expect(yield* refuse([read("viewer", "missing")])).toBe(400);
        expect(yield* refuse([read("viewer", "get"), read("auth", "session")])).toBe(400);
        expect(yield* refuse([])).toBe(400);

        // Another site cannot send a batch with the member's cookies.
        const crossSite = yield* api.request(
          actors.member,
          "POST",
          batchPath,
          { reads: [read("viewer", "get")] },
          { origin: "https://attacker.example" },
        );
        expect(crossSite.status).toBe(403);

        // A slow read does not hold back the others: each answer streams as it finishes.
        yield* browser.login(actors.owner);
        yield* browser.use("Open the organization's apps", (page) =>
          page.goto(`/org/${actors.organization.slug}`),
        );
        const index: Read = {
          group: "tools",
          endpoint: "index",
          params: { organization, app: slow.id },
          path: `${prefix}/apps/${slow.id}/tools/index`,
        };
        const streamed = yield* batchFromPage([index, viewer]);
        const [slowAnswer, fastAnswer] = streamed.batched;
        expect(slowAnswer?.status, slowAnswer?.body).toBe(200);
        expect(fastAnswer?.status).toBe(200);
        expect((slowAnswer?.at ?? 0) - (fastAnswer?.at ?? Infinity)).toBeGreaterThan(1000);

        // Opening an app inside the running dashboard sends its reads in batches.
        let sent = 0;
        yield* browser.use("Count the page's batches", (page) => {
          page.on("request", (request) => {
            if (new URL(request.url()).pathname === batchPath) sent += 1;
          });
          return Promise.resolve();
        });
        yield* openThroughBrowser(
          "Open the app",
          `/org/${actors.organization.slug}/apps/${app.id}`,
        );
        yield* browser.use("Wait for the app's reads", (page) =>
          page.waitForLoadState("networkidle"),
        );
        expect(sent).toBeGreaterThan(0);

        // A batch reply that ends early fails every read it did not answer, as a lost request
        // fails, instead of leaving it waiting.
        let unanswered = 0;
        yield* browser.use("Cut each batch reply off after its first answer", (page) =>
          page.route(
            (url) => url.pathname === batchPath,
            (route) =>
              route.fetch().then((response) =>
                response.text().then((text) => {
                  const lines = text.split("\n").filter((line) => line !== "");
                  unanswered += batchedReads(route.request().postData()).length - 1;
                  return route.fulfill({ response, body: `${lines[0] ?? ""}\n` });
                }),
              ),
          ),
        );
        yield* browser.use("Open a page that does not read the app", (page) =>
          page.goto(`/org/${actors.organization.slug}/connect`),
        );
        yield* browser.use("Record the dashboard's failed reads", (page) =>
          page.evaluate(() => {
            const failures: Array<string> = [];
            Object.assign(window, { batchFailures: failures });
            window.addEventListener("executor:operation-failed", (event) => {
              if (event instanceof CustomEvent) failures.push(String(event.detail.error_type));
            });
          }),
        );
        yield* openInApp("Open the other app", `/org/${actors.organization.slug}/apps/${slow.id}`);
        yield* browser.use("Wait for the unanswered reads to fail", (page) =>
          page.waitForFunction(
            () => {
              const failures: unknown = Reflect.get(window, "batchFailures");
              return Array.isArray(failures) && failures.length > 0;
            },
            undefined,
            { timeout: 15_000 },
          ),
        );
        const failures = yield* browser.use("Read the failed reads", (page) =>
          page.evaluate((): unknown => Reflect.get(window, "batchFailures")),
        );
        expect(unanswered).toBeGreaterThan(0);
        expect(failures).toContain("BrowserTransportFailed");
      }),
    ),
  );

  it.effect(scenarios.dashboardBuildChange.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const browser = yield* Browser;
        const target = yield* Target;
        const evidence = yield* Evidence;
        const app = yield* deploy("Upgraded reads", "");
        const upgrade = `${target.metadata.commit}-next`;
        const servedBuild = () =>
          browser.use("Read the build that served the page", (page) =>
            page.evaluate(
              () =>
                performance
                  .getEntriesByType("navigation")
                  .flatMap((entry) =>
                    entry instanceof PerformanceNavigationTiming ? entry.serverTiming : [],
                  )
                  .find((metric) => metric.name === "executor-build")?.description,
            ),
          );
        const updated = "Executor was updated. Reload this page to use the new version.";

        yield* browser.login(actors.owner);
        yield* browser.use("Open the organization's apps", (page) =>
          page.goto(`/org/${actors.organization.slug}`),
        );
        expect(yield* servedBuild()).toBe(target.metadata.commit);

        // The operator upgrades the server while the tab stays open.
        yield* serverControl("stop");
        yield* serverControl("environment", 200, { EXECUTOR_BUILD_VERSION: upgrade });
        yield* serverControl("start");

        // The tab's batches name endpoints the new server no longer has, so it refuses them.
        yield* browser.use("Send the previous build's batches", (page) =>
          page.route(
            (url) => url.pathname === batchPath,
            (route) =>
              route.continue({
                postData: JSON.stringify({
                  reads: batchedReads(route.request().postData()).map((read) => ({
                    ...read,
                    endpoint: `${read.endpoint}FromPreviousBuild`,
                  })),
                }),
              }),
          ),
        );
        yield* openInApp("Open the app", `/org/${actors.organization.slug}/apps/${app.id}`);
        yield* browser.use("Wait for the reload notice", (page) =>
          page
            .getByRole("status")
            .filter({ hasText: "Executor was updated" })
            .getByRole("button", { name: "Reload" })
            .waitFor(),
        );
        // A refused read explains the update instead of reporting an unreachable server.
        yield* browser.use("Wait for the refused read's explanation", (page) =>
          page.getByText(updated).first().waitFor(),
        );
        expect(
          yield* browser.use("Count unreachable-server messages", (page) =>
            page.getByText("Could not reach the server").count(),
          ),
        ).toBe(0);
        yield* evidence.attach(
          "build-change.png",
          "image/png",
          yield* browser.use("Capture the reload notice", (page) => page.screenshot()),
        );

        // Reloading loads the new build, which reads normally.
        yield* browser.use("Reload from the notice", (page) =>
          page
            .unroute((url) => url.pathname === batchPath)
            .then(() =>
              Promise.all([
                page.waitForEvent("load"),
                page
                  .getByRole("status")
                  .filter({ hasText: "Executor was updated" })
                  .getByRole("button", { name: "Reload" })
                  .click(),
              ]),
            ),
        );
        expect(yield* servedBuild()).toBe(upgrade);
        yield* openInApp("Open the organization's apps", `/org/${actors.organization.slug}`);
        yield* openInApp("Open the app again", `/org/${actors.organization.slug}/apps/${app.id}`);
        yield* browser.use("Wait for the app's reads", (page) =>
          page.waitForLoadState("networkidle"),
        );
        const after = yield* browser.use("Count update messages after the reload", (page) =>
          Promise.all([
            page.getByText("Executor was updated").count(),
            page.getByText("Unable to complete this request").count(),
          ]),
        );
        expect(after).toEqual([0, 0]);
      }),
    ),
  );
});
