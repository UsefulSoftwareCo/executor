/** Remote skill catalogs kept in the app cache, through the real app compiler, runtime and HTTP. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { App } from "../support/contracts.ts";
import { skillUpstream } from "../support/skill-upstream.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { appsManifest } from "../support/apps-release.ts";
import { createProfile } from "../support/profiles.ts";

const Bundle = Schema.Struct({
  revision: Schema.String,
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
    }),
  ),
});
layer(HostedLive, { excludeTestServices: true })("Cached skills", (it) => {
  it.effect(scenarios.cachedSkills.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry;
        const upstream = yield* skillUpstream;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const response = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Cached skills ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, dynamicSkills, query, object, router } from "apps";
import { githubSkills, wellKnownSkills } from "apps/skills";
export default defineApp({ accounts: {} }, async (ctx) => ({
  tools: router({ ping: query({ input: object({}) }, async () => "pong") }),
  dynamicSkills: dynamicSkills({ list: async () => [
    ...await wellKnownSkills({ url: ${JSON.stringify(upstream.url)}, cache: ctx.cache, freshFor: "1 hour", fetch: ctx.fetch, signal: ctx.signal }),
    ...await githubSkills({ repo: "synthetic/skills", path: "skills", cache: ctx.cache, freshFor: "1 hour", signal: ctx.signal, fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return ctx.fetch(${JSON.stringify(upstream.url)} + "/github" + url.pathname + url.search, init);
    } }),
  ] }),
}));`,
            },
            appsManifest,
          ],
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const app = yield* body(App, response);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
        );
        const base = `${prefix}/${app.id}`;
        const read = Effect.gen(function* () {
          const bundle = yield* api.request(actors.owner, "GET", `${base}/skill-bundle`);
          expect(
            bundle.status,
            JSON.stringify({ response: bundle.body, requests: yield* upstream.requests }),
          ).toBe(200);
          return yield* body(Bundle, bundle);
        });
        /** How the latest request's skill read was served, from its own trace. */
        const outcome = Effect.gen(function* () {
          const request = (yield* evidence.requests).at(-1);
          if (request === undefined) return yield* Effect.fail(new Error("Missing request"));
          const spans = yield* telemetry.query(request.traceId).pipe(
            Effect.map((result) =>
              result.data.filter(
                ({ span }) =>
                  span.operationName === "sdk.declarations.read" &&
                  span.tags["executor.declarations.command"] === "skills",
              ),
            ),
            Effect.flatMap((spans) =>
              spans.length === 0
                ? Effect.fail(new Error("Missing skill read span"))
                : Effect.succeed(spans),
            ),
            Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 80 }),
          );
          return spans[0]?.span.tags["executor.declarations.cache"];
        });

        const first = yield* read;
        expect(first.skills.map((skill) => skill.name)).toEqual(["github-guide", "remote-guide"]);
        expect(
          first.skills.every((skill) =>
            skill.files.some((file) => file.content.includes("Reference 1")),
          ),
        ).toBe(true);
        const loaded = (yield* upstream.requests).length;
        expect(loaded).toBeGreaterThan(0);

        // A loader that reads through the app cache has its catalog kept, so the next read
        // neither evaluates the app nor contacts either source.
        const second = yield* read;
        expect(second).toEqual(first);
        expect(yield* outcome).toBe("hit");
        expect((yield* upstream.requests).length).toBe(loaded);

        // Within freshFor, a new publication is not fetched; the kept catalog stays current.
        yield* upstream.publish(2);
        const third = yield* read;
        expect(third.revision).toBe(first.revision);
        expect((yield* upstream.requests).length).toBe(loaded);
        const file = yield* api.request(
          actors.owner,
          "GET",
          `${base}/skills/remote-guide?revision=${first.revision}&file=references/example.md`,
        );
        expect(file.status).toBe(200);
        expect((yield* body(Schema.Struct({ content: Schema.String }), file)).content).toBe(
          "# Reference 1",
        );
        expect((yield* upstream.requests).length).toBe(loaded);
      }),
    ),
  );

  it.effect(scenarios.cachedSkillsRefresh.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const upstream = yield* skillUpstream;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const response = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Refreshed skills ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, query, object, router } from "apps";
