import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { selectProfileAccounts } from "../support/profiles.ts";
import { holdQuery } from "../support/query-transition.ts";
import { providerErrorUpstream, providerSecretMarker } from "../support/provider-error-upstream.ts";
import { scenarios } from "../test-plan.ts";

const Failure = Schema.Struct({
  _tag: Schema.Literal("AppProviderFailed"),
  reason: Schema.String,
  status: Schema.Number,
  account: Schema.optional(
    Schema.Struct({ id: Schema.String, label: Schema.String, provider: Schema.String }),
  ),
});

layer(HostedLive, { excludeTestServices: true })("Provider errors", (it) => {
  it.effect(scenarios.providerErrors.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const upstream = yield* providerErrorUpstream;
        const prefix = `/api/organizations/${actors.organization.id}`;
        for (const kind of ["graphql", "mcp", "openapi", "custom"] as const) {
          yield* upstream.configure(undefined);
          const created =
            kind === "custom"
              ? yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
                  name: "Custom provider errors",
                  files: [
                    {
                      path: "index.ts",
                      content: `import { defineApp, defineProvider, secrets, object, string, query, ProviderError } from "apps";
const provider = defineProvider({ name: "Custom service", auth: { apiKey: secrets({ label: "API key", fields: object({ token: string() }) }) } });
export default defineApp({ accounts: { service: provider.many() } }, async ({ accounts, signal }) => {
  const account = accounts.service[1];
  if (!account) return { queries: {} };
  async function read(phase) {
    const response = await fetch(${JSON.stringify(upstream.origin)} + "/custom/" + phase, { signal, headers: { Authorization: "Bearer " + account.fields.token } });
    if (response.ok) return { ok: true };
    const detail = await response.json();
    if (response.status === 400) throw new Error(detail.message);
    throw Object.assign(new ProviderError({ reason: "unauthorized", status: response.status, accountId: response.status === 402 ? "acc_unselected" : account.id }), { message: detail.message, title: "Forged title", account: { label: "Forged account" } });
  }
  await read("discover");
  return { queries: { identity: query({ input: object({}) }, async () => read("call")) } };
});`,
                    },
                  ],
                })
              : yield* api.request(actors.owner, "POST", `${prefix}/apps/import`, {
                  source:
                    kind === "openapi"
                      ? {
                          kind,
                          name: "OpenAPI provider errors",
                          url: `${upstream.origin}/openapi.json`,
                          baseUrl: upstream.origin,
                        }
                      : {
                          kind,
                          name: `${kind} provider errors`,
                          url: `${upstream.origin}/${kind}`,
                          auth: { type: "apiKey", header: "Authorization", prefix: "Bearer " },
                        },
                });
          expect(created.status, JSON.stringify(created.body)).toBe(200);
          const app = yield* body(App, created),
            path = `${prefix}/apps/${app.id}`;
          const accounts: string[] = [];
          const profile = yield* body(
            Resource,
            yield* api.request(actors.owner, "POST", `${path}/profiles`, {
              accounts: { service: [] },
              idempotencyKey: randomUUID(),
            }),
          );
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              yield* upstream.configure(undefined);
              yield* api.request(actors.owner, "DELETE", `${path}/profiles/${profile.id}`);
              yield* api.request(actors.owner, "DELETE", path);
              for (const account of accounts)
                yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
            }).pipe(Effect.orDie),
          );
          for (const label of ["work", "personal"]) {
            const connection = yield* body(
              Resource,
              yield* api.request(actors.owner, "POST", `${path}/connections`, {
                requirement: "service",
                profile: profile.id,
              }),
            );
            const saved = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/submit`,
              { method: "apiKey", label, fields: { token: `synthetic-${label}` } },
            );
            expect(saved.status, JSON.stringify(saved.body)).toBe(200);
            accounts.push((yield* body(Resource, saved)).id);
          }
          const affected = accounts[1];
          if (affected === undefined) return yield* Effect.die("Missing second account");
          const tool = kind === "graphql" ? "queries.query_identity" : "queries.identity";
          const catalog = () =>
            api.request(actors.owner, "GET", `${path}/tools?profile=${profile.id}`);
          const call = () =>
            api.request(actors.owner, "POST", `${path}/tools/call`, {
              profile: profile.id,
              tool,
              input:
                kind === "custom"
                  ? {}
                  : { accountId: affected, input: kind === "mcp" ? { value: "personal" } : {} },
            });
          const assertFailure = (
            response: Effect.Success<ReturnType<typeof catalog>>,
            reason: string,
            status: number,
          ) =>
            Effect.gen(function* () {
              expect(response.status, `${kind}: ${JSON.stringify(response.body)}`).toBe(502);
              const parsed = yield* body(Failure, response);
              expect(parsed).toMatchObject({
                reason,
                status,
                account: { id: affected, label: "personal" },
              });
              expect(JSON.stringify(response.body)).not.toMatch(
                new RegExp(`${providerSecretMarker}|Forged|stack|synthetic-personal`),
              );
            });
          if (kind !== "openapi") {
            yield* upstream.configure({ status: 401 });
            yield* assertFailure(yield* catalog(), "unauthorized", 401);
            // Lazy MCP sources do not discover tools when listing unrelated webhooks.
            const setup = yield* api.request(
              actors.owner,
              "GET",
              `${path}/webhook-definitions?profile=${profile.id}`,
            );
            expect(setup.status, JSON.stringify(setup.body)).toBe(kind === "mcp" ? 200 : 502);
            if (kind === "mcp") expect(setup.body).toEqual([]);
          }
          yield* upstream.configure({ status: 401, phase: "call" });
          expect((yield* catalog()).status).toBe(200);
          yield* assertFailure(yield* call(), "unauthorized", 401);
          if (kind !== "custom") {
            for (const [status, headers, reason] of [
              [403, {}, "rejected"],
              [403, { "x-ratelimit-remaining": "0" }, "rate_limited"],
              [403, { "www-authenticate": 'Bearer error="insufficient_scope"' }, "forbidden"],
              [429, {}, "rate_limited"],
              [520, {}, "unavailable"],
            ] as const) {
              yield* upstream.configure({ status, headers, phase: "call" });
              yield* assertFailure(yield* call(), reason, status);
            }
          }
          if (kind === "custom") {
            yield* upstream.configure({ status: 402 });
            const forged = yield* body(Failure, yield* catalog());
            expect(forged.account).toBeUndefined();
            yield* upstream.configure({ status: 400 });
            const unknown = yield* catalog();
            expect(unknown.body).toMatchObject({ _tag: "AppEvaluationFailed" });
            expect(JSON.stringify(unknown.body)).not.toContain(providerSecretMarker);
            yield* upstream.configure({ status: 400, phase: "call" });
            const unknownCall = yield* call();
            expect(unknownCall.body).toMatchObject({ _tag: "ToolCallFailed" });
            expect(JSON.stringify(unknownCall.body)).not.toContain(providerSecretMarker);
          }
          if (kind !== "graphql") continue;
          for (const [code, reason] of [
            ["UNAUTHENTICATED", "unauthorized"],
            ["FORBIDDEN", "forbidden"],
            ["RATE_LIMITED", "rate_limited"],
          ] as const) {
            yield* upstream.configure({ status: 200, code });
            yield* assertFailure(yield* catalog(), reason, 200);
          }
          yield* upstream.configure({ status: 401 });
          expect(
            (yield* selectProfileAccounts(actors.owner, path, profile.id, { service: accounts }))
              .status,
          ).toBe(200);
          const deadline = (yield* Clock.currentTimeMillis) + 40_000;
          for (;;) {
            const result = yield* body(
              Schema.Struct({ status: Schema.String, failure: Schema.NullOr(Schema.String) }),
              yield* api.request(actors.owner, "POST", `${path}/profiles/${profile.id}/reconcile`),
            );
            if (result.status === "needs-setup") {
              expect(result.failure).toBe("accounts");
              break;
            }
            expect(yield* Clock.currentTimeMillis).toBeLessThan(deadline);
            yield* Effect.sleep("200 millis");
          }
          yield* browser.login(actors.owner);
          const url = `/org/${actors.organization.slug}/apps/${app.id}?view=tools&profile=${profile.id}`;
          yield* browser.use("Open authentication failure", (page) =>
            page
              .goto(url)
              .then(() => page.getByRole("heading", { name: "Authentication failed" }).waitFor()),
          );
          expect(
            yield* browser.use("Account is named", (page) => page.getByRole("alert").textContent()),
          ).toContain("personal");
          expect(
            yield* browser.use("No blind auth retry", (page) =>
              page.getByRole("button", { name: "Try again", exact: true }).count(),
            ),
          ).toBe(0);
          expect(
            yield* browser.use("Account errors replace the generic setup banner", (page) =>
              page.getByText("Background setup failed. Retry setup.", { exact: true }).count(),
            ),
          ).toBe(0);
          yield* browser.checkpoint("Authentication error names the account and recovery");
          yield* browser.use("Mobile error", (page) =>
            page.setViewportSize({ width: 390, height: 844 }),
          );
          yield* browser.checkpoint("Authentication recovery on mobile");
          yield* browser.use("Manage the affected account", (page) =>
            page
              .getByRole("link", { name: "Manage account" })
              .click()
              .then(() => page.waitForURL(`**/accounts/${affected}`)),
          );
          yield* browser.use("Restore desktop", (page) =>
            page.setViewportSize({ width: 1365, height: 900 }),
          );
          yield* upstream.configure({ status: 429 });
          yield* browser.use("Open rate limit", (page) =>
            page
              .goto(url)
              .then(() =>
                page.getByRole("heading", { name: "Service rate limit reached" }).waitFor(),
              ),
          );
          expect(
            yield* browser.use("Rate limit does not request credential repair", (page) =>
              page.getByRole("link", { name: "Manage account" }).count(),
            ),
          ).toBe(0);
          const held = yield* holdQuery(
            new RegExp(`/api/organizations/[^/]+/apps/${app.id}/tools$`),
            "continue",
          );
          yield* browser.use("Retry discovery", (page) =>
            page.getByRole("button", { name: "Try again", exact: true }).click(),
          );
          yield* held.requested;
          expect(
            yield* browser.use("Retry keeps the error visible", (page) =>
              page.getByRole("heading", { name: "Service rate limit reached" }).count(),
            ),
          ).toBe(1);
          expect(
            yield* browser.use("Duplicate retry disabled", (page) =>
              page.getByRole("button", { name: "Checking…", exact: true }).isDisabled(),
            ),
          ).toBe(true);
          yield* upstream.configure(undefined);
          yield* held.release;
          yield* browser.use("Discovery recovers", (page) =>
            page.getByText(tool, { exact: true }).first().waitFor(),
          );
          expect((yield* call()).status).toBe(200);
          yield* browser.use("Open the tool runner", (page) =>
            page
              .getByText(tool, { exact: true })
              .first()
              .click()
              .then(() => page.getByRole("button", { name: "Run tool", exact: true }).waitFor()),
          );
          const input = JSON.stringify({ accountId: affected, input: {} });
          yield* browser.use("Enter tool input", (page) =>
            page.getByLabel("Input", { exact: true }).fill(input),
          );
          yield* upstream.configure({ status: 401, phase: "call" });
          yield* browser.use("Run the failing tool", (page) =>
            page
              .getByRole("button", { name: "Run tool", exact: true })
              .click()
              .then(() => page.getByRole("heading", { name: "Authentication failed" }).waitFor()),
          );
          expect(
            yield* browser.use("Call failure retains input", (page) =>
              page.getByLabel("Input", { exact: true }).inputValue(),
            ),
          ).toBe(input);
          expect(
            yield* browser.use("Call offers the same account recovery", (page) =>
              page.getByRole("link", { name: "Manage account" }).getAttribute("href"),
            ),
          ).toContain(affected);
          yield* browser.use("Bring call recovery into view", (page) =>
            page
              .getByRole("alert", { name: "Authentication failed", exact: true })
              .scrollIntoViewIfNeeded(),
          );
          yield* browser.checkpoint("Tool call shows authentication recovery and preserves input");
        }
      }),
    ),
  );
});
