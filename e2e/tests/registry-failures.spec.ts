/** The public app catalog reads a configured remote registry and reports each failure distinctly. */
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Schedule, Schema } from "effect";
import { Api, body, currentClient, releasedClient, SessionClients } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { startLoggedSelfHost } from "../support/managed-server.ts";
import { Target } from "../support/platform.ts";
import {
  registryCatalog,
  registryFixtureNames,
  registryMixedName,
  registryPublication,
  registryScopedListing,
  registryTwinListings,
  registryUpstream,
} from "../support/registry-upstream.ts";
import { scenarios } from "../test-plan.ts";

const Organizations = Schema.NonEmptyArray(Schema.Struct({ id: Schema.String }));
const Failure = Schema.Struct({
  _tag: Schema.Literal("RegistryError"),
  reason: Schema.String,
  status: Schema.optional(Schema.Number),
});
const Copy = Schema.Struct({
  activeDeployment: Schema.NullOr(Schema.String),
  copiedFrom: Schema.Struct({ name: Schema.String, commit: Schema.String }),
});
const Apps = Schema.Array(Schema.Struct({ id: Schema.String }));

/** A fresh self-host reading the registry fixture, with its owner signed in. */
const registryCase = Effect.gen(function* () {
  const target = yield* Target;
  const registry = yield* registryUpstream;
  const server = yield* startLoggedSelfHost(target, { EXECUTOR_REGISTRY_URL: registry.origin });
  const api = yield* Api.pipe(
    Effect.provide(Layer.fresh(Api.layer)),
    Effect.provide(Layer.fresh(SessionClients.layer)),
    Effect.provideService(Target, {
      ...target,
      metadata: { ...target.metadata, origin: server.origin },
    }),
  );
  const owner = yield* api.session();
  expect(
    (yield* api.request(owner, "POST", "/api/auth/self-host/setup", {
      name: "Registry Owner",
      email: "registry-owner@example.test",
      password: "Synthetic-registry-password-123!",
      organizationName: "Registry lab",
    })).status,
  ).toBe(200);
  const [organization] = yield* body(
    Organizations,
    yield* api.request(owner, "GET", "/api/auth/organization/list"),
  );
  const prefix = `/api/organizations/${organization.id}`;
  const catalog = (name?: string, client: Record<string, string> = {}) =>
    api.request(
      owner,
      "GET",
      `${prefix}/app-publications${name === undefined ? "" : `?name=${encodeURIComponent(name)}`}`,
      undefined,
      client,
    );
  return { api, owner, prefix, registry, catalog, log: server.log };
});

const failed = (response: { readonly status: number; readonly body: unknown }) => {
  expect(response.status, JSON.stringify(response.body)).toBe(400);
  return body(Failure, response);
};

