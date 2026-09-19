// Cross-target (browser): the health-probe churn loop seen in production.
//
// Production symptom (2026-09-18): one signed-in browser with many
// non-healthy or never-checked connections spread across many integrations
// sent hundreds of `/api/connections/.../health` POSTs and `/api/connections`
// GETs per minute for as long as the dashboard stayed open. Most were
// interrupted client-side before completing (the shared health mutation atom
// cancels the previous in-flight call), but hundreds per minute still reached
// the server and the upstreams. The server annotated every verdict as
// unchanged, so the loop lives in the client.
//
// The existing verdict scenario pins "one broken connection probes exactly
// once per surface". This one reproduces the production SHAPE: many
// connections, several integrations, a mix of verdicts (`unknown` from a
// connection with no probe configured, `degraded` from an upstream that
// answers 401), and the page journey a user actually makes (integrations
// list → integration page → integrations list). It then watches a quiet
// window. A settled page must stop asking. A count that keeps climbing is the
// loop.
//
// Skips on targets with no browser surface.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { HttpApiClient } from "effect/unstable/httpapi";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

const api = composePluginApi([openApiHttpPlugin()] as const);
type Client = HttpApiClient.ForApi<typeof api>;

const TEMPLATE = AuthTemplateSlug.make("apiKey");

/** Integrations whose connection has a probe configured and an upstream that
 *  rejects the key: the probe persists `degraded`. */
const DEGRADED_COUNT = 4;
/** Integrations whose connection has NO probe configured: every automatic
 *  check answers `unknown` with a fresh `checkedAt`. */
const UNKNOWN_COUNT = 4;

/** How long a settled page is watched for further probes. Production cycled
 *  every 0.5-1s, so a loop shows up well inside this. */
const QUIET_WINDOW_MS = 10_000;

const unique = (prefix: string) => `${prefix}${randomBytes(3).toString("hex")}`;

