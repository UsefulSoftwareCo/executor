// Cross-target (browser): the UI side of connection health checks, the feature
// that answers "has this credential expired?" (the Google 7-day dev-token case).
// These scenarios pin the operation picker, the part that lets a user choose
// WHICH call the probe runs:
//
//  1. Add Connection: with no health check configured yet, the user picks a
//     read-only operation is auto-picked, one Validate click probes the key,
//     and the picked operation is saved as the integration's health check.
//  2. Edit sheet, large spec: typing into the operation combobox filters a
//     hundreds-long candidate list down to the one match, and committing it
//     stores the real operation (not the freeform text typed to find it).
//  3. Add screen, large spec: the same picker is fed by the bounded spec
//     preview, so typing must reach an operation ranked well past the preview's
//     top slice.
//
// The upstream API is a real node:http server on 127.0.0.1 that gates `GET /me`
// on a bearer token. The probe runs server-side, so the in-process server is
// reachable from the dev server on the same host.
//
// These scenarios skip on targets without a browser surface (selfhost today).
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { Effect } from "effect";
import { expect } from "@effect/vitest";
import type { HttpApiClient } from "effect/unstable/httpapi";
import type { Page } from "playwright";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);
type Client = HttpApiClient.ForApi<typeof api>;

const TEMPLATE = AuthTemplateSlug.make("apiKey");
const IDENTITY = "alice@example.com";

/** Scroll the dialog content back to the top (steps assert deltas). */
const content_scrollTop_reset = async (page: Page) => {
  await page.locator('[data-slot="dialog-content"]').evaluate((el) => el.scrollTo({ top: 0 }));
};

const newSlug = (prefix: string) =>
  IntegrationSlug.make(`${prefix}-${randomBytes(4).toString("hex")}`);

/** OpenAPI 3 spec with an auth-gated GET (`/me`, the obvious health check) plus a
 *  destructive POST so the candidate ranking has something to sort the GET ahead
 *  of. */
const identitySpec = (baseUrl: string): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Identity API", version: "1.0.0" },
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
      "/messages": {
        post: {
          operationId: "sendMessage",
          summary: "Send a message",
          responses: { "201": { description: "created" } },
        },
      },
    },
  });

/** A real node:http API on 127.0.0.1. `GET /me` returns 200 only when the bearer
 *  token matches; any other token is a 401. Closed by the scope's finalizer. */
