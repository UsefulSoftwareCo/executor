import { createProfile, Profile } from "../support/profiles.ts";
import { holdOrganizationEntry } from "../support/organization-entry.ts";
import { scenarios } from "../test-plan.ts";
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Result, Schedule, Schema } from "effect";
import { Api, body } from "../support/api.ts";
import { Actors, password } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource, Inventory } from "../support/contracts.ts";

const files = [
  {
    path: "index.ts",
    content: `
import { mutation, defineApp, defineProvider, secrets, object, string } from "apps";
const service=defineProvider({name:"Evidence service",auth:{key:secrets({label:"API key",fields:object({token:string()})})}});
export default defineApp({accounts:{service:service.many()}},async()=>({mutations:{echo:mutation({description:"Return input",input:object({message:string()})},async(_,input)=>({message:input.message}))}}));
`,
  },
];
layer(HostedLive, { excludeTestServices: true })("Self-host", (it) => {
  it.effect(scenarios.password.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          browser = yield* Browser;
        for (const role of ["owner", "member"] as const) {
          yield* browser.use("Clear the previous browser session", (page) =>
            page.context().clearCookies(),
          );
          yield* browser.use("Open password sign-in", (page) => page.goto("/login"));
          yield* browser.use("Enter synthetic email", (page) =>
            page.getByLabel("Email", { exact: true }).fill(`${role}@example.test`),
          );
          yield* browser.use("Enter synthetic password", (page) =>
            page.getByLabel("Password", { exact: true }).fill(password),
          );
          const list = yield* holdOrganizationEntry;
          yield* browser.use("Sign in", (page) =>
            page.getByRole("button", { name: "Sign in", exact: true }).click(),
          );
          yield* list.requested;
          expect(
            yield* browser.use(
              "Resolve the password sign-in destination before navigating",
              (page) => Promise.resolve(new URL(page.url()).pathname),
            ),
          ).toBe("/login");
          expect(
            yield* browser.use("Password sign-in shows the shared dashboard skeleton", (page) =>
              page.locator(".shell").count(),
            ),
          ).toBe(1);
          yield* browser.use("Password sign-in loads apps in place", (page) =>
            page
              .getByRole("status", { name: "Loading apps", exact: true })
              .waitFor({ state: "visible" }),
          );
          yield* list.release;
          yield* browser.use("Return to the organization", (page) =>
            page.waitForURL(`**/org/${actors.organization.slug}/apps`),
          );
          yield* browser.use(`${role} has the correct Add permission`, (page) =>
            page.getByRole("link", { name: "Add app", exact: true }).waitFor({ state: "visible" }),
          );
          yield* browser.checkpoint(`${role} signed in through self-host password login`);
        }
      }),
    ),
  );
  it.effect(scenarios.scale.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          browser = yield* Browser,
          evidence = yield* Evidence,
          target = yield* Target;
        const count = target.rows,
          prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "Scale checks",
          files,
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        const access = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${app.id}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        yield* browser.login(actors.owner);
        yield* browser.use("Open account inventory", (page) =>
          page.goto(`/org/${actors.organization.slug}/accounts`),
        );
        const ids = yield* evidence.step(
          `Save ${count} accounts with four concurrent writers`,
          Effect.forEach(
            Array.from({ length: count }, (_, row) => row),
            (row) =>
              Effect.gen(function* () {
                const actor = row % 2 === 0 ? actors.owner : actors.admin;
                const profile = yield* createProfile(actor, `${prefix}/apps/${app.id}`);
                const connection = yield* api.request(
                  actor,
                  "POST",
                  `${prefix}/apps/${app.id}/connections`,
                  {
                    requirement: "service",
                    profile: profile.id,
                    destination: { kind: "shared", audience: { kind: "everyone" } },
                  },
                );
                expect(connection.status).toBe(200);
                const { id } = yield* body(Resource, connection);
                const saved = yield* api.request(
                  actor,
                  "POST",
                  `${prefix}/connections/${id}/submit`,
                  {
                    method: "key",
                    label: `Scale account ${row}`,
                    fields: { token: `synthetic-${row}` },
                  },
                );
                expect(saved.status).toBe(200);
                const account = (yield* body(Resource, saved)).id;
                const selected = yield* body(
                  Profile,
                  yield* api.request(
                    actor,
                    "GET",
                    `${prefix}/apps/${app.id}/profiles/${profile.id}`,
                  ),
                );
                expect(selected.accounts.service).toEqual([account]);
                return account;
              }),
            { concurrency: 4 },
          ),
        );
        yield* evidence.step(
          "Every record and selection survives an independent read",
          Effect.gen(function* () {
            expect(new Set(ids).size).toBe(count);
            const start = yield* Clock.currentTimeMillis;
            const response = yield* api.request(actors.member, "GET", `${prefix}/inventory`);
            expect(response.status).toBe(200);
            const inventory = yield* body(Inventory, response),
              saved = inventory.accounts.filter((account) =>
                account.label.startsWith("Scale account "),
              );
            expect(saved.map((account) => account.id).sort()).toEqual([...ids].sort());
            expect(saved.map((account) => account.label).sort()).toEqual(
              Array.from({ length: count }, (_, row) => `Scale account ${row}`).sort(),
            );
            expect((yield* Clock.currentTimeMillis) - start, "inventory read budget").toBeLessThan(
              5000,
            );
          }),
        );
        yield* browser.use("Reload the large inventory", (page) => page.reload());
        yield* browser.use("The saved accounts are visible", (page) =>
          page.getByText("Scale account 0", { exact: true }).waitFor({ state: "visible" }),
        );
        yield* browser.checkpoint("Large account inventory ready for manual use");
      }),
    ),
  );
  it.effect(scenarios.telemetry.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry;
        const response = yield* api.request(
          actors.owner,
          "GET",
          `/api/organizations/${actors.organization.id}/inventory`,
        );
        expect(response.status).toBe(200);
        const request = (yield* evidence.requests).at(-1);
        if (!request) return yield* Effect.die(new Error("Request evidence missing"));
        const delivered = telemetry
          .query(request.traceId)
          .pipe(
            Effect.flatMap((value) =>
              value.data.some(
                (entry) =>
                  entry.traceId === request.traceId &&
                  entry.span.serviceName === "executor-selfhost" &&
                  entry.span.tags["url.path"] ===
                    `/api/organizations/${actors.organization.id}/inventory` &&
                  entry.span.tags["http.request.method"] === "GET" &&
                  entry.span.tags["http.response.status_code"] === "200",
              )
                ? Effect.succeed(value)
                : Effect.fail(new Error("The actual HTTP server span must reach Motel")),
            ),
          );
        const result = yield* delivered.pipe(
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
          Effect.timeout("20 seconds"),
          Effect.result,
        );
        expect(
          Result.isSuccess(result),
          "The actual HTTP server span must reach Motel within 20 seconds",
        ).toBe(true);
        if (Result.isFailure(result)) return yield* Effect.fail(result.failure);
        const queries = result.success.data.filter(
          (entry) => entry.span.operationName === "sql.execute",
        );
        expect(queries.length).toBeGreaterThan(0);
      }),
    ),
  );
});