import { wellKnownSkills } from "apps/skills";
export default defineApp({ accounts: {} }, async (ctx) => ({
  tools: router({
    reference: query({ input: object({}) }, async () => {
      const skills = await wellKnownSkills({ url: ${JSON.stringify(upstream.url)}, cache: ctx.cache, freshFor: "1 second", fetch: ctx.fetch, signal: ctx.signal });
      return skills.flatMap((skill) => skill.files).find((file) => file.path === "references/example.md")?.content ?? null;
    }),
  }),
}));`,
            },
            appsManifest,
          ],
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const app = yield* body(App, response);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
        );
        /** The reference file of the catalog the tool read, as the tool call returned it. */
        const reference = Effect.gen(function* () {
          const called = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/${app.id}/tools/call`,
            {
              tool: "reference",
              kind: "query",
              input: {},
            },
          );
          expect(called.status, JSON.stringify(called.body)).toBe(200);
          const text = JSON.stringify(called.body);
          return text.includes("# Reference 2") ? 2 : text.includes("# Reference 1") ? 1 : 0;
        });

        expect(yield* reference).toBe(1);
        const loaded = (yield* upstream.requests).length;

        // Past freshFor, one request for the index, with the author's fetch, confirms the kept
        // catalog; its files are not fetched again.
        yield* Effect.sleep("1500 millis");
        expect(yield* reference).toBe(1);
        expect((yield* upstream.requests).slice(loaded)).toEqual([
          "/.well-known/agent-skills/index.json",
        ]);

        // A new publication is loaded before the call answers, never after it.
        yield* upstream.publish(2);
        yield* Effect.sleep("1500 millis");
        expect(yield* reference, JSON.stringify(yield* upstream.requests)).toBe(2);
      }),
    ),
  );

  it.effect(scenarios.revalidatedSkills.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry;
        const upstream = yield* skillUpstream;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const response = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Revalidated skills ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, dynamicSkills, query, object, router } from "apps";