const serveIdentityApi = (validToken: string) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly url: string; readonly close: () => void }>((resume) => {
      const server = createServer((request, response) => {
        const authorized = request.headers["authorization"] === `Bearer ${validToken}`;
        if (request.method === "GET" && (request.url ?? "").startsWith("/me")) {
          response.writeHead(authorized ? 200 : 401, { "content-type": "application/json" });
          response.end(
            JSON.stringify(
              authorized ? { email: "alice@example.com", login: "alice" } : { error: "x" },
            ),
          );
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

/** Register the identity integration against `baseUrl` with a bearer-token auth
 *  method (single `token` input → connection `value`). */
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

/** Like `serveIdentityApi`, but with a `revoke()` that flips the key off so a
 *  saved connection's previously-good key stops working mid-session (the editor
 *  scenario's healthy -> expired transition). */
const serveMutableIdentityApi = (validToken: string) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly url: string;
      readonly revoke: () => void;
      readonly restore: () => void;
      readonly close: () => void;
    }>((resume) => {
      let live = true;
      const server = createServer((request, response) => {
        const authorized = live && request.headers["authorization"] === `Bearer ${validToken}`;
        if (request.method === "GET" && (request.url ?? "").startsWith("/me")) {
          response.writeHead(authorized ? 200 : 401, { "content-type": "application/json" });
          response.end(JSON.stringify(authorized ? { email: IDENTITY } : { error: "x" }));
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
            revoke: () => {
              live = false;
            },
            restore: () => {
              live = true;
            },
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

/** The stored operation name for the GET probe (openapi prefixes it by tag),
 *  discovered the same way the editor does: from the ranked candidate list. */
const getMeOperation = (client: Client, slug: IntegrationSlug) =>
  Effect.gen(function* () {
    const candidates = yield* client.integrations.healthCheckCandidates({ params: { slug } });
    const getMe = candidates.find((candidate) => candidate.method === "get");
    if (!getMe) return yield* Effect.die("identity spec exposed no GET candidate");
    return getMe.operation;
  });

/** Select a combobox option by CLICKING it (the real mouse path). The popup is
 *  portaled out of the modal, so this exercises both that the option is clickable
 *  (popup `pointer-events`) and that clicking it does not dismiss the surrounding
 *  modal (the dialog/sheet outside-interaction guard). */
const clickComboboxOption = async (page: Page, inputId: string, optionText: string) => {
  await page.locator(`#${inputId}`).click();
  const target = page.getByRole("option").filter({ hasText: optionText }).first();
  await target.waitFor({ timeout: 10_000 });
  await target.click();
};

// A distinctive operation buried in a large spec, found by its unique summary
// (which no filler operation shares) so the filter test can search for it.
const PROBE_TOKEN = "ztarget";
const PROBE_SUMMARY = `Health probe candidate ${PROBE_TOKEN}`;

/** An OpenAPI 3 spec with ~250 GET operations plus one distinctive probe. The
 *  candidate list is far longer than the popup renders at once, so the operation
 *  picker only surfaces a given operation when typing actually filters the list.
 *  The title is parameterizable so the add screen (which mints the slug from the
 *  title) gets a collision-free integration per run. */
const largeSpec = (baseUrl: string, title = "Big API"): string => {
  const okJson = {
    "200": {
      description: "ok",
      content: {
        "application/json": { schema: { type: "object", properties: { id: { type: "string" } } } },
      },
    },
  };
  const paths: Record<string, unknown> = {};
  for (let index = 0; index < 250; index++) {
    paths[`/things/item${index}`] = {
      get: { operationId: `getThing${index}`, summary: `Thing number ${index}`, responses: okJson },
    };
  }
  paths["/probe/target"] = {
    get: { operationId: "probeTarget", summary: PROBE_SUMMARY, responses: okJson },
  };
  return JSON.stringify({
    openapi: "3.0.3",
    info: { title, version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths,
  });
};

// ===========================================================================
// 1. Add Connection, no check configured: pick an operation inline, check the
//    key works, and the picked operation is saved as the integration's check.
// ===========================================================================

scenario(
  "Health checks (UI) · the request panel: pre-seeded call, one Check, response rows pick the identity",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const goodToken = `gk_${randomBytes(8).toString("hex")}`;
      const server = yield* serveIdentityApi(goodToken);
      const slug = newSlug("hc-ui-connect-check");

      yield* Effect.ensuring(
        Effect.gen(function* () {
          // Register the integration but deliberately configure NO health check:
          // the Add Connection modal must let the user pick one inline.
          yield* registerIdentityIntegration(client, slug, server.url);
          expect(
            yield* client.integrations.healthCheckGet({ params: { slug } }),
            "no health check is configured up front",
          ).toBeNull();
          const candidates = yield* client.integrations.healthCheckCandidates({ params: { slug } });
          const getMe = candidates.find((candidate) => candidate.method === "get");
          if (!getMe) return yield* Effect.die("identity spec exposed no GET candidate");

          yield* browser.session(identity, async ({ page, step }) => {
            const dialog = page.getByRole("dialog");

            await step("Open the Add Connection modal", async () => {
              await page.goto(`/integrations/${slug}`, { waitUntil: "networkidle" });
              await page.getByRole("button", { name: "Add connection", exact: true }).click();
              await page.getByRole("heading", { name: /Add connection/ }).waitFor();
            });

            await step(
              "The key field has first focus; the request line is pre-seeded",
              async () => {
                // The credential is the modal's first input now (the name is
                // derived from it), so pasting starts immediately.
                await page.keyboard.type(goodToken);
                // The panel is already on screen with the best read-only call in
                // the request line — nothing to expand, nothing to configure.
                await page.waitForFunction(() => {
                  const input = document.querySelector(
                    "#hc-pick-operation",
                  ) as HTMLInputElement | null;
                  return input?.value.includes("getMe") ?? false;
                });
              },
            );

            await step("One Check runs it; the response lands in the panel", async () => {
              await dialog.getByRole("button", { name: "Check", exact: true }).click();
              await dialog.getByText("Healthy", { exact: true }).waitFor({ timeout: 30_000 });
              // The key field is still on screen, editable, mid-flow.
              await dialog.locator('input[type="password"]').first().waitFor();
            });

            await step("The response renders read-only, identity fields first", async () => {
              // The panel shows what came back; picking happens on step 2.
              await dialog.getByText("email", { exact: true }).waitFor();
              await dialog.getByText("alice@example.com", { exact: true }).waitFor();
            });

            await step(
              "Step 2: the display name is a picker over the identity fields",
              async () => {
                await dialog.getByRole("button", { name: "Continue", exact: true }).click();
                await dialog.getByRole("button", { name: "Add connection", exact: true }).waitFor();
                // The name combobox offers the response's identity fields.
                await clickComboboxOption(page, "connection-name", "alice@example.com");
                await page.waitForFunction(
                  () =>
                    (document.querySelector("#connection-name") as HTMLInputElement | null)
                      ?.value === "alice@example.com",
                );
              },
            );
          });

          // The Check persisted the operation; picking the name from the
          // response upgraded the check with that field as the identity.
          const stored = yield* client.integrations.healthCheckGet({ params: { slug } });
          expect(stored?.operation, "the picked operation was saved as the health check").toBe(
            getMe.operation,
          );
          expect(stored?.identityField, "the name pick set the identity field").toBe("email");
        }),
        client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore),
      );
    }),
  ),
);

// ===========================================================================
// 2. Edit sheet, large spec: typing filters the operation picker to the match.
// ===========================================================================

scenario(
  "Health checks (UI) · large spec: typing filters the operation picker down to the match",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const slug = newSlug("hc-ui-large");

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* client.openapi.addSpec({
            payload: {
              spec: { kind: "blob", value: largeSpec("https://big.example.com") },
              slug,
              baseUrl: "https://big.example.com",
              authenticationTemplate: [
                {
                  slug: "apiKey",
                  type: "apiKey",
                  headers: {
                    authorization: ["Bearer ", { type: "variable", name: "token" }],
                  },
                },
              ],
            },
          });
          // The toolPath the registration assigned the distinctive probe op,
          // matched by its unique summary, so the read-back asserts exactly the
          // operation the on-camera filter-then-pick selected.
          const candidates = yield* client.integrations.healthCheckCandidates({ params: { slug } });
          const probe = candidates.find((candidate) => candidate.summary === PROBE_SUMMARY);
          if (!probe) return yield* Effect.die("large spec is missing its probe operation");
          const probeOperation = probe.operation;
          // Sanity: the spec really is large, so the picker can't just show them all.
          expect(candidates.length).toBeGreaterThan(100);

          yield* browser.session(identity, async ({ page, step }) => {
            const input = page.locator("#health-check-operation");
            const options = page.getByRole("option");

            await step("Open the health-check editor over the large spec", async () => {
              await page.goto(`/integrations/${slug}`, { waitUntil: "networkidle" });
              await page.getByRole("heading", { level: 3, name: "Health check" }).waitFor();
              await page.getByRole("button", { name: "Set up" }).click();
              await input.waitFor();
            });

            await step("A broad query still surfaces many operations", async () => {
              await input.click();
              // Real keystrokes (base-ui filters on the input value, not a
              // programmatic set): a shared summary prefix matches the fillers.
              await input.selectText();
              await input.pressSequentially("Thing number", { delay: 10 });
              await options.filter({ hasText: "Thing number" }).first().waitFor();
              // The popup caps how many it renders, but a broad match fills it.
              expect(await options.count()).toBeGreaterThan(20);
            });

            await step("A distinctive query narrows the list to the one match", async () => {
              await input.selectText();
              await input.pressSequentially(PROBE_TOKEN, { delay: 10 });
              const match = options.filter({ hasText: PROBE_SUMMARY }).first();
              await match.waitFor({ timeout: 10_000 });
              // Typing actually filters: the hundreds collapse to the single
              // matching operation (plus the freeform echo of the typed text).
              expect(await options.count()).toBeLessThanOrEqual(3);
            });

            await step("Select the filtered operation and save", async () => {
              const match = options.filter({ hasText: PROBE_SUMMARY }).first();
              // base-ui pre-highlights the freeform echo; arrow onto the real op.
              for (let i = 0; i < 8; i++) {
                if ((await match.getAttribute("data-highlighted")) !== null) break;
                await input.press("ArrowDown");
              }
              await input.press("Enter");
              await page.getByRole("button", { name: "Save", exact: true }).click();
              await input.waitFor({ state: "hidden" });
            });
          });

          // The picker committed the real operation behind the matched summary,
          // not the freeform text that was typed to find it.
          const stored = yield* client.integrations.healthCheckGet({ params: { slug } });
          expect(stored?.operation).toBe(probeOperation);
        }),
        Effect.gen(function* () {
          yield* client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
        }),
      );
    }),
  ),
);

