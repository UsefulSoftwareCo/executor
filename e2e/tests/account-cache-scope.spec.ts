import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";
import { connectionsPath } from "../support/app-accounts.ts";

const Scoped = Schema.Struct({ value: Schema.String, token: Schema.String });
const handle = /^exsec_[0-9a-f]+_$/;
const grantBytes = 12_000;

layer(HostedLive, { excludeTestServices: true })("Account cache scope", (it) => {
  it.effect(scenarios.accountCacheScope.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const name = `Account cache scope ${randomUUID().slice(0, 8)}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, secrets, object, plain, string, query, router } from "apps";
const service = defineProvider({
  name: ${JSON.stringify(name)},
  hosts: ["api.account-cache-scope.invalid"],
  auth: { key: secrets({ label: "Key", fields: object({ grant: plain(string()), token: string() }) }) },
});
export default defineApp({ user: { accounts: { service: service.many() } } }, async (ctx) => {
  const account = (id) => {
    const found = ctx.user.accounts.service.find((account) => account.id === id);
    if (!found) throw new Error("Missing account");
    return found;
  };
  return { tools: router({
    scoped: query({ input: object({ id: string() }) }, async (_, { id }) => ({
      value: await ctx.cache.forAccount(account(id)).get({ key: "probe", schema: string(), freshFor: "1 hour", load: async () => crypto.randomUUID() }),
      token: account(id).fields.token,
    })),
    oversized: query({ input: object({ id: string() }) }, async (_, { id }) =>
      ctx.cache.forAccount(account(id)).get({ key: "k".repeat(9000), schema: string(), freshFor: "1 hour", load: async () => "never" })),
  }) };
});`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        const path = `${prefix}/apps/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );

        const marker = randomUUID();
        const fields = {
          grant: `grant-${marker} ${"scope:read ".repeat(grantBytes / 11)}`,
          token: `secret-${marker}`,
        };
        expect(fields.grant.length).toBeGreaterThan(grantBytes);
        const connect = (label: string) =>
          Effect.gen(function* () {
            const pending = yield* api.request(
              actors.owner,
              "POST",
              connectionsPath(path, "user", "service"),
              {},
            );
            expect(pending.status, JSON.stringify(pending.body)).toBe(200);
            const saved = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${(yield* body(Resource, pending)).id}/submit`,
              { method: "key", label, fields },
            );
            expect(saved.status, JSON.stringify(saved.body)).toBe(200);
            const account = (yield* body(Resource, saved)).id;
            yield* Effect.addFinalizer(() =>
              api
                .request(actors.owner, "DELETE", `${prefix}/accounts/${account}`)
                .pipe(Effect.orDie),
            );
            return account;
          });
        const first = yield* connect("Synthetic first");
        const second = yield* connect("Synthetic second");

        const responses: unknown[] = [];
        const call = (tool: string, id: string) =>
          api
            .request(actors.owner, "POST", `${path}/tools/call`, {
              tool,
              input: { id },
            })
            .pipe(Effect.tap((response) => Effect.sync(() => responses.push(response.body))));
        const scoped = (id: string) =>
          Effect.gen(function* () {
            const response = yield* call("scoped", id);
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            return yield* body(Scoped, response);
          });

        const firstCalls = yield* Effect.forEach([1, 2, 3], () => scoped(first));
        for (const result of firstCalls) expect(result.token).toMatch(handle);
        expect(new Set(firstCalls.map((result) => result.token)).size).toBe(3);
        expect(new Set(firstCalls.map((result) => result.value)).size).toBe(1);

        const secondCalls = yield* Effect.forEach([1, 2], () => scoped(second));
        expect(new Set(secondCalls.map((result) => result.value)).size).toBe(1);
        expect(secondCalls[0]?.value).not.toBe(firstCalls[0]?.value);
        expect((yield* scoped(first)).value).toBe(firstCalls[0]?.value);

        const refused = yield* call("oversized", first);
        expect(refused.status, JSON.stringify(refused.body)).not.toBe(200);
        expect(JSON.stringify(refused.body)).toContain("CacheError");

        expect(JSON.stringify(responses)).not.toContain(marker);
      }),
    ),
  );
});
