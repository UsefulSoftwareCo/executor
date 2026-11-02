/** Host credentials appear only when an editor needs to repair the app. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Evidence } from "../support/evidence.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

const App = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Struct({ pool: Schema.Struct({ provider: Schema.String }) }),
  }),
});
const source = (
  provisioned: boolean,
  broken = false,
) => `import { defineApp, defineProvider, object, query, router, secrets, string } from "apps";
const pool = defineProvider({ name: "Signalbox pool", auth: {
  token: secrets({ label: "Pool access", ${provisioned ? "provisioned: true," : ""} fields: object({ token: string() }) }),
}, async health() { ${broken ? 'throw new Error("Host access needs repair");' : "return {};"} } });
const subscription = defineProvider({ name: "Subscription", auth: { key: secrets({ label: "Subscription", fields: object({ token: string() }) }) } });
export default defineApp({ app: { accounts: { pool } }, user: { accounts: { subscription } } }, {
  tools: router({ present: query({ input: object({}) }, async () => ({ valid: true })) }),
});`;

layer(HostedLive, { excludeTestServices: true })("Host-managed account visibility", (it) => {
  it.effect(scenarios.hostManagedAccounts.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const files = (provisioned: boolean, broken = false) => [
          { path: "index.ts", content: source(provisioned, broken) },
          appsManifest,
        ];
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "Synthetic pool",
          files: files(false),
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed),
          path = `${prefix}/apps/${app.id}`;
        let account: string | undefined;
        yield* Effect.addFinalizer(() =>
          serverControl("start").pipe(
            Effect.andThen(
              Effect.gen(function* () {
                yield* api.request(actors.owner, "DELETE", path);
                if (account !== undefined)
                  yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
              }),
            ),
            Effect.orDie,
          ),
        );
        const pending = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${path}/accounts/app/pool/connections`, {}),
        );
        const saved = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${pending.id}/submit`,
          { method: "token", label: "Pool access", fields: { token: "synthetic-pool-token" } },
        );
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        account = (yield* body(Resource, saved)).id;
        const access = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${path}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        const updated = yield* api.request(actors.owner, "POST", `${path}/deploy`, {
          files: files(true),
        });
        expect(updated.status, JSON.stringify(updated.body)).toBe(200);
        const current = yield* body(Schema.Struct({ app: App }), updated);
        yield* legacyStorage([
          {
            sql: "UPDATE executor_accounts SET provider = $1 WHERE id = $2",
            params: [current.app.requirements.accounts.pool.provider, account],
          },
        ]);
        yield* serverControl("start");
        const check = () =>
          api.request(actors.owner, "POST", `${prefix}/accounts/${account}/health`);
        expect((yield* check()).status).toBe(200);
        yield* browser.login(actors.owner);
        yield* browser.use("Open synthetic saved sign-ins", (page) =>
          page.goto(`/org/${actors.organization.slug}/accounts`),
        );
        yield* browser.use("Wait for Accounts", (page) =>
          page.getByRole("heading", { name: /^Accounts/ }).waitFor(),
        );
        yield* evidence.attach(
          "personal-accounts.png",
          "image/png",
          yield* browser.use("Capture synthetic personal Accounts", (page) =>
            page.screenshot({ fullPage: true }),
          ),
        );
        const personal = yield* browser.use("Read saved sign-ins", (page) =>
          page.locator("main").innerText(),
        );
        yield* browser.use("Open synthetic pool Accounts", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`),
        );
        yield* browser.use("Wait for Subscription", (page) =>
          page.getByRole("region", { name: /^Subscription(?: \(subscription\))?$/ }).waitFor(),
        );
        yield* evidence.attach(
          "pool-accounts.png",
          "image/png",
          yield* browser.use("Capture synthetic pool Accounts", (page) =>
            page.screenshot({ fullPage: true }),
          ),
        );
        const healthy = yield* browser.use("Read a healthy host requirement", (page) =>
          page.getByRole("region", { name: /^Signalbox pool(?: \(pool\))?$/ }).count(),
        );
        expect(personal).not.toContain("Pool access");
        expect(healthy).toBe(0);
        for (const route of ["inventory", "resources"]) {
          const response = yield* api.request(actors.owner, "GET", `${prefix}/${route}`);
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          expect(
            JSON.stringify(
              (yield* body(Schema.Struct({ accounts: Schema.Array(Schema.Unknown) }), response))
                .accounts,
            ),
          ).not.toContain(account);
        }
        expect(
          (yield* api.request(actors.owner, "POST", `${path}/deploy`, { files: files(true, true) }))
            .status,
        ).toBe(200);
        const failed = yield* check();
        expect(failed.status, JSON.stringify(failed.body)).toBe(200);
        expect(JSON.stringify(failed.body)).toContain("Host access needs repair");
        yield* browser.use("Reload failed host access", (page) => page.reload());
        yield* browser.use("An editor sees the failed check", (page) =>
          page
            .getByRole("region", { name: /^Signalbox pool(?: \(pool\))?$/ })
            .getByText("Host access needs repair", { exact: true })
            .waitFor(),
        );
        yield* evidence.attach(
          "pool-broken-check.png",
          "image/png",
          yield* browser.use("Capture the failed requirement", (page) =>
            page.screenshot({ fullPage: true }),
          ),
        );
        yield* browser.login(actors.member);
        yield* browser.use("Open host access as a member", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`),
        );
        yield* browser.use("Wait for member Subscription", (page) =>
          page.getByRole("region", { name: /^Subscription(?: \(subscription\))?$/ }).waitFor(),
        );
        expect(
          yield* browser.use("Only editors see host repairs", (page) =>
            page.getByRole("region", { name: /^Signalbox pool(?: \(pool\))?$/ }).count(),
          ),
        ).toBe(0);
        yield* legacyStorage([
          {
            sql: "DELETE FROM hosted_app_account_links WHERE app = $1 AND requirement = 'pool'",
            params: [app.id],
          },
        ]);
        yield* serverControl("start");
        const choices = yield* api.request(actors.owner, "GET", `${path}/accounts/app/pool`);
        expect(choices.status, JSON.stringify(choices.body)).toBe(200);
        expect(
          (yield* body(Schema.Struct({ accounts: Schema.Array(Schema.Unknown) }), choices))
            .accounts,
        ).toEqual([]);
        yield* browser.login(actors.owner);
        yield* browser.use("Open missing host access as an editor", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`),
        );
        yield* browser.use("An editor sees missing host access", (page) =>
          page
            .getByRole("region", { name: /^Signalbox pool(?: \(pool\))?$/ })
            .getByText("Host-managed account missing. Ask the host administrator to restore it.", {
              exact: true,
            })
            .waitFor(),
        );
        yield* evidence.attach(
          "pool-unlinked.png",
          "image/png",
          yield* browser.use("Capture missing host access", (page) =>
            page.screenshot({ fullPage: true }),
          ),
        );
      }),
    ),
  );
});
