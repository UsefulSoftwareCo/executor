/** A source copy and publication refusal use real hosts and separate credentials. */
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Path, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { createScenario } from "../sdk/session.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsCli } from "../support/apps-cli.ts";
import { appsManifest } from "../support/apps-release.ts";
import { ApiLive, withHostedApiCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";

const App = Schema.Struct({ id: Schema.String, activeVersion: Schema.NullOr(Schema.String) });
const Revision = Schema.Struct({ revision: Schema.Struct({ commit: Schema.String }) });
const Manifest = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));
const Workspace = Schema.Struct({
  ...Revision.fields,
  files: Schema.Array(
    Schema.Struct({ path: Schema.String, content: Schema.optional(Schema.String) }),
  ),
});
const Failure = Schema.fromJsonString(
  Schema.Struct({ error: Schema.Struct({ code: Schema.String }) }),
);

const Publication = Schema.Struct({
  name: Schema.String,
  commit: Schema.String,
  description: Schema.String,
  publishedAt: Schema.String,
});
const Published = Schema.fromJsonString(
  Schema.Struct({
    registry: Schema.String,
    app: Schema.String,
    publication: Publication,
  }),
);
const PublishCall = Schema.fromJsonString(
  Schema.Struct({
    sourceTokenRefused: Schema.Boolean,
    destinationTokenUsed: Schema.Boolean,
    commit: Schema.String,
  }),
);

/**
 * Narrow response-contract coverage. All host traffic stays real except the one publication
 * response: self-host cannot publish, and a successful Cloud write needs deployed Git storage.
 * The CLI runs as a script here so Node can preload this external HTTP boundary fixture.
 */
const publicationReply = (origin: string, endpoint: string, name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "publication-reply-" });
    const receipt = path.join(directory, "request.json");
    const preload = path.join(directory, "reply.mjs");
    yield* fs.writeFileString(
      preload,
      [
        'import { writeFileSync } from "node:fs";',
        "const original = globalThis.fetch;",
        "let authenticatedRead;",
        "globalThis.fetch = async (input, options) => {",
        "  const request = new Request(input, options);",
        "  const url = new URL(request.url);",
        `  if (url.origin !== ${JSON.stringify(origin)}) return original(request);`,
        `  if (request.method === "GET" && url.pathname === ${JSON.stringify(endpoint.replace(/publication$/, "workspace"))}) {`,
        "    const response = await original(request);",
        '    if (response.ok) authenticatedRead = request.headers.get("authorization");',
        "    return response;",
        "  }",
        `  if (request.method !== "POST" || url.pathname !== ${JSON.stringify(endpoint)}) return original(request);`,
        "  const { commit } = await request.json();",
        '  const authorization = request.headers.get("authorization");',
        `  writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({`,
        "    sourceTokenRefused: authorization !== `Bearer ${process.env.EXECUTOR_API_KEY}`,",
        "    destinationTokenUsed: Boolean(authenticatedRead) && authorization === authenticatedRead,",
        "    commit,",
        "  }));",
        `  return Response.json({ name: ${JSON.stringify(name)}, commit, description: "Publication response fixture", publishedAt: "2026-01-01T00:00:00.000Z" });`,
        "};",
      ].join("\n"),
    );
    return {
      environment: { NODE_OPTIONS: `--import=${(yield* path.toFileUrl(preload)).href}` },
      receipt: fs
        .readFileString(receipt)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(PublishCall))),
    };
  });

