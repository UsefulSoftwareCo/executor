/**
 * Search and the skills index read every app's kept tool listing and skill catalog. Self-host and
 * local keep them in each app's data supervisor as well as in memory, so after a restart neither
 * evaluates an app again, and an aged result is served as it is rather than refreshed by loading
 * every app's Worker. Each probe app counts its evaluations in module state: a Worker the restart
 * left unloaded reports one evaluation for the call that loads it, unless a read loaded it first.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, TestLive, withCase, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Target } from "../support/platform.ts";
import { serverControl } from "../support/server-control.ts";

const apps = 3;
/** Past the tool listing's 30 s and the skill catalog's 10 s freshness, within their 24 h bound. */
const aged = 60_000;

/** Every evaluation names itself in the probe's description; a call reports the isolate's count. */
const probeSource = `import { defineApp, query, object, router } from "apps";
let evaluations = 0;
export default defineApp({ accounts: {} }, async () => {
  evaluations += 1;
  const evaluation = crypto.randomUUID();
  return { tools: router({ probe: query(
    { description: "Kept listing probe evaluation " + evaluation + ".", input: object({}) },
    async () => ({ evaluations }),
  ) }) };
});`;

const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
});
const Search = Schema.Struct({
  items: Schema.Array(Schema.Struct({ path: Schema.String, description: Schema.String })),
});
const Probe = Schema.Struct({ evaluations: Schema.Number });
const SkillsIndex = Schema.Struct({ skills: Schema.Array(Schema.Unknown) });
const LocalDeployed = Schema.Struct({ app: App });

interface Deployed {
  readonly id: string;
  readonly slug: string;
}

type Connection = Effect.Success<ReturnType<McpClient["Service"]["connect"]>>;

/** Search and the skills index over one MCP connection. */
const session = (client: Connection) => ({
  execute: (step: string, code: string) =>
    client
      .use(step, (client, signal) =>
        client.callTool({ name: "execute", arguments: { code } }, undefined, {
          signal,
          timeout: 55_000,
        }),
      )
      .pipe(
        Effect.flatMap((result) => Schema.decodeUnknownEffect(Completed)(result.structuredContent)),
        Effect.map((completed) => completed.execution.value),
      ),
  skills: (step: string) =>
    client
      .use(step, (client, signal) =>
        client.callTool({ name: "skills", arguments: {} }, undefined, { signal }),
      )
      .pipe(
        Effect.flatMap((result) =>
          Schema.decodeUnknownEffect(SkillsIndex)(result.structuredContent),
        ),
        Effect.asVoid,
      ),
});

/**
 * Search, then index skills, so each probe app's supervisor keeps both results; then restart the
 * product with its clock moved past their freshness. After it, search and the skills
 * index serve the same evaluations, recalled from the supervisor and then from memory, and a call
 * of each app finds its Worker unloaded since the restart.
 */
const keptAcrossRestart = <E, R>(
  deployed: ReadonlyArray<Deployed>,
  /** Opens a new connection; a restart ends the previous one's session. */
  connect: Effect.Effect<Connection, E, R>,
) =>
  Effect.gen(function* () {
    /** Each probe app's evaluation id, as search describes its tool. */
    const search = (execute: ReturnType<typeof session>["execute"], step: string) =>
      Effect.gen(function* () {
        const found = yield* Schema.decodeUnknownEffect(Search)(
          yield* execute(step, `return await tools.search({ query: "Kept listing probe" });`),
        );
        return deployed.map((app) => {
          const item = found.items.find(
            (entry) => entry.path === `tools[${JSON.stringify(app.slug)}].probe`,
          );
          const evaluation = / evaluation ([0-9a-f-]+)\./.exec(item?.description ?? "")?.[1];
          expect(evaluation, `${step}: ${app.slug}`).toBeDefined();
          return evaluation;
        });
      });

    const evaluated = yield* Effect.scoped(
      Effect.gen(function* () {
        const { execute, skills } = session(yield* connect);
        const listed = yield* search(execute, "Search every app");
        yield* skills("Index every app's skills");
        return listed;
      }),
    );

    yield* serverControl("stop");
    yield* serverControl("clock/advance", 200, { milliseconds: aged });
    yield* serverControl("start");

    yield* Effect.scoped(
      Effect.gen(function* () {
        const { execute, skills } = session(yield* connect);
        // Recalled from each app's supervisor, not evaluated again: an evaluation names itself.
        expect(yield* search(execute, "Search after the restart")).toEqual(evaluated);
        yield* skills("Index skills after the restart");
        // Now served from memory, still past its freshness.
        expect(yield* search(execute, "Search again")).toEqual(evaluated);
        yield* skills("Index skills again");
        for (const app of deployed) {
          const probe = yield* Schema.decodeUnknownEffect(Probe)(
            yield* execute(
              `Call ${app.slug}`,
              `return await tools[${JSON.stringify(app.slug)}].probe({});`,
            ),
          );
          expect(probe.evaluations, `${app.slug}: evaluations in its Worker`).toBe(1);
        }
      }),
    );
  });

layer(HostedLive, { excludeTestServices: true })("Kept listings", (it) => {
  it.effect(
    scenarios.keptListingsAfterRestart.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            mcp = yield* McpClient;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const deployed: Deployed[] = [];
          for (let index = 0; index < apps; index++) {
            const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `Kept listing ${index} ${randomUUID().slice(0, 8)}`,
              files: [{ path: "index.ts", content: probeSource }, appsManifest],
            });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const app = yield* body(App, response);
            yield* Effect.addFinalizer(() =>
              serverControl("start").pipe(
                Effect.andThen(api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`)),
                Effect.orDie,
              ),
            );
            deployed.push(app);
          }
          const key = yield* body(
            Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
            yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
              name: "Kept listings",
            }),
          );
          yield* Effect.addFinalizer(() =>
            serverControl("start").pipe(
              Effect.andThen(
                api.request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id }),
              ),
              Effect.orDie,
            ),
          );
          yield* keptAcrossRestart(
            deployed,
            mcp.connect(key.key, "kept-listings", { organization: actors.organization.id }),
          );
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    { timeout: 120_000 },
  );
});

layer(TestLive, { excludeTestServices: true })("Local kept listings", (it) => {
  it.effect(
    scenarios.localKeptListingsAfterRestart.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            target = yield* Target,
            mcp = yield* McpClient;
          const session = yield* api.session();
          const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
          const deployed: Deployed[] = [];
          for (let index = 0; index < apps; index++) {
            const response = yield* session.send(
              "POST",
              "/v1/apps/deploy",
              {
                owner: "local",
                name: `Kept listing ${index} ${randomUUID().slice(0, 8)}`,
                files: [{ path: "index.ts", content: probeSource }, appsManifest],
              },
              headers,
            );
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const { app } = yield* body(LocalDeployed, response);
            yield* Effect.addFinalizer(() =>
              serverControl("start").pipe(
                Effect.andThen(session.send("DELETE", `/v1/apps/${app.id}`, undefined, headers)),
                Effect.orDie,
              ),
            );
            deployed.push(app);
          }
          yield* keptAcrossRestart(deployed, mcp.connect(target.apiKey, "kept-listings"));
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    { timeout: 120_000 },
  );
});
