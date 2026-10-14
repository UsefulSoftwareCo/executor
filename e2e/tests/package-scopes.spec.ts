/** Public package names follow the publishing organization's current slug on executor.community. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Organization } from "../support/contracts.ts";
import { withApps } from "../support/apps-release.ts";

const Workspace = Schema.Struct({ revision: Schema.Struct({ commit: Schema.String }) });
const Publication = Schema.Struct({ name: Schema.String, commit: Schema.String });
/** Compared whole, so a changed readiness shape fails here. */
const Readiness = Schema.Struct({ publication: Schema.Unknown });
const Failure = Schema.Struct({ _tag: Schema.String, reason: Schema.String });
const Copy = Schema.Struct({
  id: Schema.String,
  copiedFrom: Schema.NullOr(
    Schema.Struct({ name: Schema.String, commit: Schema.NullOr(Schema.String) }),
  ),
});

const scope = (slug: string) => `${slug}.executor.community`;

layer(HostedLive, { excludeTestServices: true })("Package scopes", (it) => {
  it.effect(scenarios.packageScopes.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const suffix = randomUUID().slice(0, 8);
        const label = `notes-${suffix}`;
        const firstSlug = `scopes-${suffix}`,
          renamedSlug = `scopes-renamed-${suffix}`;
        const firstName = `@${scope(firstSlug)}/${label}`,
          renamedName = `@${scope(renamedSlug)}/${label}`;

        const organization = (slug: string) =>
          Effect.gen(function* () {
            const created = yield* body(
              Organization,
              yield* api.request(actors.owner, "POST", "/api/auth/organization/create", {
                name: `Package scopes ${slug}`,
                slug,
                keepCurrentActiveOrganization: true,
              }),
            );
            yield* Effect.addFinalizer(() =>
              api
                .request(actors.owner, "DELETE", `/api/organizations/${created.id}`)
                .pipe(Effect.asVoid, Effect.orDie),
            );
            return created;
          });
        /** Deploy an app whose package.json carries `name`, and return it with its commit. */
        const deploy = (organizationId: string, name: string, marker: string) =>
          Effect.gen(function* () {
            const prefix = `/api/organizations/${organizationId}`;
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `Scoped ${marker}`,
              files: [
                {
                  path: "index.ts",
                  content: `import { defineApp } from "apps";\n// ${marker}\nexport default defineApp({}, {});\n`,
                },
                {
                  path: "package.json",
                  content: JSON.stringify({ name, description: marker, dependencies: withApps() }),
                },
              ],
            });
            expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
            const app = yield* body(App, deployed);
            yield* Effect.addFinalizer(() =>
              api
                .request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`)
                .pipe(Effect.asVoid, Effect.orDie),
            );
            const working = yield* api.request(
              actors.owner,
              "GET",
              `${prefix}/apps/${app.id}/workspace`,
            );
            expect(working.status, JSON.stringify(working.body)).toBe(200);
            return { app, commit: (yield* body(Workspace, working)).revision.commit };
          });
        const publish = (organizationId: string, app: string, commit: string) =>
          api.request(
            actors.owner,
            "POST",
            `/api/organizations/${organizationId}/apps/${app}/publication`,
            { commit },
          );
        const readiness = (organizationId: string, app: string) =>
          api
            .request(
              actors.owner,
              "GET",
              `/api/organizations/${organizationId}/apps/${app}/workspace/display`,
            )
            .pipe(Effect.flatMap((response) => body(Readiness, response)));
        const listed = (organizationId: string, name: string) =>
          api
            .request(
              actors.owner,
              "GET",
              `/api/organizations/${organizationId}/app-publications?name=${encodeURIComponent(name)}`,
            )
            .pipe(Effect.flatMap((response) => body(Schema.Array(Publication), response)));
        const owned = (organizationId: string) =>
          api
            .request(
              actors.owner,
              "GET",
              `/api/organizations/${organizationId}/app-publications/published`,
            )
            .pipe(Effect.flatMap((response) => body(Schema.Array(Publication), response)));

        // An organization publishes under its own slug on executor.community.
        const first = yield* organization(firstSlug);
        const original = yield* deploy(first.id, firstName, `first ${suffix}`);
        expect((yield* readiness(first.id, original.app.id)).publication).toEqual({
          status: "ready",
          manifest: { name: firstName, description: `first ${suffix}` },
        });
        const published = yield* publish(first.id, original.app.id, original.commit);
        expect(published.status, JSON.stringify(published.body)).toBe(200);
        expect(yield* body(Publication, published)).toMatchObject({
          name: firstName,
          commit: original.commit,
        });
        expect(yield* listed(first.id, firstName)).toMatchObject([
          { name: firstName, commit: original.commit },
        ]);

        // Another organization's scope is refused, and the repair keeps the label.
        const foreign = yield* deploy(
          actors.organization.id,
          `@${scope(firstSlug)}/foreign-${suffix}`,
          `foreign ${suffix}`,
        );
        expect((yield* readiness(actors.organization.id, foreign.app.id)).publication).toEqual({
          status: "blocked",
          issue: {
            _tag: "PublicationIssue",
            reason: "forbidden-scope",
            name: `@${scope(firstSlug)}/foreign-${suffix}`,
          },
          suggestedName: `@${scope(actors.organization.slug)}/foreign-${suffix}`,
        });
        const refused = yield* publish(actors.organization.id, foreign.app.id, foreign.commit);
        expect(refused.status).toBe(400);
        expect(yield* body(Failure, refused)).toEqual({
          _tag: "RegistryError",
          reason: "forbidden",
        });

        // A rename moves every listing to the new slug at once. The old name stops resolving.
        const renamed = yield* api.request(actors.owner, "POST", "/api/auth/organization/update", {
          organizationId: first.id,
          data: { slug: renamedSlug },
        });
        expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
        expect(yield* listed(first.id, renamedName)).toMatchObject([
          { name: renamedName, commit: original.commit },
        ]);
        expect(yield* listed(first.id, firstName)).toEqual([]);
        expect(yield* owned(first.id)).toMatchObject([{ name: renamedName }]);

        // A commit published before the rename still installs under the new name, although its
        // package.json keeps the old one.
        const copied = yield* api.request(
          actors.owner,
          "POST",
          `/api/organizations/${actors.organization.id}/apps/copies`,
          { from: { package: renamedName, commit: original.commit }, name: `Copy ${suffix}` },
        );
        expect(copied.status, JSON.stringify(copied.body)).toBe(200);
        const copy = yield* body(Copy, copied);
        yield* Effect.addFinalizer(() =>
          api
            .request(
              actors.owner,
              "DELETE",
              `/api/organizations/${actors.organization.id}/apps/${copy.id}`,
            )
            .pipe(Effect.asVoid, Effect.orDie),
        );
        expect(copy.copiedFrom).toEqual({ name: renamedName, commit: original.commit });

        // Republishing needs the new scope; the repair offers it with the same label.
        expect((yield* readiness(first.id, original.app.id)).publication).toEqual({
          status: "blocked",
          issue: { _tag: "PublicationIssue", reason: "forbidden-scope", name: firstName },
          suggestedName: renamedName,
        });
        expect((yield* publish(first.id, original.app.id, original.commit)).status).toBe(400);

        // The released slug is free. Its next holder publishes the same label as its own
        // listing, and the renamed organization's listing is unchanged.
        const second = yield* organization(firstSlug);
        const successor = yield* deploy(second.id, firstName, `second ${suffix}`);
        const claimed = yield* publish(second.id, successor.app.id, successor.commit);
        expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
        expect(yield* listed(second.id, firstName)).toMatchObject([
          { name: firstName, commit: successor.commit },
        ]);
        expect(yield* listed(second.id, renamedName)).toMatchObject([
          { name: renamedName, commit: original.commit },
        ]);
        expect(yield* owned(second.id)).toMatchObject([{ name: firstName }]);
        expect(yield* owned(first.id)).toMatchObject([{ name: renamedName }]);

        for (const [organizationId, name] of [
          [first.id, renamedName],
          [second.id, firstName],
        ] as const) {
          const removed = yield* api.request(
            actors.owner,
            "POST",
            `/api/organizations/${organizationId}/app-publications/unpublish`,
            { package: name },
          );
          expect(removed.status, JSON.stringify(removed.body)).toBe(200);
        }
        expect(yield* listed(first.id, renamedName)).toEqual([]);
      }),
    ),
  );
});