layer(TestLive, { excludeTestServices: true })("Remote registry failures", (it) => {
  it.effect(scenarios.remoteRegistryFailures.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const { registry, catalog, log } = yield* registryCase;
        const failure = (name: string) => Effect.flatMap(catalog(name), failed);

        const listed = yield* catalog();
        expect(listed.status).toBe(200);
        expect(listed.body).toEqual(registryCatalog);
        expect(yield* failure(registryFixtureNames.redirect), "redirects are not followed").toEqual(
          { _tag: "RegistryError", reason: "status", status: 302 },
        );
        expect(yield* failure(registryFixtureNames.unavailable)).toEqual({
          _tag: "RegistryError",
          reason: "status",
          status: 503,
        });
        expect(yield* failure(registryFixtureNames.garbled)).toEqual({
          _tag: "RegistryError",
          reason: "invalid-response",
        });
        expect(
          yield* failure(registryFixtureNames.missing),
          "registry errors pass through",
        ).toEqual({ _tag: "RegistryError", reason: "not-found" });
        const paths = yield* registry.paths;
        expect(paths, "every read reached the configured registry").toEqual(
          [undefined, ...Object.values(registryFixtureNames)].map(
            (name) =>
              `/api/registry/apps${name === undefined ? "" : `?name=${encodeURIComponent(name)}`}`,
          ),
        );
        expect(
          yield* registry.revisions,
          "each read states the wire revision this release reads",
        ).toEqual(paths.map(() => "1"));

        // A listing this release cannot read is left out; the others are still listed. The log
        // names each one and what failed to decode, and promises an upgrade only for new formats.
        const mixed = yield* catalog(registryMixedName);
        expect(mixed.status, JSON.stringify(mixed.body)).toBe(200);
        expect(mixed.body).toEqual([registryPublication]);
        // The server's output reaches its log file after the response, so wait for both lines.
        const fs = yield* FileSystem.FileSystem;
        const warnings = yield* fs.readFileString(log).pipe(
          Effect.map((text) =>
            text.split("\n").filter((line) => line.includes("Left out public registry listing")),
          ),
          Effect.repeat({
            until: (lines) => lines.length >= 2,
            schedule: Schedule.spaced("250 millis"),
            times: 80,
          }),
        );
        expect(warnings).toHaveLength(2);
        expect(warnings[0]).toContain("@fixture/future+format");
        expect(warnings[0]).toContain("$.name: Filter");
        expect(warnings[1]).toContain("@fixture/malformed");
        expect(warnings[1]).toContain("$.description: InvalidType");
        for (const warning of warnings)
          expect(warning).toContain(
            "A newer release reads listings in formats added since this one, not malformed ones.",
          );

        yield* registry.close;
        expect(yield* failure(registryPublication.name), "an unreachable registry").toEqual({
          _tag: "RegistryError",
          reason: "network",
        });
      }),
    ),
  );

  it.effect(scenarios.remoteRegistryReleasedClients.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const { api, owner, prefix, registry, catalog } = yield* registryCase;
        const [dotless, scoped] = registryTwinListings;
        const sent = Effect.map(registry.paths, (all) => all.length);
        const since = (count: number) => Effect.map(registry.paths, (all) => all.slice(count));
        const lookup = (name: string) => `/api/registry/apps?name=${encodeURIComponent(name)}`;
        const source = (listing: { readonly name: string; readonly commit: string }) =>
          `/api/registry/source?name=${encodeURIComponent(listing.name)}&commit=${listing.commit}`;
        const copy = (name: string, commit: string, client: Record<string, string>) =>
          api.request(
            owner,
            "POST",
            `${prefix}/apps/copies`,
            { from: { package: name, commit }, name: `Copy of ${name}` },
            client,
          );

        // A client released before publisher scopes lists each listing by a name it decodes: an
        // older registry's `@fixture/example` as it is, a publishing scope's under its slug. The
        // twins would read as one name, so neither is listed to it.
        const listed = yield* catalog(undefined, releasedClient);
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        expect(listed.body).toEqual([
          registryPublication,
          { ...registryScopedListing, name: "@scoped/notes" },
        ]);

        // Each name it was shown selects that listing, looked up by every name it could stand for.
        let before = yield* sent;
        const example = yield* catalog(registryPublication.name, releasedClient);
        expect(example.status, JSON.stringify(example.body)).toBe(200);
        expect(example.body).toEqual([registryPublication]);
        expect(yield* since(before)).toEqual([
          lookup(registryPublication.name),
          lookup("@fixture.executor.community/example"),
        ]);
        const notes = yield* catalog("@scoped/notes", releasedClient);
        expect(notes.status, JSON.stringify(notes.body)).toBe(200);
        expect(notes.body).toEqual([{ ...registryScopedListing, name: "@scoped/notes" }]);
        // A later release that states no revision reads names under publisher scopes and may send
        // one. The full name means only that listing, and the answer names it as it was sent.
        before = yield* sent;
        const full = yield* catalog(registryScopedListing.name, releasedClient);
        expect(full.status, JSON.stringify(full.body)).toBe(200);
        expect(full.body).toEqual([registryScopedListing]);
        expect(yield* since(before)).toEqual([lookup(registryScopedListing.name)]);
        // When nothing reads as the name, it is answered as the registry answers that name itself.
        before = yield* sent;
        expect(
          yield* failed(yield* catalog(registryFixtureNames.missing, releasedClient)),
          "registry errors pass through",
        ).toEqual({ _tag: "RegistryError", reason: "not-found" });
        expect(yield* since(before)).toEqual([
          lookup(registryFixtureNames.missing),
          lookup("@fixture.executor.community/missing"),
        ]);

        // Copying reads the source of the listing it was shown, under its published name.
        before = yield* sent;
        const exampleCopy = yield* copy(
          registryPublication.name,
          registryPublication.commit,
          releasedClient,
        );
        expect(exampleCopy.status, JSON.stringify(exampleCopy.body)).toBe(200);
        const copiedExample = yield* body(Copy, exampleCopy);
        expect(copiedExample.copiedFrom).toMatchObject({
          name: registryPublication.name,
          commit: registryPublication.commit,
        });
        expect(copiedExample.activeDeployment).not.toBeNull();
        expect(yield* since(before)).toContain(source(registryPublication));
        before = yield* sent;
        const notesCopy = yield* copy(
          "@scoped/notes",
          registryScopedListing.commit,
          releasedClient,
        );
        expect(notesCopy.status, JSON.stringify(notesCopy.body)).toBe(200);
        expect((yield* body(Copy, notesCopy)).copiedFrom).toMatchObject({
          name: registryScopedListing.name,
          commit: registryScopedListing.commit,
        });
        expect(yield* since(before)).toContain(source(registryScopedListing));
        const fullCopy = yield* copy(
          registryScopedListing.name,
          registryScopedListing.commit,
          releasedClient,
        );
        expect(fullCopy.status, JSON.stringify(fullCopy.body)).toBe(200);
        expect((yield* body(Copy, fullCopy)).copiedFrom).toMatchObject({
          name: registryScopedListing.name,
          commit: registryScopedListing.commit,
        });

        // A name two listings read as is refused, never sent to either; no source is read.
        before = yield* sent;
        expect(yield* failed(yield* catalog(dotless.name, releasedClient))).toEqual({
          _tag: "RegistryError",
          reason: "conflict",
        });
        for (const listing of [dotless, scoped])
          expect(yield* failed(yield* copy(dotless.name, listing.commit, releasedClient))).toEqual({
            _tag: "RegistryError",
            reason: "conflict",
          });
        expect(
          (yield* since(before)).filter((path) => path.startsWith("/api/registry/source")),
        ).toEqual([]);

        // This release's clients name each twin by its own name.
        for (const listing of [dotless, scoped]) {
          const own = yield* catalog(listing.name);
          expect(own.status, JSON.stringify(own.body)).toBe(200);
          expect(own.body).toEqual([listing]);
        }

        // A self-host removes no listing from the registry it reads, for either revision, and
        // never looks the name up.
        before = yield* sent;
        for (const [name, client] of [
          ["@scoped/notes", releasedClient],
          [registryScopedListing.name, currentClient],
        ] as const) {
          const removed = yield* api.request(
            owner,
            "POST",
            `${prefix}/app-publications/unpublish`,
            { package: name },
            client,
          );
          expect(removed.status, JSON.stringify(removed.body)).toBe(403);
          expect(removed.body).toMatchObject({ _tag: "AppAccessDenied", reason: "forbidden" });
        }
        expect(yield* since(before)).toEqual([]);

        // The listing it was shown as `@scoped/notes` changes before it copies that commit. The
        // name then selects a replacement with another commit, or nothing once the scope is
        // renamed; the copy is refused and makes no app.
        const apps = Effect.flatMap(api.request(owner, "GET", `${prefix}/apps`), (response) =>
          body(Apps, response),
        );
        const made = (yield* apps).length;
        const others = registryCatalog.filter((listing) => listing !== registryScopedListing);
        const replacement = { ...registryScopedListing, commit: "e".repeat(40) };
        yield* registry.publish([...others, replacement]);
        expect(
          yield* failed(yield* copy("@scoped/notes", registryScopedListing.commit, releasedClient)),
        ).toEqual({ _tag: "RegistryError", reason: "changed" });
        const renamed = { ...registryScopedListing, name: "@renamed.executor.community/notes" };
        yield* registry.publish([...others, renamed]);
        before = yield* sent;
        expect(
          yield* failed(yield* copy("@scoped/notes", registryScopedListing.commit, releasedClient)),
        ).toEqual({ _tag: "RegistryError", reason: "not-found" });
        expect(yield* since(before)).not.toContain(source(renamed));
        expect((yield* apps).length).toBe(made);
      }),
    ),
  );
});
