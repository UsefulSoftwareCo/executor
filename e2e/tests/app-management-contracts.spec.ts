/** Agents author apps through the Executor app with the contracts its docs describe. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, TestLive, withCase, withHostedCase } from "../support/case.ts";
import { McpClient } from "../support/mcp-client.ts";
import { managementApp } from "../support/management-app.ts";
import { Target } from "../support/platform.ts";
import { appsVersion, declaredApps } from "../support/apps-release.ts";
import { helloIndex } from "../support/app-authoring.ts";

const Token = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });
const Completed = <S extends Schema.Top>(value: S) =>
  Schema.Struct({
    status: Schema.Literal("completed"),
    execution: Schema.Struct({
      ok: Schema.Literal(true),
      value,
      truncated: Schema.optional(Schema.Never),
    }),
  });
const Failed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      message: Schema.String,
      response: Schema.Struct({
        code: Schema.String,
        status: Schema.Number,
        message: Schema.String,
        recovery: Schema.Struct({ action: Schema.String, instructions: Schema.String }),
      }),
    }),
  }),
});
const Tool = Schema.Struct({ path: Schema.String, description: Schema.String });
const Discovered = Completed(
  Schema.Struct({
    catalog: Schema.String,
    found: Schema.Array(Tool),
    create: Schema.String,
    release: Schema.Struct({ version: Schema.String }),
  }),
);
const File = Schema.Struct({ path: Schema.String, content: Schema.String });
const Created = Completed(
  Schema.Struct({
    app: Schema.Struct({ id: Schema.String, slug: Schema.String }),
    deployed: Schema.Struct({
      app: Schema.Struct({ id: Schema.String, activeDeployment: Schema.String }),
    }),
    files: Schema.Array(File),
  }),
);
const Greeted = Completed(Schema.Struct({ message: Schema.Literal("Hello") }));
/** Writes describe what they saved instead of echoing the files, which grow with the app. */
const Saved = Completed(
  Schema.Struct({
    saved: Schema.Struct({
      revision: Schema.Struct({ commit: Schema.String }),
      files: Schema.optional(Schema.Never),
    }),
    deployed: Schema.Struct({
      app: Schema.Struct({ id: Schema.String, activeDeployment: Schema.String }),
      deployment: Schema.Struct({ id: Schema.String, files: Schema.optional(Schema.Never) }),
    }),
  }),
);
type Connection = Effect.Success<ReturnType<Effect.Success<typeof McpClient>["connect"]>>;

/**
 * Follow deploy.md: discover the catalog's constraints and the host's apps release, then create
 * the two-file app with files and deploy it. Create without files is refused. Later commit and
 * deploy results stay objects after the source outgrows an execute result.
 */
const authorApp = (client: Connection, profile: string, organization?: string) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence;
    const executor = `const executor = tools.executor.profiles[${JSON.stringify(profile)}];`;
    // Local routes have no organization, and their tools accept no empty path.
    const tenant = organization === undefined ? {} : { organization };
    const scope = organization === undefined ? {} : { path: tenant };
    const execute = (step: string, code: string) =>
      client
        .use(step, (client, signal) =>
          client.callTool(
            { name: "execute", arguments: { code: `${executor}\n${code}` } },
            undefined,
            { signal },
          ),
        )
        .pipe(Effect.map((result) => result.structuredContent));

    const discovered = yield* execute(
      "Discover the catalog, the apps release and create",
      `const find = async (query, path) => {
  const item = (await tools.search({ query, limit: 20 })).items.find((item) => item.path.endsWith(path));
  return item === undefined ? undefined : (await tools.search.describe({ paths: [item.path] })).items[0];
};
const found = await tools.search({ query: "framework.release" });
const create = await find("appManagement.create", ".appManagement.create");
const catalog = await find("appManagement.catalog", ".appManagement.catalog");
const release = await executor.framework.release(${JSON.stringify(scope)});
return { catalog: catalog?.signature, found: found.items.map(({ path, description }) => ({ path, description })), create: create?.signature, release };`,
    );
    yield* evidence.json("discovered.json", discovered);
    const found = (yield* Schema.decodeUnknownEffect(Discovered)(discovered)).execution.value;
    // A plain service name fails the optional name filter's pattern, so its input must show it.
    const [input] = found.catalog.split("): Promise<");
    expect(input).toMatch(/@pattern \^@\[a-z0-9\][^\n]*\n\s*name\?: string \| null/);
    // deploy.md names framework.release; searching for it finds it first, saying where it goes.
    expect(found.found[0]?.path).toMatch(/\.framework\.release$/);
    expect(found.found[0]?.description).toContain('{ "dependencies": { "apps": version } }');
    expect(found.release.version).toBe(appsVersion);
    // Create's signature documents its files, in the block right above them in its input, with
    // the version framework.release returns.
    const [createInput] = found.create.split("): Promise<");
    expect(createInput?.match(/\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*files: /)?.[1]).toContain(
      "a package.json whose dependencies.apps is the exact version framework.release returns",
    );

    // Without files nothing is created. The typed input error names body.files and sends the
    // agent to create's signature, whose files documentation above names framework.release.
    const name = `Hello ${randomUUID().slice(0, 8)}`;
    const refused = yield* execute(
      "Create an app without files",
      `return await executor.appManagement.create({ ...${JSON.stringify(scope)}, body: { name: ${JSON.stringify(name)} } });`,
    );
    yield* evidence.json("create-without-files.json", refused);
    const failure = (yield* Schema.decodeUnknownEffect(Failed)(refused)).execution.error.response;
    expect(failure).toMatchObject({ code: "InputInvalid", status: 422 });
    expect(failure.message).toContain("input.body.files: Missing key");
    expect(failure.recovery.instructions).toContain("tools.search.describe");

    // deploy.md's MCP example: index.ts and a package.json pinning the reported version.
    const created = yield* execute(
      "Create and deploy the documented two-file app",
      `const { version } = await executor.framework.release(${JSON.stringify(scope)});
const files = [
  { path: "index.ts", content: ${JSON.stringify(helloIndex)} },
  { path: "package.json", content: JSON.stringify({ name: "hello", private: true, type: "module", dependencies: { apps: version } }) },
];
const app = await executor.appManagement.create({ ...${JSON.stringify(scope)}, body: { name: ${JSON.stringify(name)}, files } });
const deployed = await executor.appManagement.deploy({ path: { ...${JSON.stringify(tenant)}, app: app.id }, body: { files } });
const source = await executor.appManagement.source({ path: { ...${JSON.stringify(tenant)}, app: app.id } });
return { app, deployed, files: source.files };`,
    );
    yield* evidence.json("created.json", created);
    const app = (yield* Schema.decodeUnknownEffect(Created)(created)).execution.value;
    expect(app.deployed.app.id).toBe(app.app.id);
    expect(declaredApps(app.files)).toBe(appsVersion);
    // Discovery runs at the start of each execute, so the deployed app answers in a new one.
    const greeted = yield* execute(
      "Call the deployed app",
      `return await tools[${JSON.stringify(app.app.slug)}].hello({});`,
    );
    yield* evidence.json("greeted.json", greeted);
    yield* Schema.decodeUnknownEffect(Greeted)(greeted);

    // Commit and deploy results stay objects when the app's source is larger than the execute
    // result limit.
    const deployed = yield* execute(
      "Deploy a large saved source",
      `const path = ${JSON.stringify({ ...tenant, app: app.app.id })};
const source = await executor.appManagement.source({ path });
const saved = await executor.appManagement.commit({ path, body: { expected: source.revision.commit, files: [...source.files, { path: "reference.md", content: "x".repeat(70000) }], message: "Add a large reference" } });
const deployed = await executor.appManagement.deploy({ path, body: { commit: saved.revision.commit } });
return { saved, deployed };`,
    );
    yield* evidence.json("deployed.json", deployed);
    const result = (yield* Schema.decodeUnknownEffect(Saved)(deployed)).execution.value.deployed;
    expect(result.app.id).toBe(app.app.id);
    expect(result.deployment.id).toBe(result.app.activeDeployment);
    return app.app.id;
  });