// ===========================================================================
// 3. Add screen, large spec: the operation picker is fed by the bounded spec
//    preview, so it must carry enough of a big spec that typing reaches an
//    operation ranked well past the preview's top slice (the Vercel "user"
//    case: searching found nothing because the op wasn't in the top few).
// ===========================================================================

scenario(
  "Health checks (UI) · add screen large spec: typing reaches an operation beyond the preview's top slice",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      // The add screen mints the slug from the title, so make it unique. Search
      // for an operation whose toolPath sorts far past the old top-10 cap.
      const title = `Big API ${randomBytes(4).toString("hex")}`;
      const spec = largeSpec("https://big.example.com", title);
      const targetSummary = "Thing number 137";

      let createdSlug = "";
      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* browser.session(identity, async ({ page, step }) => {
            const input = page.locator("#add-health-check-operation");
            const options = page.getByRole("option");

            await step("Open the Add form and paste the large spec", async () => {
              await page.goto("/integrations/add/openapi", { waitUntil: "networkidle" });
              await page.getByPlaceholder("https://api.example.com/openapi.json").fill(spec);
              await page
                .getByRole("heading", { name: "Health check (optional)" })
                .waitFor({ timeout: 20_000 });
            });

            await step("Type to reach an operation past the preview's top slice", async () => {
              await input.click();
              // Real keystrokes; the operation isn't in the first handful, so it
              // is reachable only because the preview now carries the whole spec.
              await input.selectText();
              await input.pressSequentially(targetSummary, { delay: 10 });
              // The real option carries the GET label + toolPath; the freeform
              // echo is just the typed text, so "GET" disambiguates them.
              const match = options.filter({ hasText: targetSummary }).filter({ hasText: "GET" });
              await match.first().waitFor({ timeout: 10_000 });
            });

            await step("Select the found operation and add the integration", async () => {
              const match = options.filter({ hasText: targetSummary }).filter({ hasText: "GET" });
              for (let i = 0; i < 8; i++) {
                if ((await match.first().getAttribute("data-highlighted")) !== null) break;
                await input.press("ArrowDown");
              }
              await input.press("Enter");
              await page.getByRole("button", { name: "Add integration" }).click();
              await page.waitForURL(/\/integrations\/[^/?#]+$/, { timeout: 30_000 });
              const url = page.url().match(/\/integrations\/([^/?#]+)/);
              createdSlug = url?.[1] ?? "";
            });
          });

          expect(createdSlug.length).toBeGreaterThan(0);
          const slug = IntegrationSlug.make(createdSlug);
          // The drafted check persisted the operation behind the matched summary,
          // proving the add-screen search reached past the preview's top slice.
          const candidates = yield* client.integrations.healthCheckCandidates({ params: { slug } });
          const expected = candidates.find((candidate) => candidate.summary === targetSummary);
          if (!expected) return yield* Effect.die("created integration is missing the target op");
          const stored = yield* client.integrations.healthCheckGet({ params: { slug } });
          expect(stored?.operation).toBe(expected.operation);
        }),
        Effect.gen(function* () {
          if (createdSlug.length > 0) {
            yield* client.openapi
              .removeSpec({ params: { slug: IntegrationSlug.make(createdSlug) } })
              .pipe(Effect.ignore);
          }
        }),
      );
    }),
  ),
);