import { wellKnownSkills } from "apps/skills";
export default defineApp({ accounts: {} }, async (ctx) => ({
  tools: router({ ping: query({ input: object({}) }, async () => "pong") }),
  dynamicSkills: dynamicSkills({ list: () => wellKnownSkills({ url: ${JSON.stringify(upstream.url)}, cache: ctx.cache, freshFor: "1 second", fetch: ctx.fetch, signal: ctx.signal }) }),
}));`,
            },
            appsManifest,
          ],
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const app = yield* body(App, response);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
        );
        const base = `${prefix}/${app.id}`;
        const read = Effect.gen(function* () {
          const bundle = yield* api.request(actors.owner, "GET", `${base}/skill-bundle`);
          expect(
            bundle.status,
            JSON.stringify({ response: bundle.body, requests: yield* upstream.requests }),
          ).toBe(200);
          return yield* body(Bundle, bundle);
        });
        /** How the latest request's skill read was served, from its own trace. */
        const outcome = Effect.gen(function* () {
          const request = (yield* evidence.requests).at(-1);
          if (request === undefined) return yield* Effect.fail(new Error("Missing request"));
          const spans = yield* telemetry.query(request.traceId).pipe(
            Effect.map((result) =>
              result.data.filter(
                ({ span }) =>
                  span.operationName === "sdk.declarations.read" &&
                  span.tags["executor.declarations.command"] === "skills",
              ),
            ),
            Effect.flatMap((spans) =>
              spans.length === 0
                ? Effect.fail(new Error("Missing skill read span"))
                : Effect.succeed(spans),
            ),
            Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 80 }),
          );
          return spans[0]?.span.tags["executor.declarations.cache"];
        });
        const reference = (revision: string) =>
          api.request(
            actors.owner,
            "GET",
            `${base}/skills/remote-guide?revision=${revision}&file=references/example.md`,
          );

        const first = yield* read;
        expect(first.skills.flatMap((skill) => skill.files.map((file) => file.content))).toContain(
          "# Reference 1",
        );

        // A docs deploy. Once the host's kept catalog (10 s) and the app cache's (1 s) are stale,
        // a read without a revision checks the publisher before it answers, so it returns the new
        // revision now rather than the old one followed by a background refresh.
        yield* upstream.publish(2);
        yield* Effect.sleep("10500 millis");
        const second = yield* read;
        expect(yield* outcome).toBe("revalidated");
        expect(second.revision).not.toBe(first.revision);
        expect(second.skills.flatMap((skill) => skill.files.map((file) => file.content))).toContain(
          "# Reference 2",
        );

        // Pinned reads keep their strict revision: the replaced one is refused, the new one served.
        const replaced = yield* reference(first.revision);
        expect(replaced.status).toBe(409);
        expect(replaced.body).toMatchObject({
          _tag: "SkillRevisionChanged",
          expected: first.revision,
          current: second.revision,
        });
        const pinned = yield* reference(second.revision);
        expect(pinned.status).toBe(200);
        expect((yield* body(Schema.Struct({ content: Schema.String }), pinned)).content).toBe(
          "# Reference 2",
        );

        // Nothing replaces that revision later: after the app cache is stale again, the pinned
        // read is still served and an unpinned read returns the same revision.
        yield* Effect.sleep("1500 millis");
        expect((yield* reference(second.revision)).status).toBe(200);
        expect((yield* read).revision).toBe(second.revision);
      }),
    ),
  );

  it.effect(scenarios.cachedSkillsCustomCacheCancel.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const upstream = yield* skillUpstream;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        // The app's own cache runs each load itself under a signal it owns. Once the repository's
        // tree download starts, the cache gives up on that load, as a cache with its own timeout
        // would. The download answers only when its request is aborted, or after 10 seconds.
        const response = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Abandoned skills ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, query, object, router } from "apps";
import { githubSkills } from "apps/skills";
export default defineApp({ accounts: {} }, async (ctx) => ({
  tools: router({ probe: query({ input: object({}) }, async () => {
    const loads = [];
    let aborted = false;
    const cache = { ...ctx.cache, get: (options) => {
      const load = new AbortController();
      loads.push(load);
      return options.load({ cache, fetch: ctx.fetch, signal: load.signal });
    } };
    const fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const body = init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : "";
      if (!body.includes("command=fetch"))
        return ctx.fetch(${JSON.stringify(upstream.url)} + "/github" + url.pathname + url.search, init);
      setTimeout(() => loads.at(-1)?.abort(), 100);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response(null, { status: 503 })), 10_000);
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          clearTimeout(timer);
          reject(init.signal.reason);
        }, { once: true });
      });
    };
    const settled = await Promise.race([
      githubSkills({ repo: "synthetic/skills", path: "skills", cache, fetch, signal: ctx.signal }).then(() => "loaded", () => "failed"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 5_000)),
    ]);
    return { settled, loads: loads.length, aborted };
  }) }),
}));`,
            },
            appsManifest,
          ],
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const app = yield* body(App, response);
        const path = `${prefix}/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );
        const profile = yield* createProfile(actors.owner, path);
        const call = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          profile: profile.id,
          tool: "probe",
          kind: "query",
          input: {},
        });
        expect(call.status, JSON.stringify(call.body)).toBe(200);
        // Two loads: the skill catalog, then the repository's directories inside it. Abandoning the
        // directories' load aborts its download and fails the read, instead of leaving it waiting.
        expect(
          yield* body(
            Schema.Struct({
              settled: Schema.String,
              loads: Schema.Number,
              aborted: Schema.Boolean,
            }),
            call,
          ),
        ).toEqual({ settled: "failed", loads: 2, aborted: true });
      }),
    ),
  );
});
