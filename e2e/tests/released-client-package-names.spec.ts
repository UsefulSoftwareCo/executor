import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body, currentClient, releasedClient } from "../support/api.ts";
import { withApps } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Organization } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";
import {
  releasedCatalog,
  releasedHostAnswer,
  releasedInstall,
  releasedSourceView,
} from "../support/release-f5f3256ab.ts";
import {
  releasedCatalog as beta16Catalog,
  releasedInstall as beta16Install,
} from "../support/release-6ba6219e6.ts";
import { rawRequest, targetHosts } from "../support/role-hosts.ts";

const Workspace = Schema.Struct({
  revision: Schema.Struct({ commit: Schema.String }),
  publication: Schema.Unknown,
});
const Publication = Schema.Struct({ name: Schema.String, commit: Schema.String });
const Copy = Schema.Struct({
  id: Schema.String,
  copiedFrom: Schema.NullOr(
    Schema.Struct({ name: Schema.String, commit: Schema.NullOr(Schema.String) }),
  ),
});
const Failure = Schema.Struct({ _tag: Schema.String, reason: Schema.String });
const fullNameRequired = (
  response: { readonly status: number; readonly body: unknown },
  name: string,
  fullName: string,
) =>
  Effect.gen(function* () {
    const failure = yield* releasedHostAnswer(response.status, response.body);
    expect(failure).toMatchObject({ code: "FullListingNameRequired", status: 400 });
    expect(failure.message).toContain(`${name} is the short form of a public listing's name.`);
    expect(failure.message).toContain("so nothing was removed.");
    expect(failure.recovery?.action).toContain(`Remove ${fullName} instead.`);
    expect(failure.recovery?.action).toContain("npm i -g executor@beta --include=optional");
    expect(failure.recovery?.instructions).toContain(
      `executor apps unpublish --package ${fullName}`,
    );
    expect(failure.recovery?.instructions).toContain("executor-wire-revision: 1");
  });