// ===========================================================================

scenario(
  "Health checks (UI) · clicking a combobox option in the sheet selects it without closing the sheet",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const slug = newSlug("hc-ui-click");

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* registerIdentityIntegration(client, slug, "https://identity.example.com");
          const operation = yield* getMeOperation(client, slug);

          yield* browser.session(identity, async ({ page, step }) => {
            const sheet = page.getByRole("dialog");
            const operationInput = page.locator("#health-check-operation");

            await step("Open the health-check editor", async () => {
              await page.goto(`/integrations/${slug}`, { waitUntil: "networkidle" });
              await page.getByRole("heading", { level: 3, name: "Health check" }).waitFor();
              await page.getByRole("button", { name: "Set up" }).click();
              await operationInput.waitFor();
            });

            await step(
              "Click the operation option by mouse: it selects and the sheet stays open",
              async () => {
                await operationInput.click();
                await page.getByRole("option").filter({ hasText: "getMe" }).first().click();
                // Clicking the portaled popup option must NOT dismiss the sheet.
                await sheet.waitFor();
                expect(await operationInput.inputValue()).toContain("getMe");
                await page.getByRole("button", { name: "Save", exact: true }).click();
                await operationInput.waitFor({ state: "hidden" });
              },
            );
          });

          // The mouse-driven selection persisted: only possible if the option
          // click selected without dismissing the sheet first.
          const stored = yield* client.integrations.healthCheckGet({ params: { slug } });
          expect(stored).toEqual({ operation });
        }),
        client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore),
      );
    }),
  ),
);

