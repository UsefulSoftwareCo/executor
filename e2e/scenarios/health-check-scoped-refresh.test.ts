// Cross-target (browser): manual connection health checks must update only the
// row that was checked. A broad refresh used to refetch sibling account rows,
// letting unrelated persisted identity changes appear as collateral.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { HttpApiClient } from "effect/unstable/httpapi";
import type { Locator, Page } from "playwright";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);
type Client = HttpApiClient.ForApi<typeof api>;

const TEMPLATE = AuthTemplateSlug.make("apiKey");
const ALICE = "alice@example.com";
const ALICE_REFRESHED = "alice.refreshed@example.com";
const BOB = "bob@example.com";
const BOB_REFRESHED = "BOB-SHOULD-NEVER-APPEAR@example.com";
const WATCHER_KEY = "__executorHealthScopedRefreshWatcher";

type RowTitleSample = {
  readonly atMs: number;
  readonly title: string;
};

type WatcherState = {
  readonly done: boolean;
  readonly samples: readonly RowTitleSample[];
  readonly violation: RowTitleSample | null;
};

type WatcherWindow<State> = Window & {
  [WATCHER_KEY]?: State;
};

const newSlug = (prefix: string) =>
  IntegrationSlug.make(`${prefix}-${randomBytes(4).toString("hex")}`);