/** deploy.md's local example deploys through `apps.deploy`; local `apps.commit` saves the same way. */
const deployThroughApps = (client: Connection, profile: string, app: string) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence;
    const deployed = yield* client.use("Deploy a large source through apps", (client, signal) =>
      client.callTool(
        {
          name: "execute",
          arguments: {
            code: `const executor = tools.executor.profiles[${JSON.stringify(profile)}];
const path = { app: ${JSON.stringify(app)} };
const { owner } = await executor.apps.get({ path });
const source = await executor.apps.workspace({ path, query: { owner } });
const files = source.files.map((file) => file.path === "reference.md" ? { ...file, content: "y".repeat(70000) } : file);
const saved = await executor.apps.commit({ path, body: { owner, expected: source.revision.commit, files, message: "Revise the large reference" } });
const deployed = await executor.apps.deploy({ body: { owner, app: path.app, files } });
return { saved, deployed };`,
          },
        },
        undefined,
        { signal },
      ),
    );
    yield* evidence.json("deployed-through-apps.json", deployed.structuredContent);
    const result = (yield* Schema.decodeUnknownEffect(Saved)(deployed.structuredContent)).execution
      .value.deployed;
    expect(result.app.id).toBe(app);
    expect(result.deployment.id).toBe(result.app.activeDeployment);
  });

layer(HostedLive, { excludeTestServices: true })("Hosted app management contracts", (it) => {
  it.effect(scenarios.appManagementContractsHosted.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient;
        const organization = actors.organization.id;
        const issued = yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
          name: "App management contracts",
        });
        expect(issued.status).toBe(200);
        const token = yield* body(Token, issued);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: token.id })
            .pipe(Effect.orDie),
        );
        const { profile } = yield* managementApp(actors.owner);
        const client = yield* mcp.connect(token.key, "app-management-contracts", { organization });
        const app = yield* authorApp(client, profile.id, organization);
        yield* api.request(
          actors.owner,
          "DELETE",
          `/api/organizations/${organization}/apps/${app}`,
        );
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});

layer(TestLive, { excludeTestServices: true })("Local app management contracts", (it) => {
  it.effect(scenarios.appManagementContractsLocal.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          mcp = yield* McpClient;
        const session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const apps = yield* body(
          Schema.Array(Schema.Struct({ id: Schema.String, slug: Schema.String })),
          yield* session.send("GET", "/v1/apps", undefined, headers),
        );
        const executorApp = apps.find((app) => app.slug === "executor");
        if (executorApp === undefined)
          return yield* Effect.die("The local Executor app is missing");
        const profiles = yield* body(
          Schema.Array(Schema.Struct({ id: Schema.String })),
          yield* session.send("GET", `/v1/apps/${executorApp.id}/profiles`, undefined, headers),
        );
        const profile = profiles[0];
        if (profiles.length !== 1 || profile === undefined)
          return yield* Effect.die("The local Executor profile is missing");
        const client = yield* mcp.connect(target.apiKey, "app-management-contracts");
        const app = yield* authorApp(client, profile.id);
        yield* deployThroughApps(client, profile.id, app);
        yield* session.send("DELETE", `/v1/apps/${app}`, undefined, headers);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