// ===========================================================================
// 7. Edit sheet, scroll: a modal dialog locks body scroll, which freezes the
//    portaled combobox list. The editor sheet is non-modal so the list scrolls.
// ===========================================================================

scenario(
  "Health checks (UI) · the combobox list scrolls inside the edit sheet",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const slug = newSlug("hc-ui-scroll");

      yield* Effect.ensuring(
        Effect.gen(function* () {
          // Many operations so the popup list overflows and must scroll.
          yield* client.openapi.addSpec({
            payload: {
              spec: { kind: "blob", value: largeSpec("https://big.example.com") },
              slug,
              baseUrl: "https://big.example.com",
              authenticationTemplate: [
                {
                  slug: "apiKey",
                  type: "apiKey",
                  headers: { authorization: ["Bearer ", { type: "variable", name: "token" }] },
                },
              ],
            },
          });

          yield* browser.session(identity, async ({ page, step }) => {
            const operationInput = page.locator("#health-check-operation");
            const list = page.locator("[data-slot='combobox-list']").first();

            await step("Open the operation combobox in the sheet", async () => {
              await page.goto(`/integrations/${slug}`, { waitUntil: "networkidle" });
              await page.getByRole("heading", { level: 3, name: "Health check" }).waitFor();
              await page.getByRole("button", { name: "Set up" }).click();
              await operationInput.waitFor();
              await operationInput.click();
              await list.waitFor();
            });

            await step("Wheel-scroll the list: it actually moves (not scroll-locked)", async () => {
              const before = await list.evaluate((el) => el.scrollTop);
              await list.hover();
              await page.mouse.wheel(0, 600);
              // Poll: the wheel scroll must move the list (blocked → stays 0).
              await page.waitForFunction(
                (start) => {
                  const el = document.querySelector("[data-slot='combobox-list']");
                  return el != null && el.scrollTop > start + 20;
                },
                before,
                { timeout: 5000 },
              );
              const after = await list.evaluate((el) => el.scrollTop);
              expect(after, "the list scrolled past its starting offset").toBeGreaterThan(before);
              // The sheet stayed open through the scroll interaction.
              await page.getByRole("dialog").waitFor();
            });
          });
        }),
        client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore),
      );
    }),
  ),
);

// ===========================================================================
// Edit sheet WITH identity (identity layer): pick the operation + identity field
// by mouse, live-preview the response, then drive "Check now" on a saved
// connection healthy -> expired once the upstream revokes the key.
// ===========================================================================