const identitySpec = (baseUrl: string): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Scoped Health API", version: "1.0.0" },
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
                  schema: {
                    type: "object",
                    properties: { email: { type: "string" }, login: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

const serveIdentityApi = (
  accounts: readonly {
    readonly token: string;
    readonly emails: readonly [string, ...string[]];
    readonly login: string;
    readonly delayMs?: number;
  }[],
) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly url: string; readonly close: () => void }>((resume) => {
      const byToken = new Map(accounts.map((account) => [account.token, account]));
      const callsByToken = new Map<string, number>();
      const server = createServer((request, response) => {
        const authorization = Array.isArray(request.headers.authorization)
          ? request.headers.authorization[0]
          : request.headers.authorization;
        const token = authorization?.startsWith("Bearer ")
          ? authorization.slice("Bearer ".length)
          : "";
        const account = byToken.get(token);

        if (request.method === "GET" && (request.url ?? "").startsWith("/me")) {
          const respond = () => {
            if (!account) {
              response.writeHead(401, { "content-type": "application/json" });
              response.end(JSON.stringify({ error: "invalid_token" }));
              return;
            }
            const calls = callsByToken.get(token) ?? 0;
            const email = account.emails[Math.min(calls, account.emails.length - 1)];
            callsByToken.set(token, calls + 1);
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ email, login: account.login }));
          };
          const delayMs = account?.delayMs ?? 0;
          if (delayMs > 0) {
            setTimeout(respond, delayMs);
            return;
          }
          respond();
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

const registerIdentityIntegration = (client: Client, slug: IntegrationSlug, baseUrl: string) =>
  client.openapi.addSpec({
    payload: {
      spec: { kind: "blob", value: identitySpec(baseUrl) },
      slug,
      baseUrl,
      authenticationTemplate: [
        {
          slug: "apiKey",
          type: "apiKey",
          headers: { authorization: ["Bearer ", { type: "variable", name: "token" }] },
        },
      ],
    },
  });

const getMeOperation = (client: Client, slug: IntegrationSlug) =>
  Effect.gen(function* () {
    const candidates = yield* client.integrations.healthCheckCandidates({ params: { slug } });
    const getMe = candidates.find((candidate) => candidate.method === "get");
    if (!getMe) return yield* Effect.die("identity spec exposed no GET candidate");
    return getMe.operation;
  });

const accountRow = (page: Page, marker: string): Locator =>
  page.locator('[data-slot="card-stack-entry"]').filter({ hasText: marker }).first();

const rowTitle = (row: Locator): Locator => row.locator('[data-slot="card-stack-entry-title"]');

const readTitle = async (row: Locator): Promise<string> =>
  (await rowTitle(row).innerText()).replace(/\s+/g, " ").trim();

const installRowTitleWatcher = (
  page: Page,
  input: {
    readonly marker: string;
    readonly forbiddenTitle: string;
    readonly durationMs: number;
  },
) =>
  page.evaluate(({ marker, forbiddenTitle, durationMs }) => {
    type MutableWatcherState = {
      done: boolean;
      samples: RowTitleSample[];
      violation: RowTitleSample | null;
    };
    const key = "__executorHealthScopedRefreshWatcher";
    const normalize = (value: string | null | undefined) =>
      (value ?? "").replace(/\s+/g, " ").trim();
    const state: MutableWatcherState = { done: false, samples: [], violation: null };
    const globalWindow = window as WatcherWindow<MutableWatcherState>;
    globalWindow[key] = state;
    const startedAt = performance.now();
    const readCurrentTitle = () => {
      const row = Array.from(
        document.querySelectorAll<HTMLElement>('[data-slot="card-stack-entry"]'),
      ).find((element) => normalize(element.textContent).includes(marker));
      return normalize(row?.querySelector('[data-slot="card-stack-entry-title"]')?.textContent);
    };
    const record = () => {
      const sample = { atMs: Math.round(performance.now() - startedAt), title: readCurrentTitle() };
      state.samples.push(sample);
      if (sample.title.includes(forbiddenTitle) && state.violation === null) {
        state.violation = sample;
      }
    };
    const observer = new MutationObserver(record);
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    const interval = window.setInterval(record, 20);
    record();
    window.setTimeout(() => {
      record();
      window.clearInterval(interval);
      observer.disconnect();
      state.done = true;
    }, durationMs);
  }, input);

const readWatcherState = (page: Page) =>
  page.evaluate(() => {
    const globalWindow = window as WatcherWindow<WatcherState>;
    return globalWindow.__executorHealthScopedRefreshWatcher ?? null;
  });

scenario(
  "Health checks (UI) · Check now keeps sibling account identities scoped",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const aliceToken = `ak_${randomBytes(8).toString("hex")}`;
      const bobToken = `bk_${randomBytes(8).toString("hex")}`;
      const server = yield* serveIdentityApi([
        { token: aliceToken, emails: [ALICE, ALICE_REFRESHED], login: "alice", delayMs: 150 },
        { token: bobToken, emails: [BOB, BOB_REFRESHED], login: "bob" },
      ]);
      const slug = newSlug("hc-scoped-refresh");
      const aliceName = ConnectionName.make("alice");
      const bobName = ConnectionName.make("bob");
      const aliceMarker = `scoped-refresh row alice ${randomBytes(4).toString("hex")}`;
      const bobMarker = `scoped-refresh row bob ${randomBytes(4).toString("hex")}`;

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* registerIdentityIntegration(client, slug, server.url);
          const operation = yield* getMeOperation(client, slug);
          yield* client.integrations.healthCheckSet({
            params: { slug },
            payload: { spec: { operation, identityField: "email" } },
          });

          yield* client.connections.create({
            payload: {
              owner: "org",
              name: aliceName,
              integration: slug,
              template: TEMPLATE,
              value: aliceToken,
              description: aliceMarker,
            },
          });
          yield* client.connections.create({
            payload: {
              owner: "user",
              name: bobName,
              integration: slug,
              template: TEMPLATE,
              value: bobToken,
              identityLabel: BOB,
              description: bobMarker,
            },
          });

          const aliceHealth = yield* client.connections.checkHealth({
            params: { owner: "org", integration: slug, name: aliceName },
            query: {},
          });
          expect(aliceHealth.identity, "Alice's saved verdict carries Alice").toBe(ALICE);
          const bobHealth = yield* client.connections.checkHealth({
            params: { owner: "user", integration: slug, name: bobName },
            query: {},
          });
          expect(bobHealth.identity, "Bob's saved verdict carries Bob").toBe(BOB);

          yield* browser.session(identity, async ({ page, step }) => {
            await step("Open the integration accounts list with both identities", async () => {
              await page.goto(`/integrations/${slug}`, { waitUntil: "networkidle" });
              await page.getByRole("tab", { name: "Accounts" }).waitFor();
              await page.getByText("Workspace", { exact: true }).first().waitFor();
              await page.getByText("Personal", { exact: true }).first().waitFor();

              const aliceRow = accountRow(page, aliceMarker);
              const bobRow = accountRow(page, bobMarker);
              await rowTitle(aliceRow).getByText(ALICE, { exact: true }).waitFor();
              await rowTitle(bobRow).getByText(BOB, { exact: true }).waitFor();
              expect(await readTitle(aliceRow), "Alice row starts with Alice's identity").toContain(
                ALICE,
              );
              expect(await readTitle(bobRow), "Bob row starts with Bob's identity").toContain(BOB);
            });

            await step("Update Bob's saved health outside the visible row", async () => {
              const bobRow = accountRow(page, bobMarker);
              const refreshedBob = await Effect.runPromise(
                client.connections.checkHealth({
                  params: { owner: "user", integration: slug, name: bobName },
                  query: {},
                }),
              );
              expect(refreshedBob.identity, "Bob's persisted verdict changed offscreen").toBe(
                BOB_REFRESHED,
              );
              expect(await readTitle(bobRow), "Bob row still shows the cached identity").toContain(
                BOB,
              );
              expect(
                await readTitle(bobRow),
                "Bob row has not refetched the offscreen identity yet",
              ).not.toContain(BOB_REFRESHED);
            });

            await step("Check Alice and watch Bob's row for identity bleed", async () => {
              const aliceRow = accountRow(page, aliceMarker);
              const bobRow = accountRow(page, bobMarker);
              const connectionReads: string[] = [];
              page.on("request", (request) => {
                const url = new URL(request.url());
                if (url.pathname === "/api/connections") {
                  connectionReads.push(`${url.pathname}${url.search}`);
                }
              });
              await installRowTitleWatcher(page, {
                marker: bobMarker,
                forbiddenTitle: BOB_REFRESHED,
                durationMs: 3_000,
              });

              await aliceRow.hover();
              await aliceRow.locator("button").first().click();
              await page.getByRole("menuitem", { name: "Check now", exact: true }).click();
              await Promise.all([
                page.waitForFunction(
                  () => {
                    const globalWindow = window as WatcherWindow<WatcherState>;
                    return globalWindow.__executorHealthScopedRefreshWatcher?.done === true;
                  },
                  undefined,
                  { timeout: 5_000 },
                ),
                page
                  .getByText(`Healthy: ${ALICE_REFRESHED}`, { exact: true })
                  .waitFor({ timeout: 30_000 }),
              ]);

              const watched = await readWatcherState(page);
              expect(watched, "row title watcher installed").not.toBeNull();
              if (watched === null) return;
              const sampleSummary = watched.samples
                .map((sample) => `${sample.atMs}ms=${sample.title}`)
                .join(" | ");
              expect(
                watched.violation,
                `Checking Alice refetched Bob's row and showed its offscreen identity. Samples: ${sampleSummary}`,
              ).toBeNull();
              expect(await readTitle(bobRow), "Bob row ends with Bob's identity").toContain(BOB);
              expect(
                await readTitle(aliceRow),
                "Alice row picked up the refreshed identity",
              ).toContain(ALICE_REFRESHED);
              expect(
                await readTitle(bobRow),
                "Bob row never ends as the forbidden refreshed Bob identity",
              ).not.toContain(BOB_REFRESHED);
              const bobOwnerReads = connectionReads.filter((path) =>
                new URL(`http://executor.test${path}`).searchParams.has("owner")
                  ? new URL(`http://executor.test${path}`).searchParams.get("owner") === "user"
                  : false,
              );
              expect(
                bobOwnerReads,
                `Checking Alice should not refresh Bob's owner-scoped list. Reads: ${connectionReads.join(
                  " | ",
                )}`,
              ).toEqual([]);
            });
          });
        }),
        Effect.gen(function* () {
          yield* client.connections
            .remove({ params: { owner: "org", integration: slug, name: aliceName } })
            .pipe(Effect.ignore);
          yield* client.connections
            .remove({ params: { owner: "user", integration: slug, name: bobName } })
            .pipe(Effect.ignore);
          yield* client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
        }),
      );
    }),
  ),
);