layer(HostedLive, { excludeTestServices: true })("Released client package names", (it) => {
  it.effect(scenarios.releasedClientPackageNames.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const hosts = targetHosts(yield* Target);
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const label = `released-${randomUUID().slice(0, 8)}`;
        const name = `@${actors.organization.slug}.executor.community/${label}`;
        const releasedName = `@${actors.organization.slug}/${label}`;

        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Released ${label}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp } from "apps";\nexport default defineApp({}, {});\n`,
            },
            {
              path: "package.json",
              content: JSON.stringify({ name, description: label, dependencies: withApps() }),
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
        const workspace = (client: Record<string, string>) =>
          api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/workspace`, undefined, client);

        const released = yield* workspace(releasedClient);
        expect(released.status, JSON.stringify(released.body)).toBe(200);
        const view = yield* releasedSourceView(released.body);
        expect(view.publication).toBeNull();
        const current = yield* body(Workspace, yield* workspace(currentClient));
        expect(current.publication).toEqual({
          status: "ready",
          manifest: { name, description: label },
        });
        const commit = current.revision.commit;

        const published = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${app.id}/publication`,
          { commit },
        );
        expect(published.status, JSON.stringify(published.body)).toBe(200);
        expect(yield* body(Publication, published)).toEqual({ name, commit });
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", `${prefix}/app-publications/unpublish`, {
              package: name,
            })
            .pipe(Effect.asVoid, Effect.orDie),
        );

        const registry = (path: string, headers: Record<string, string> = {}) =>
          rawRequest(`${hosts.api}${path}`, { headers }).pipe(
            Effect.tap((response) =>
              Effect.sync(() => expect(response.status, response.text).toBe(200)),
            ),
            Effect.map((response): unknown => JSON.parse(response.text)),
          );
        const catalog = yield* releasedCatalog(yield* registry("/api/registry/apps"));
        expect(catalog).toContainEqual(expect.objectContaining({ name: releasedName, commit }));
        expect(
          yield* releasedCatalog(
            yield* registry(`/api/registry/apps?name=${encodeURIComponent(releasedName)}`),
          ),
        ).toMatchObject([{ name: releasedName, commit }]);
        const listed = yield* registry(
          `/api/registry/apps?name=${encodeURIComponent(name)}`,
          currentClient,
        );
        expect(yield* Schema.decodeUnknownEffect(Schema.Array(Publication))(listed)).toEqual([
          { name, commit },
        ]);

        const source = yield* registry(
          `/api/registry/source?name=${encodeURIComponent(releasedName)}&commit=${commit}`,
        );
        expect(yield* Effect.flip(releasedInstall(source, releasedName, commit))).toBe(
          "invalid-manifest",
        );
        for (const sent of [name, releasedName]) {
          expect(
            yield* beta16Catalog(
              yield* registry(`/api/registry/apps?name=${encodeURIComponent(sent)}`),
            ),
          ).toMatchObject([{ name: sent, commit }]);
          const read = yield* registry(
            `/api/registry/source?name=${encodeURIComponent(sent)}&commit=${commit}`,
          );
          expect(yield* beta16Install(read, sent, commit)).toBe(2);
        }

        const copied = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/copies`,
          { from: { package: releasedName, commit }, name: `Copy ${label}` },
          releasedClient,
        );
        expect(copied.status, JSON.stringify(copied.body)).toBe(200);
        const copy = yield* body(Copy, copied);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/apps/${copy.id}`)
            .pipe(Effect.asVoid, Effect.orDie),
        );

        const releasedRead = (path: string) =>
          api
            .request(actors.owner, "GET", `${prefix}${path}`, undefined, releasedClient)
            .pipe(Effect.flatMap((response) => releasedCatalog(response.body)));
        expect(
          yield* releasedRead(`/app-publications?name=${encodeURIComponent(releasedName)}`),
        ).toMatchObject([{ name: releasedName, commit }]);
        expect(yield* releasedRead("/app-publications/published")).toContainEqual(
          expect.objectContaining({ name: releasedName, commit }),
        );
        expect(
          yield* api
            .request(
              actors.owner,
              "GET",
              `${prefix}/app-publications?name=${encodeURIComponent(name)}`,
              undefined,
              releasedClient,
            )
            .pipe(Effect.flatMap((response) => beta16Catalog(response.body))),
        ).toMatchObject([{ name, commit }]);
        const refused = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/app-publications/unpublish`,
          { package: releasedName },
          releasedClient,
        );
        yield* fullNameRequired(refused, releasedName, name);
        expect(
          yield* api.request(
            actors.owner,
            "GET",
            `${prefix}/app-publications?name=${encodeURIComponent(name)}`,
          ),
        ).toMatchObject({ status: 200, body: [{ name, commit }] });
      }),
    ),
  );

  it.effect(scenarios.releasedClientWriteBinding.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const hosts = targetHosts(yield* Target);
        const api = yield* Api,
          actors = yield* Actors;
        const suffix = randomUUID().slice(0, 8);
        const label = `bound-${suffix}`;
        const slug = `bound-${suffix}`,
          renamedSlug = `bound-renamed-${suffix}`;
        const name = `@${slug}.executor.community/${label}`,
          renamedName = `@${renamedSlug}.executor.community/${label}`;
        const shown = `@${slug}/${label}`;
        const home = `/api/organizations/${actors.organization.id}`;

        const organization = (organizationSlug: string) =>
          Effect.gen(function* () {
            const created = yield* body(
              Organization,
              yield* api.request(actors.owner, "POST", "/api/auth/organization/create", {
                name: `Write binding ${organizationSlug}`,
                slug: organizationSlug,
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
        const publishApp = (organizationId: string, marker: string) =>
          Effect.gen(function* () {
            const prefix = `/api/organizations/${organizationId}`;
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `Bound ${marker}`,
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
            const { revision } = yield* body(
              Workspace,
              yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/workspace`),
            );
            const published = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/apps/${app.id}/publication`,
              { commit: revision.commit },
            );
            expect(published.status, JSON.stringify(published.body)).toBe(200);
            expect(yield* body(Publication, published)).toEqual({ name, commit: revision.commit });
            return revision.commit;
          });
        const listed = (listing: string) =>
          api
            .request(
              actors.owner,
              "GET",
              `${home}/app-publications?name=${encodeURIComponent(listing)}`,
            )
            .pipe(Effect.flatMap((response) => body(Schema.Array(Publication), response)));
        const shownListings = api
          .request(
            actors.owner,
            "GET",
            `${home}/app-publications?name=${encodeURIComponent(shown)}`,
            undefined,
            releasedClient,
          )
          .pipe(Effect.flatMap((response) => releasedCatalog(response.body)));
        const unpublish = (organizationId: string, client: Record<string, string>, pkg: string) =>
          api.request(
            actors.owner,
            "POST",
            `/api/organizations/${organizationId}/app-publications/unpublish`,
            { package: pkg },
            client,
          );
        const failure = (response: { readonly status: number; readonly body: unknown }) => {
          expect(response.status, JSON.stringify(response.body)).toBe(400);
          return body(Failure, response);
        };
        const refusedRemoval = (organizationId: string) =>
          Effect.flatMap(unpublish(organizationId, releasedClient, shown), (refused) =>
            fullNameRequired(refused, shown, name),
          );
        const refusedCopy = (commit: string, reason: string) =>
          Effect.gen(function* () {
            const copyName = `Stale ${reason} ${suffix}`;
            const copied = yield* api.request(
              actors.owner,
              "POST",
              `${home}/apps/copies`,
              { from: { package: shown, commit }, name: copyName },
              releasedClient,
            );
            expect(yield* failure(copied)).toEqual({ _tag: "RegistryError", reason });
            const apps = yield* body(
              Schema.Array(App),
              yield* api.request(actors.owner, "GET", `${home}/apps`),
            );
            expect(apps.map((app) => app.name)).not.toContain(copyName);
          });
        const sourceFailure = (commit: string) =>
          rawRequest(
            `${hosts.api}/api/registry/source?name=${encodeURIComponent(shown)}&commit=${commit}`,
          ).pipe(
            Effect.flatMap((response) =>
              failure({ status: response.status, body: JSON.parse(response.text) }),
            ),
          );
        const changed = { _tag: "RegistryError", reason: "changed" };

        const first = yield* organization(slug);
        const original = yield* publishApp(first.id, `original ${suffix}`);
        expect(yield* shownListings).toMatchObject([{ name: shown, commit: original }]);

        expect((yield* unpublish(first.id, currentClient, name)).status).toBe(200);
        const replacement = yield* publishApp(first.id, `replacement ${suffix}`);
        expect(replacement).not.toBe(original);
        yield* refusedRemoval(first.id);
        expect(yield* listed(name)).toEqual([{ name, commit: replacement }]);
        yield* refusedCopy(original, "changed");
        expect(yield* sourceFailure(original)).toEqual(changed);

        expect(yield* shownListings).toMatchObject([{ name: shown, commit: replacement }]);
        const renamed = yield* api.request(actors.owner, "POST", "/api/auth/organization/update", {
          organizationId: first.id,
          data: { slug: renamedSlug },
        });
        expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
        yield* refusedRemoval(first.id);
        yield* refusedCopy(replacement, "not-found");
        expect(yield* listed(renamedName)).toEqual([{ name: renamedName, commit: replacement }]);

        const second = yield* organization(slug);
        const successor = yield* publishApp(second.id, `successor ${suffix}`);
        yield* refusedCopy(replacement, "changed");
        expect(yield* sourceFailure(replacement)).toEqual(changed);
        yield* refusedRemoval(first.id);
        yield* refusedRemoval(second.id);
        expect(yield* listed(name)).toEqual([{ name, commit: successor }]);
        expect(yield* listed(renamedName)).toEqual([{ name: renamedName, commit: replacement }]);

        expect(yield* shownListings).toMatchObject([{ name: shown, commit: successor }]);
        const copied = yield* api.request(
          actors.owner,
          "POST",
          `${home}/apps/copies`,
          { from: { package: shown, commit: successor }, name: `Bound copy ${suffix}` },
          releasedClient,
        );
        expect(copied.status, JSON.stringify(copied.body)).toBe(200);
        const copy = yield* body(Copy, copied);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${home}/apps/${copy.id}`)
            .pipe(Effect.asVoid, Effect.orDie),
        );
        expect(copy.copiedFrom).toEqual({ name, commit: successor });

        const removed = yield* unpublish(second.id, releasedClient, name);
        expect(removed.status, JSON.stringify(removed.body)).toBe(200);
        expect(removed.body).toEqual({ name });
        expect(yield* listed(name)).toEqual([]);
        expect(yield* listed(renamedName)).toEqual([{ name: renamedName, commit: replacement }]);
        expect((yield* unpublish(first.id, currentClient, renamedName)).status).toBe(200);
      }),
    ),
  );
});