scenario(
  "Health checks (UI) · edit sheet with identity: preview the response, then healthy then expired",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const goodToken = `gk_${randomBytes(8).toString("hex")}`;
      const server = yield* serveMutableIdentityApi(goodToken);
      const slug = newSlug("hc-ui-id");
      const name = ConnectionName.make("main");

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* registerIdentityIntegration(client, slug, server.url);
          const operation = yield* getMeOperation(client, slug);
          yield* client.connections.create({
            payload: {
              owner: "org",
              name,
              integration: slug,
              template: TEMPLATE,
              value: goodToken,
            },
          });

          yield* browser.session(identity, async ({ page, step }) => {
            const connections = page.locator("section").filter({
              has: page.getByRole("heading", { level: 3, name: "Connections" }),
            });
            const menuTrigger = connections.locator('button[aria-haspopup="menu"]');

            await step("Open the integration's connections", async () => {
              await page.goto(`/integrations/${slug}`, { waitUntil: "networkidle" });
              await connections.getByText("main", { exact: true }).waitFor();
              await page.getByRole("heading", { level: 3, name: "Health check" }).waitFor();
            });

            await step(
              "Pick the GET identity call and its email identity field by mouse",
              async () => {
                await page.getByRole("button", { name: "Set up" }).click();
                await clickComboboxOption(page, "health-check-operation", "getMe");
                await clickComboboxOption(page, "health-check-identity", "email");
              },
            );

            await step("Live preview a pasted key: status, response, and identity", async () => {
              const sheet = page.getByRole("dialog");
              await page.locator("#health-check-preview-key").fill(goodToken);
              await sheet.getByRole("button", { name: "Preview", exact: true }).click();
              await sheet.getByText("Response", { exact: true }).waitFor({ timeout: 30_000 });
              await sheet.getByText("Resolves to:").waitFor();
              await sheet.getByText(IDENTITY).first().waitFor();
            });

            await step("Save the health check", async () => {
              await page.getByRole("button", { name: "Save", exact: true }).click();
              await page.locator("#health-check-operation").waitFor({ state: "hidden" });
            });

            await step("Check the live connection: healthy, and whose account it is", async () => {
              await menuTrigger.click();
              await page.getByRole("menuitem", { name: "Check now" }).click();
              await connections.getByText(IDENTITY).waitFor({ timeout: 30_000 });
              await connections.getByLabel("Status: Healthy").waitFor();
            });

            await step("The upstream revokes the key: the connection reads expired", async () => {
              server.revoke();
              await menuTrigger.click();
              await page.getByRole("menuitem", { name: "Check now" }).click();
              await connections.getByText("Expired", { exact: true }).waitFor({ timeout: 30_000 });
              await connections.getByLabel("Status: Expired").waitFor();
            });
          });

          const stored = yield* client.integrations.healthCheckGet({ params: { slug } });
          expect(stored).toEqual({ operation, identityField: "email" });
        }),
        Effect.gen(function* () {
          yield* client.connections
            .remove({ params: { owner: "org", integration: slug, name } })
            .pipe(Effect.ignore);
          yield* client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
        }),
      );
    }),
  ),
);

// ===========================================================================
// Add Connection, check configured WITH identity (identity layer): checking the
// key derives the connection name from the probed identity.
// ===========================================================================

scenario(
  "Health checks (UI) · Add Connection derives the connection name from the probed identity",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const goodToken = `gk_${randomBytes(8).toString("hex")}`;
      const server = yield* serveIdentityApi(goodToken);
      const slug = newSlug("hc-ui-name");

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* registerIdentityIntegration(client, slug, server.url);
          const operation = yield* getMeOperation(client, slug);
          yield* client.integrations.healthCheckSet({
            params: { slug },
            payload: { spec: { operation, identityField: "email" } },
          });

          yield* browser.session(identity, async ({ page, step }) => {
            const dialog = page.getByRole("dialog");

            await step("Open the Add Connection modal", async () => {
              await page.goto(`/integrations/${slug}`, { waitUntil: "networkidle" });
              await page.getByRole("button", { name: "Add connection", exact: true }).click();
              await page.getByRole("heading", { name: /Add connection/ }).waitFor();
            });

            await step("A valid key checks healthy and names the connection", async () => {
              // The bearer template renders the merged "Bearer <token>" field: the
              // affix is fixed, the input itself has the bare "token" placeholder.
              await dialog.locator('input[type="password"]').first().fill(goodToken);
              // A CONFIGURED check probes directly — no pick block.
              await dialog.getByRole("button", { name: "Check", exact: true }).click();
              await dialog.getByText(/Healthy/).waitFor({ timeout: 30_000 });
              // The derived name shows on step 2.
              await dialog.getByRole("button", { name: "Continue", exact: true }).click();
              await page.waitForFunction(
                (expected) =>
                  (document.querySelector("#connection-name") as HTMLInputElement | null)?.value ===
                  expected,
                IDENTITY,
                { timeout: 10_000 },
              );
            });
          });
        }),
        client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore),
      );
    }),
  ),
);

