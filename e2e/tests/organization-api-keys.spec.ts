import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { Organization } from "../support/contracts.ts";

const Key = Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) });
const Keys = Schema.Struct({
  apiKeys: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.NullOr(Schema.String),
      metadata: Schema.NullOr(Schema.Struct({ organization: Schema.optional(Schema.String) })),
    }),
  ),
});
class Pending extends Error {}

layer(HostedLive, { excludeTestServices: true })("Organization API keys", (it) => {
  it.effect(scenarios.organizationApiKeys.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence;
        const anonymous = yield* api.session();
        const slug = `key-removal-${randomUUID().slice(0, 8)}`;
        const created = yield* api.request(actors.owner, "POST", "/api/auth/organization/create", {
          name: "Temporary key organization",
          slug,
          keepCurrentActiveOrganization: true,
        });
        expect(created.status).toBe(200);
        const organization = yield* body(Organization, created);
        const prefix = `/api/organizations/${organization.id}`;
        const lifecycle = "/api/auth/api-key";
        const keys: string[] = [];
        let removed = false;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const keyId of keys)
              yield* api.request(actors.owner, "POST", `${lifecycle}/delete`, { keyId });
            if (!removed) yield* api.request(actors.owner, "DELETE", prefix);
          }).pipe(Effect.orDie),
        );
        const create = (name: string, pin?: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${lifecycle}/create`, {
              name,
              ...(pin === undefined ? {} : { metadata: { organization: pin } }),
            });
            expect(response.status).toBe(200);
            const key = yield* body(Key, response);
            keys.push(key.id);
            return key;
          });
        const pinned = yield* create("Deleted organization token", organization.id);
        const other = yield* create("Remaining organization token", actors.organization.id);
        const full = yield* create("Full account token");
        const access = (key: typeof Key.Type, org: string) =>
          api.request(anonymous, "GET", `/api/organizations/${org}/access`, undefined, {
            authorization: `Bearer ${Redacted.value(key.key)}`,
          });
        expect((yield* access(pinned, organization.id)).status).toBe(200);
        const list = api
          .request(actors.owner, "GET", `${lifecycle}/list?limit=100`)
          .pipe(Effect.flatMap((response) => body(Keys, response)));
        yield* evidence.step(
          "The automatic Executor app key exists before removal",
          list.pipe(
            Effect.flatMap((page) =>
              page.apiKeys.some(
                (key) =>
                  key.name === "Executor app" && key.metadata?.organization === organization.id,
              )
                ? Effect.void
                : Effect.fail(new Pending()),
            ),
            Effect.retry({
              while: (error) => error instanceof Pending,
              schedule: Schedule.spaced("200 millis"),
            }),
            Effect.timeout("30 seconds"),
          ),
        );
        yield* browser.login(actors.owner);
        yield* browser.use("Open the temporary organization's settings", (page) =>
          page.goto(`/org/${slug}/organization`),
        );
        yield* browser.use("Open organization deletion", (page) =>
          page.getByRole("button", { name: "Delete organization", exact: true }).click(),
        );
        yield* browser.use("Confirm the organization handle", (page) =>
          page.getByLabel("Confirm organization URL", { exact: true }).fill(slug),
        );
        const status = yield* browser.use(
          "Delete the organization through its confirmation dialog",
          (page) =>
            Promise.all([
              page.waitForResponse(
                (response) =>
                  response.request().method() === "DELETE" &&
                  new URL(response.url()).pathname === prefix,
              ),
              page
                .getByRole("dialog")
                .getByRole("button", { name: "Delete organization", exact: true })
                .click(),
            ]).then(([response]) => response.status()),
        );
        expect(status).toBe(200);
        removed = true;
        yield* evidence.step(
          "Wait for the durable removal to delete native memberships",
          api.request(actors.owner, "GET", "/api/auth/organization/list").pipe(
            Effect.flatMap((response) => body(Schema.Array(Organization), response)),
            Effect.flatMap((remaining) =>
              remaining.some((item) => item.id === organization.id)
                ? Effect.fail(new Pending())
                : Effect.void,
            ),
            Effect.retry({
              while: (error) => error instanceof Pending,
              schedule: Schedule.spaced("200 millis"),
            }),
            Effect.timeout("60 seconds"),
          ),
        );
        yield* evidence.step(
          "All organization keys are gone and other keys still work",
          Effect.gen(function* () {
            const page = yield* list;
            expect(
              page.apiKeys.filter((key) => key.metadata?.organization === organization.id),
            ).toEqual([]);
            expect((yield* access(pinned, organization.id)).status).toBe(401);
            expect((yield* access(other, actors.organization.id)).status).toBe(200);
            expect((yield* access(full, actors.organization.id)).status).toBe(200);
          }),
        );
        yield* browser.use("Review keys from the remaining organization", (page) =>
          page.goto(`/org/${actors.organization.slug}/api-keys`),
        );
        yield* browser.use("The remaining organization's key is visible", (page) =>
          page.getByRole("row").filter({ hasText: "Remaining organization token" }).waitFor(),
        );
        yield* browser.use("The full-account key is visible", (page) =>
          page.getByRole("row").filter({ hasText: "Full account token" }).waitFor(),
        );
        expect(
          yield* browser.use("The deleted key is absent", (page) =>
            page.getByRole("row").filter({ hasText: "Deleted organization token" }).count(),
          ),
        ).toBe(0);
        expect(
          yield* browser.use("No orphaned organization is displayed", (page) =>
            page.getByText("Organization you left", { exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("API keys after organization deletion");
      }),
    ),
  );
});