layer(ApiLive, { excludeTestServices: true })("Cross-registry publishing", (it) => {
  it.effect(scenarios.crossRegistryRefusal.title, (context) =>
    withHostedApiCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          api = yield* Api,
          actors = yield* Actors,
          path = yield* Path.Path;
        const { fixtures: _fixtures, ...base } = target;
        const source = yield* createScenario(
          {
            ...base,
            directory: path.join(target.directory, "publication-source"),
            metadata: { ...target.metadata, target: "local", mode: "managed" },
          },
          { id: randomUUID().replaceAll("-", ""), label: "Publication source" },
        );
        const index = { path: "index.ts", content: "export default {};\n// selected revision\n" };
        const manifest = {
          ...appsManifest,
          content: JSON.stringify({
            ...(yield* Schema.decodeUnknownEffect(Manifest)(appsManifest.content)),
            name: "@source.executor.community/memo",
          }),
        };
        const created = yield* body(
          App,
          yield* source.request("owner", "POST", "/api/apps", {
            name: "Publication source",
            files: [index, manifest],
          }),
        );
        const original = yield* body(
          Workspace,
          yield* source.request("owner", "GET", `/api/apps/${created.id}/workspace`),
        );
        const advanced = yield* body(
          Revision,
          yield* source.request("owner", "POST", `/api/apps/${created.id}/commits`, {
            expected: original.revision.commit,
            files: [index, manifest, { path: "newer.txt", content: "Must not be published" }],
            message: "Advance source after selected revision",
          }),
        );
        const shell = yield* appsCli;
        const login = yield* shell.login(target.metadata.origin, "remote");
        expect(login.finished.code).toBe(0);
        const packageName = `@${actors.organization.slug}.executor.community/memo`;
        const args = [
          "publish",
          "--host",
          source.target.metadata.origin,
          "--app",
          created.id,
          "--commit",
          original.revision.commit,
          "--registry",
          target.metadata.origin,
          "--package",
          packageName,
        ];
        const environment = { EXECUTOR_API_KEY: Redacted.value(source.target.apiKey) };
        // The shared HTTP handler maps unsupported publishing to AppAccessDenied.
        const first = yield* shell.cli(args, environment);
        yield* (yield* Evidence).json("first-publication.json", first);
        expect(first.code).toBe(1);
        expect((yield* Schema.decodeUnknownEffect(Failure)(first.stdout)).error.code).toBe(
          "AppAccessDenied",
        );
        const copyId = first.stderr.match(/The destination copy is ([^ .]+)\./)?.[1];
        if (copyId === undefined)
          return yield* Effect.die("The refusal omitted the retained destination app");
        const prefix = `/api/organizations/${actors.organization.id}/apps/${copyId}`;
        const readCopy = () =>
          api
            .request(actors.owner, "GET", `${prefix}/workspace`)
            .pipe(Effect.flatMap((response) => body(Workspace, response)));
        const copied = yield* readCopy();
        expect(copied.files.find((file) => file.path === "index.ts")?.content).toBe(index.content);
        expect(copied.files.some((file) => file.path === "newer.txt")).toBe(false);
        const copiedManifest = copied.files.find((file) => file.path === "package.json")?.content;
        expect(copiedManifest).toBeDefined();
        expect((yield* Schema.decodeUnknownEffect(Manifest)(copiedManifest)).name).toBe(
          packageName,
        );
        const retried = yield* shell.cli([...args, "--registry-app", copyId], environment);
        expect(retried.code).toBe(1);
        expect((yield* Schema.decodeUnknownEffect(Failure)(retried.stdout)).error.code).toBe(
          "AppAccessDenied",
        );
        expect(retried.stderr).toContain(`The destination copy is ${copyId}.`);
        const after = yield* readCopy();
        expect(after.revision.commit).not.toBe(copied.revision.commit);
        expect(after.files).toEqual(copied.files);
        expect(
          (yield* body(App, yield* api.request(actors.owner, "GET", prefix))).activeVersion,
        ).toBeNull();
        const sourceAfter = yield* body(
          Workspace,
          yield* source.request("owner", "GET", `/api/apps/${created.id}/workspace`),
        );
        expect(sourceAfter.revision.commit).toBe(advanced.revision.commit);
        expect(sourceAfter.files).toContainEqual(manifest);
        const reply = yield* publicationReply(
          target.metadata.origin,
          `${prefix}/publication`,
          packageName,
        );
        const succeeded = yield* shell.cli([...args, "--registry-app", copyId], {
          ...environment,
          ...reply.environment,
        });
        expect(succeeded.code).toBe(0);
        const published = yield* Schema.decodeUnknownEffect(Published)(succeeded.stdout);
        const finalCopy = yield* readCopy();
        expect(published).toEqual({
          registry: target.metadata.origin,
          app: copyId,
          publication: {
            name: packageName,
            commit: finalCopy.revision.commit,
            description: "Publication response fixture",
            publishedAt: "2026-01-01T00:00:00.000Z",
          },
        });
        expect(yield* reply.receipt).toEqual({
          sourceTokenRefused: true,
          destinationTokenUsed: true,
          commit: finalCopy.revision.commit,
        });
        expect(finalCopy.revision.commit).not.toBe(original.revision.commit);
        expect(finalCopy.files).toEqual(copied.files);
        yield* (yield* Evidence).json("publication-refusal.json", {
          sourceCommitUnchanged: sourceAfter.revision.commit === advanced.revision.commit,
          selectedCommitCopied: !after.files.some((file) => file.path === "newer.txt"),
          initialCode: first.code,
          retryCode: retried.code,
        });
      }),
    ),
  );
});