// ===========================================================================
// At-a-glance expiry (persisted verdicts): the connections list renders the
// LAST PERSISTED health-check result on a fresh page load — no per-row
// clicking. This is the customer ask verbatim ("quickly see if one of these
// has expired"): the verdict from an earlier probe (here via the API, as a
// background sweep would run it) survives to a brand-new browser page.
// ===========================================================================

scenario(
  "Health checks (UI) · the connections list shows a persisted expired verdict at a glance",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const goodToken = `gk_${randomBytes(8).toString("hex")}`;
      const server = yield* serveMutableIdentityApi(goodToken);
      const slug = newSlug("hc-ui-glance");
      const name = ConnectionName.make("main");

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
              name,
              integration: slug,
              template: TEMPLATE,
              value: goodToken,
            },
          });

          // Probe while healthy, then revoke and probe again — entirely through
          // the API, before any browser opens. Each run persists its verdict.
          const healthy = yield* client.connections.checkHealth({
            params: { owner: "org", integration: slug, name },
            query: {},
          });
          expect(healthy.status, "the key starts healthy").toBe("healthy");
          server.revoke();
          const expired = yield* client.connections.checkHealth({
            params: { owner: "org", integration: slug, name },
            query: {},
          });
          expect(expired.status, "the revoked key probes expired").toBe("expired");

          yield* browser.session(identity, async ({ page, step }) => {
            const connections = page.locator("section").filter({
              has: page.getByRole("heading", { level: 3, name: "Connections" }),
            });

            await step(
              "A fresh page load shows the expired connection with NO clicking",
              async () => {
                await page.goto(`/integrations/${slug}`, { waitUntil: "networkidle" });
                // The persisted verdict drives the row: red dot + Expired badge
                // are already there on first paint of the list.
                await connections.getByLabel("Status: Expired").waitFor({ timeout: 30_000 });
                await connections.getByText("Expired", { exact: true }).waitFor();
                // An expired verdict carries no identity; the row falls back to
                // the connection name.
                await connections.getByText("main", { exact: true }).waitFor();
              },
            );

            await step(
              "The key recovers: reloading auto-revalidates back to healthy, no clicks",
              async () => {
                // Health checks are AUTOMATIC: non-healthy verdicts always
                // revalidate on mount (recovery must show on the next load,
                // not after the freshness window). Restore the key, reload,
                // and the dot flips back with no clicks.
                server.restore();
                await page.goto(`/integrations/${slug}`, { waitUntil: "networkidle" });
                // The row mounts with the stale expired verdict, then the
                // background revalidation flips it to healthy in place.
                await connections.getByLabel("Status: Healthy").waitFor({ timeout: 30_000 });
              },
            );
          });
        }),
        Effect.gen(function* () {
          yield* client.connections
            .remove({ params: { owner: "org", integration: slug, name } })
            .pipe(Effect.ignore);
          yield* client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
        }),
      );
    }),
  ),
);

// ===========================================================================
// Modal scroll: with the request panel showing a full response, the Add
// Connection modal can exceed the viewport cap (max-h 85vh) — its body must
// actually wheel-scroll. Radix modal dialogs lock body scroll; a bug in the
// overflow chain (or a scroll-lock leak from the portaled combobox) makes the
// wheel do nothing, stranding the footer out of reach.
// ===========================================================================

