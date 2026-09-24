import { managementApp } from "../support/management-app.ts";
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";

const Key = Schema.Struct({
  key: Schema.RedactedFromValue(Schema.NonEmptyString),
  id: Schema.String,
});
const List = Schema.Struct({
  apiKeys: Schema.Array(
    Schema.Struct({ id: Schema.String, lastRequest: Schema.NullOr(Schema.String) }),
  ),
  total: Schema.Number,
});
const source = [
  {
    path: "index.ts",
    content: `
import { defineApp, mutation, object } from "apps";
import { always } from "apps/operations/approval";
export default defineApp({ accounts: {} }, async () => ({  mutations: {
  echo: mutation({ description: "Return a receipt", input: object({}) }, async () => ({ receipt: "pat-ok" })),
  approved: mutation({ description: "Needs approval", input: object({}), approval: always() }, async () => ({ receipt: "should-not-run" })),
} }));`,
  },
];

layer(HostedLive, { excludeTestServices: true })("Personal access tokens", (it) => {
  it.effect(scenarios.namedApiKeys.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence;
        const anonymous = yield* api.session();
        const organization = actors.organization.id;
        const prefix = `/api/organizations/${organization}`;
        const lifecycle = "/api/auth/api-key";
        const ownedKeys: { session: Session; id: string }[] = [];
        let appId: string | undefined;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const key of ownedKeys)
              yield* api.request(key.session, "POST", `${lifecycle}/delete`, { keyId: key.id });
            if (appId !== undefined)
              yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${appId}`);
          }).pipe(Effect.orDie),
        );
        const create = (actor: Session, expiresIn?: number) =>
          Effect.gen(function* () {
            const input = { name: "PAT test", ...(expiresIn === undefined ? {} : { expiresIn }) };
            const response = yield* api.request(actor, "POST", `${lifecycle}/create`, input);
            expect(response.status).toBe(200);
            const key = yield* body(Key, response);
            ownedKeys.push({ session: actor, id: key.id });
            return { ...key, input };
          });
        const headers = (key: Redacted.Redacted<string>) => ({
          authorization: `Bearer ${Redacted.value(key)}`,
        });
        const owner = yield* create(actors.owner);
        const other = yield* create(actors.owner);
        const memberToken = yield* create(actors.member);
        yield* evidence.step(
          "PATs are personal and cannot silently accept old permission requests",
          Effect.gen(function* () {
            expect(
              (yield* api.request(anonymous, "POST", `${lifecycle}/create`, {
                ...owner.input,
              })).status,
            ).toBe(401);
            expect(
              (yield* api.request(actors.owner, "POST", `${lifecycle}/create`, {
                ...owner.input,
                permissions: ["read"],
              })).status,
            ).toBe(400);
            expect(
              (yield* api.request(actors.owner, "POST", `${lifecycle}/create`, {
                ...owner.input,
                organization,
              })).status,
            ).toBe(400);
            expect(
              (yield* api.request(
                anonymous,
                "POST",
                `${lifecycle}/create`,
                owner.input,
                headers(owner.key),
              )).status,
            ).toBe(403);
            expect(
              (yield* api.request(
                actors.owner,
                "GET",
                `${lifecycle}/list?offset=0`,
                undefined,
                headers(owner.key),
              )).status,
            ).toBe(403);
            expect(
              (yield* api.request(actors.member, "POST", `${lifecycle}/delete`, {
                keyId: owner.id,
              })).status,
            ).toBe(404);
            const listed = yield* api.request(actors.owner, "GET", `${lifecycle}/list?offset=0`);
            expect(JSON.stringify(listed.body).includes(Redacted.value(owner.key))).toBe(false);
            const rows = yield* body(
              Schema.Struct({
                apiKeys: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
              }),
              listed,
            );
            expect(
              rows.apiKeys.every((row) =>
                ["hash", "key", "organizationId"].every((field) => !Object.hasOwn(row, field)),
              ),
            ).toBe(true);
            const memberList = yield* body(
              List,
              yield* api.request(actors.member, "GET", `${lifecycle}/list?offset=0`),
            );
            expect(memberList.apiKeys.some((key) => key.id === owner.id)).toBe(false);
            expect(
              (yield* api.request(actors.owner, "POST", `${lifecycle}/create`, owner.input, {
                origin: "https://foreign.example.test",
              })).status,
            ).toBe(403);
            expect(
              (yield* api.request(
                anonymous,
                "GET",
                `${prefix}/inventory`,
                undefined,
                headers(owner.key),
              )).status,
            ).toBe(200);
            expect(
              (yield* api.request(
                anonymous,
                "GET",
                "/api/organizations/other/inventory",
                undefined,
                headers(owner.key),
              )).status,
            ).toBe(403);
            for (const prefix of ["exp_", "exk_"])
              expect(
                (yield* api.request(
                  actors.owner,
                  "GET",
                  `/api/organizations/${organization}/inventory`,
                  undefined,
                  { authorization: `Bearer ${prefix}${"x".repeat(43)}` },
                )).status,
              ).toBe(401);
            expect(
              (yield* api.request(anonymous, "GET", "/api/viewer", undefined, headers(owner.key)))
                .status,
            ).toBe(401);
            expect(
              (yield* api.request(actors.owner, "POST", `${lifecycle}/create`, {
                ...owner.input,
                expiresIn: -1,
              })).status,
            ).toBe(400);
          }),
        );
        const deployed = yield* api.request(
          anonymous,
          "POST",
          `${prefix}/apps/deploy`,
          { name: `PAT fixture ${randomUUID().slice(0, 8)}`, files: source },
          headers(owner.key),
        );
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        appId = app.id;
        yield* evidence.step(
          "A PAT inherits the user's current role and retains tool approvals",
          Effect.gen(function* () {
            const path = `${prefix}/apps/${app.id}/tools/call`;
            const input = { tool: "mutations.echo", input: {} };
            const response = yield* api.request(anonymous, "POST", path, input, headers(owner.key));
            expect(response.status).toBe(200);
            expect(response.body).toEqual({ receipt: "pat-ok" });
            expect(
              (yield* api.request(
                anonymous,
                "GET",
                `${prefix}/inventory`,
                undefined,
                headers(memberToken.key),
              )).status,
            ).toBe(200);
            expect(
              (yield* api.request(anonymous, "POST", path, input, headers(memberToken.key))).status,
            ).toBe(403);
            expect(
              (yield* api.request(
                anonymous,
                "GET",
                `${prefix}/apps/${app.id}/workspace`,
                undefined,
                headers(memberToken.key),
              )).status,
            ).toBe(403);
            const approved = yield* api.request(
              anonymous,
              "POST",
              path,
              { tool: "mutations.approved", input: {} },
              headers(owner.key),
            );
            expect(approved.status).not.toBe(200);
            expect(yield* body(Schema.Struct({ _tag: Schema.String }), approved)).toEqual({
              _tag: "ToolApprovalRequired",
            });
            const { app: executor, profile } = yield* managementApp(actors.owner);
            const context = yield* api.request(
              anonymous,
              "POST",
              `${prefix}/apps/${executor.id}/tools/call`,
              { tool: "queries.context_get", profile: profile.id, input: {} },
              headers(owner.key),
            );
            expect(context.status).toBe(200);
          }),
        );
        yield* evidence.step(
          "Role changes, expiry and independent revocation take effect",
          Effect.gen(function* () {
            const admin = yield* create(actors.admin);
            const members = yield* body(
              Schema.Struct({
                members: Schema.Array(Schema.Struct({ id: Schema.String, role: Schema.String })),
              }),
              yield* api.request(
                actors.owner,
                "GET",
                `/api/auth/organization/list-members?organizationId=${organization}`,
              ),
            );
            const member = members.members.find((entry) => entry.role === "admin");
            if (member === undefined) return yield* Effect.fail(new Error("Admin fixture missing"));
            yield* Effect.acquireUseRelease(
              api.request(actors.owner, "POST", "/api/auth/organization/update-member-role", {
                organizationId: organization,
                memberId: member.id,
                role: "member",
              }),
              () =>
                api
                  .request(
                    anonymous,
                    "POST",
                    `${prefix}/apps/${app.id}/tools/call`,
                    { tool: "mutations.echo", input: {} },
                    headers(admin.key),
                  )
                  .pipe(
                    Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(403))),
                  ),
              () =>
                api
                  .request(actors.owner, "POST", "/api/auth/organization/update-member-role", {
                    organizationId: organization,
                    memberId: member.id,
                    role: "admin",
                  })
                  .pipe(Effect.orDie),
            );
            const expiring = yield* create(actors.owner, 2);
            expect(
              (yield* api.request(
                anonymous,
                "GET",
                `${prefix}/inventory`,
                undefined,
                headers(expiring.key),
              )).status,
            ).toBe(200);
            yield* Effect.sleep("2100 millis");
            expect(
              (yield* api.request(
                anonymous,
                "GET",
                `${prefix}/inventory`,
                undefined,
                headers(expiring.key),
              )).status,
            ).toBe(401);
            for (const expected of [200, 404])
              expect(
                (yield* api.request(actors.owner, "POST", `${lifecycle}/delete`, {
                  keyId: owner.id,
                })).status,
              ).toBe(expected);
            expect(
              (yield* api.request(
                anonymous,
                "GET",
                `${prefix}/inventory`,
                undefined,
                headers(owner.key),
              )).status,
            ).toBe(401);
            expect(
              (yield* api.request(
                anonymous,
                "GET",
                `${prefix}/inventory`,
                undefined,
                headers(other.key),
              )).status,
            ).toBe(200);
            const list = yield* body(
              List,
              yield* api.request(actors.owner, "GET", `${lifecycle}/list?offset=0`),
            );
            expect(list.apiKeys.find((key) => key.id === other.id)?.lastRequest).toBeTypeOf(
              "string",
            );
          }),
        );
        yield* browser.omitNetworkTrace;
        yield* browser.login(actors.owner);
        yield* browser.use("Open API key settings", (page) =>
          page.goto(`/org/${actors.organization.slug}/api-keys`),
        );
        yield* browser.use("Start key creation", (page) =>
          page.getByRole("button", { name: "Create token", exact: true }).click(),
        );
        expect(
          yield* browser.use("PAT creation has no permission choices", (page) =>
            page.getByRole("dialog").getByRole("checkbox").count(),
          ),
        ).toBe(0);
        yield* browser.use("Name the key", (page) =>
          page.getByLabel("Name", { exact: true }).fill("Browser automation"),
        );
        let intercepted = false;
        yield* browser.use("Fail the next creation request at the HTTP boundary", (page) =>
          page.route(
            "**/api/auth/api-key/create",
            (route) => {
              intercepted = true;
              return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
            },
            { times: 1 },
          ),
        );
        yield* browser.use("Submit the draft", (page) =>
          page.getByRole("button", { name: "Create token", exact: true }).click(),
        );
        yield* browser.use("Creation failure is visible", (page) =>
          page.getByRole("alert").filter({ hasText: "Could not create the token" }).waitFor(),
        );
        expect(intercepted).toBe(true);
        expect(
          yield* browser.use("Failed creation preserves the draft", (page) =>
            page.getByLabel("Name", { exact: true }).inputValue(),
          ),
        ).toBe("Browser automation");
        yield* browser.use("Retry creates the real key", (page) =>
          page.getByRole("button", { name: "Create token", exact: true }).click(),
        );
        yield* browser.use("The secret is shown once", (page) =>
          page.getByRole("heading", { name: "Save your token" }).waitFor(),
        );
        const browserKey = yield* browser.use("Read the masked key privately", (page) =>
          page.getByLabel("New token").inputValue().then(Redacted.make),
        );
        expect(
          (yield* api.request(
            anonymous,
            "GET",
            `${prefix}/inventory`,
            undefined,
            headers(browserKey),
          )).status,
        ).toBe(200);
        yield* browser.use("Close the secret dialog", (page) =>
          page.getByRole("button", { name: "Done", exact: true }).click(),
        );
        expect(
          yield* browser.use("The secret is no longer displayed", (page) =>
            page.getByLabel("New token").count(),
          ),
        ).toBe(0);
        yield* browser.use("Refresh usage", (page) =>
          page.getByRole("button", { name: "Refresh", exact: true }).click(),
        );
        yield* browser.use("Select the key to revoke", (page) =>
          page.getByRole("button", { name: "Revoke Browser automation", exact: true }).click(),
        );
        expect(
          yield* browser.use("Confirm revocation and wait for acceptance", (page) =>
            Promise.all([
              page.waitForResponse(
                (response) =>
                  response.request().method() === "POST" &&
                  new URL(response.url()).pathname === `${lifecycle}/delete`,
              ),
              page.getByRole("button", { name: "Revoke token", exact: true }).click(),
            ]).then(([response]) => response.status()),
          ),
        ).toBe(200);
        yield* browser.use("Revocation is visible", (page) =>
          page
            .getByRole("row")
            .filter({ hasText: "Browser automation" })
            .waitFor({ state: "detached" }),
        );
        yield* browser.use("Reload settings", (page) => page.reload());
        yield* browser.use("Revocation persists", (page) =>
          page
            .getByRole("row")
            .filter({ hasText: "Browser automation" })
            .waitFor({ state: "detached" }),
        );
        expect(
          (yield* api.request(
            anonymous,
            "GET",
            `${prefix}/inventory`,
            undefined,
            headers(browserKey),
          )).status,
        ).toBe(401);
        yield* browser.checkpoint("API keys after revocation");
      }),
    ),
  );
});