/** Upstream on 127.0.0.1 whose `GET /me` rejects every key. */
const serveRejectingUpstream = () =>
  Effect.acquireRelease(
    Effect.callback<{ readonly url: string; readonly close: () => void }>((resume) => {
      const server = createServer((request, response) => {
        if (request.method === "GET" && (request.url ?? "").startsWith("/me")) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid_token" }));
          return;
        }
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${port}`,
            close: () => {
              server.close();
              server.closeAllConnections();
            },
          }),
        );
      });
    }),
    (server) => Effect.sync(server.close),
  );

const identitySpec = (baseUrl: string, title: string): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title, version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/me": {
        get: {
          operationId: "getMe",
          summary: "The current account",
          responses: {
            "200": {
              description: "The authenticated account",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { email: { type: "string" } } },
                },
              },
            },
          },
        },
      },
    },
  });

/** One OpenAPI integration with one saved org connection. With `probe`, the
 *  identity GET is configured as the health check. */
const seedIntegration = (
  client: Client,
  upstreamUrl: string,
  options: { readonly prefix: string; readonly probe: boolean },
) =>
  Effect.gen(function* () {
    const slug = IntegrationSlug.make(unique(options.prefix));
    const name = ConnectionName.make(`${options.prefix}conn`);

    yield* Effect.addFinalizer(() =>
      Effect.all(
        [
          client.connections
            .remove({ params: { owner: "org", integration: slug, name } })
            .pipe(Effect.ignore),
          client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore),
        ],
        { discard: true },
      ),
    );

    yield* client.openapi.addSpec({
      payload: {
        spec: { kind: "blob", value: identitySpec(upstreamUrl, `Churn ${slug}`) },
        slug,
        baseUrl: upstreamUrl,
        authenticationTemplate: [
          {
            slug: "apiKey",
            type: "apiKey",
            headers: { authorization: ["Bearer ", { type: "variable", name: "token" }] },
          },
        ],
      },
    });

    if (options.probe) {
      const candidates = yield* client.integrations.healthCheckCandidates({ params: { slug } });
      const getMe = candidates.find((candidate) => candidate.method === "get");
      if (!getMe) return yield* Effect.die("identity spec exposed no GET candidate");
      yield* client.integrations.healthCheckSet({
        params: { slug },
        payload: { spec: { operation: getMe.operation, identityField: "email" } },
      });
    }

    yield* client.connections.create({
      payload: { owner: "org", name, integration: slug, template: TEMPLATE, value: "bad-key" },
    });

    return { slug, name };
  });

scenario(
  "Health checks (UI) · many broken connections across many integrations settle instead of looping",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const upstream = yield* serveRejectingUpstream();

      const degraded = yield* Effect.all(
        Array.from({ length: DEGRADED_COUNT }, () =>
          seedIntegration(client, upstream.url, { prefix: "churndeg", probe: true }),
        ),
        { concurrency: 2 },
      );
      const unknown = yield* Effect.all(
        Array.from({ length: UNKNOWN_COUNT }, () =>
          seedIntegration(client, upstream.url, { prefix: "churnunk", probe: false }),
        ),
        { concurrency: 2 },
      );
      const seeded = [...degraded, ...unknown];
      const connectionCount = seeded.length;

      // Persist a verdict on every connection BEFORE the browser opens, the
      // way a returning user finds them: `degraded` on the probed ones,
      // `unknown` on the rest. The list then renders each row with a
      // persisted verdict, and every automatic revalidation compares its
      // result against one.
      for (const { slug, name } of seeded) {
        yield* client.connections.checkHealth({
          params: { owner: "org", integration: slug, name },
          query: {},
        });
      }

      yield* browser.session(identity, async ({ page, step }) => {
        // The client's wire contract, observed from outside: every health POST
        // and every connections-list GET the app sends, plus how many the
        // browser reports as failed (an aborted request shows up here as a
        // failure, which is how the interrupted mutation atom looks on the wire).
        const health: string[] = [];
        const lists: string[] = [];
        let aborted = 0;
        const isHealth = (method: string, url: string) =>
          method === "POST" && url.includes("/api/connections/") && url.includes("/health");
        const isList = (method: string, url: string) =>
          method === "GET" && /\/api\/connections(\?|$)/.test(url);
        page.on("request", (request) => {
          const url = request.url();
          if (isHealth(request.method(), url)) health.push(url);
          else if (isList(request.method(), url)) lists.push(url);
        });
        page.on("requestfailed", (request) => {
          const url = request.url();
          if (isHealth(request.method(), url) || isList(request.method(), url)) aborted += 1;
        });

        const snapshot = (label: string) => {
          const line = `[churn] ${label}: health=${String(health.length)} lists=${String(lists.length)} aborted=${String(aborted)}`;
          console.log(line);
          return { health: health.length, lists: lists.length, aborted };
        };

        await step("Open the integrations list with every broken connection on it", async () => {
          await visit(page, "/");
          for (const { slug } of seeded) {
            await page
              .getByRole("link", { name: new RegExp(slug, "i") })
              .first()
              .waitFor({
                timeout: 30_000,
              });
          }
          // Let the automatic revalidation land for every row.
          await page.waitForTimeout(3_000);
        });
        const afterList = snapshot("after integrations list");

        await step("Open one integration page, then return to the list", async () => {
          await visit(page, `/integrations/${degraded[0]!.slug}`);
          await page.waitForTimeout(2_000);
          await visit(page, "/");
          await page.waitForTimeout(3_000);
        });
        const afterJourney = snapshot("after journey");

        // The quiet window: nothing changed on the page, nothing changed on
        // the server, so nothing more should be asked.
        await step("Leave the settled list open and watch the wire", async () => {
          await page.waitForTimeout(QUIET_WINDOW_MS);
        });
        const afterQuiet = snapshot("after quiet window");

        const quietHealth = afterQuiet.health - afterJourney.health;
        const quietLists = afterQuiet.lists - afterJourney.lists;
        console.log(
          `[churn] quiet window (${String(QUIET_WINDOW_MS)}ms): +${String(quietHealth)} health, +${String(quietLists)} list fetches over ${String(connectionCount)} connections`,
        );

        // One list mount revalidates each non-healthy connection once, and
        // reads the connections list once per owner (plus the unscoped read).
        // A probe count above the connection count means rows are being
        // re-probed; a list count above three means verdicts are being
        // treated as changes and refetching the list.
        expect(
          afterList.health,
          `the first list mount probes each broken connection at most once (sent ${String(afterList.health)} for ${String(connectionCount)} connections)`,
        ).toBeLessThanOrEqual(connectionCount);
        expect(
          afterList.lists,
          `the first list mount reads the connections list at most once per owner (sent ${String(afterList.lists)})`,
        ).toBeLessThanOrEqual(3);

        // THE production symptom: a settled page keeps asking. Zero is the
        // contract; anything else is the loop.
        expect(quietHealth, "a settled integrations list sends no further health probes").toBe(0);
        expect(
          quietLists,
          "a settled integrations list does not refetch the connections list",
        ).toBe(0);
      });
    }),
  ),
);