scenario(
  "Health checks (UI) · the Add Connection modal wheel-scrolls when the response overflows",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const goodToken = `gk_${randomBytes(8).toString("hex")}`;
      // A wide response: many scalar fields, so the response view + the rest
      // of the modal outgrow a short viewport.
      const server = yield* Effect.acquireRelease(
        Effect.callback<{ readonly url: string; readonly close: () => void }>((resume) => {
          const httpServer = createServer((request, response) => {
            const authorized = request.headers["authorization"] === `Bearer ${goodToken}`;
            if (request.method === "GET" && (request.url ?? "").startsWith("/me")) {
              const body: Record<string, string> = { email: "alice@example.com" };
              for (let i = 0; i < 20; i++) body[`field${i}`] = `value ${i}`;
              response.writeHead(authorized ? 200 : 401, {
                "content-type": "application/json",
              });
              response.end(JSON.stringify(authorized ? body : { error: "x" }));
              return;
            }
            response.writeHead(404, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "not_found" }));
          });
          httpServer.listen(0, "127.0.0.1", () => {
            const address = httpServer.address();
            const port = typeof address === "object" && address ? address.port : 0;
            resume(
              Effect.succeed({
                url: `http://127.0.0.1:${port}`,
                close: () => {
                  httpServer.close();
                  httpServer.closeAllConnections();
                },
              }),
            );
          });
        }),
        (s) => Effect.sync(s.close),
      );
      const slug = newSlug("hc-ui-scrollmodal");

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* registerIdentityIntegration(client, slug, server.url);

          yield* browser.session(identity, async ({ page, step }) => {
            const dialog = page.getByRole("dialog", { name: /Add connection/ });

            await step("Open the modal in a short viewport", async () => {
              // Short enough that step 1 already overflows BEFORE the probe,
              // while the operation combobox still renders (a healthy probe
              // saves the check and turns the request line static).
              await page.setViewportSize({ width: 1280, height: 420 });
              await page.goto(`/integrations/${slug}`, { waitUntil: "networkidle" });
              await page.getByRole("button", { name: "Add connection", exact: true }).click();
              await page.getByRole("heading", { name: /Add connection/ }).waitFor();
              await page.keyboard.type(goodToken);
            });

            await step("The modal wheel-scrolls even with the operation popup open", async () => {
              // The dialog is non-modal precisely so react-remove-scroll can't
              // trap the wheel; opening the portaled combobox popup must not
              // re-lock it.
              const content = page.locator('[data-slot="dialog-content"]');
              const overflowing = await content.evaluate(
                (el) => el.scrollHeight > el.clientHeight + 20,
              );
              expect(overflowing, "step 1 overflows this viewport").toBe(true);
              await page.locator("#hc-pick-operation").click();
              await page.getByRole("option").first().waitFor();
              const before = await content.evaluate((el) => el.scrollTop);
              await content.hover();
              await page.mouse.wheel(0, 200);
              await page.waitForFunction(
                (start) => {
                  const el = document.querySelector('[data-slot="dialog-content"]');
                  return el != null && el.scrollTop !== start;
                },
                before,
                { timeout: 5_000 },
              );
              // Close the popup by tabbing focus out of the combobox (Escape
              // would close the whole dialog, and in this short viewport the
              // popup covers everything clickable).
              await page.keyboard.press("Tab");
              await page.getByRole("option").first().waitFor({ state: "hidden" });
            });

            await step("Probe: the response makes the overflow worse", async () => {
              await content_scrollTop_reset(page);
              await dialog.getByRole("button", { name: "Check", exact: true }).click();
              await dialog.getByText("Healthy", { exact: true }).waitFor({ timeout: 30_000 });
            });

            await step("The modal body wheel-scrolls to reach the footer", async () => {
              const content = page.locator('[data-slot="dialog-content"]');
              const before = await content.evaluate((el) => el.scrollTop);
              // The modal must be genuinely overflowing in this viewport, or
              // the scroll assertion below would pass vacuously.
              const overflowing = await content.evaluate(
                (el) => el.scrollHeight > el.clientHeight + 20,
              );
              expect(overflowing, "the modal content overflows the viewport cap").toBe(true);
              await content.hover();
              await page.mouse.wheel(0, 600);
              await page.waitForFunction(
                (start) => {
                  const el = document.querySelector('[data-slot="dialog-content"]');
                  return el != null && el.scrollTop > start + 20;
                },
                before,
                { timeout: 5_000 },
              );
              // And the footer's Continue is reachable after scrolling.
              await dialog.getByRole("button", { name: "Continue", exact: true }).click();
              await dialog.getByRole("button", { name: "Add connection", exact: true }).waitFor();
            });
          });
        }),
        client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore),
      );
    }),
  ),
);
