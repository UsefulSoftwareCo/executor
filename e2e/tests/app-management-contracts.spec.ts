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
    commit: Schema.String,
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
      app: Schema.Struct({ id: Schema.String, activeVersion: Schema.String }),
    }),
    files: Schema.Array(File),
  }),
);
/** A save reports how many files it removed and lists the first, however many it removed. */
const Removals = Schema.Struct({ count: Schema.Number, paths: Schema.Array(Schema.String) });
const Greeted = Completed(Schema.Struct({ message: Schema.Literal("Hello") }));
/** Writes describe what they saved instead of echoing the files, which grow with the app. */
const Saved = Completed(
  Schema.Struct({
    saved: Schema.Struct({
      revision: Schema.Struct({ commit: Schema.String }),
      removed: Removals,
      files: Schema.optional(Schema.Never),
    }),
    deployed: Schema.Struct({
      app: Schema.Struct({ id: Schema.String, activeVersion: Schema.String }),
      version: Schema.Struct({ id: Schema.String, files: Schema.optional(Schema.Never) }),
    }),
  }),
);
const Commit = Schema.Struct({
  revision: Schema.Struct({ commit: Schema.String }),
  removed: Removals,
});
/** A save names the files it removed, and the documented restore brings back the same file. */
const Removed = Completed(
  Schema.Struct({
    trimmed: Commit,
    restored: Commit,
    working: Schema.String,
    same: Schema.Boolean,
  }),
);
/** A refused save leaves the working revision where it was. */
const Refused = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      response: Schema.Struct({
        code: Schema.String,
        status: Schema.Number,
        message: Schema.String,
      }),
    }),
  }),
});
const Unchanged = Completed(Schema.Struct({ before: Schema.String, after: Schema.String }));
const Kept = Completed(
  Schema.Struct({
    before: Schema.String,
    after: Schema.String,
    kept: Schema.NullOr(Schema.String),
  }),
);
/** The commit result itself, returned straight from execute. */
const Committed = Completed(Commit);
const Located = Completed(Schema.Unknown);
/** A created app; its other fields are not under test here. */
const Made = Completed(Schema.Struct({ id: Schema.String }));
type Connection = Effect.Success<ReturnType<Effect.Success<typeof McpClient>["connect"]>>;

/** Local routes have no organization, and their tools accept no empty path. */
const routes = (organization?: string) => {
  const tenant = organization === undefined ? {} : { organization };
  return { tenant, scope: organization === undefined ? {} : { path: tenant } };
};

/** One execute program with the Executor app in scope; the result is its structured content. */
const executeIn = (client: Connection) => (step: string, code: string) =>
  client
    .use(step, (client, signal) =>
      client.callTool(
        { name: "execute", arguments: { code: `const executor = tools.executor;\n${code}` } },
        undefined,
        { signal },
      ),
    )
    .pipe(Effect.map((result) => result.structuredContent));

/** deploy.md's MCP example: index.ts and a package.json pinning the reported version. */
const documentedFiles = `[
  { path: "index.ts", content: ${JSON.stringify(helloIndex)} },
  { path: "package.json", content: JSON.stringify({ name: "hello", private: true, type: "module", dependencies: { apps: version } }) },
]`;

/**
 * Follow deploy.md: discover the catalog's constraints and the host's apps release, then create
 * the two-file app with files and deploy it. Create without files is refused. Later commit and
 * deploy results stay objects after the source outgrows an execute result. On hosted products
 * the tool-only app's location says it has no UI.
 */
const deployApp = (client: Connection, organization?: string) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence;
    const execute = executeIn(client);
    const { tenant, scope } = routes(organization);

    const discovered = yield* execute(
      "Discover the catalog, the apps release and create",
      `const find = async (query, path) => {
  const item = (await tools.search({ query, limit: 20 })).items.find((item) => item.path.endsWith(path));
  return item === undefined ? undefined : (await tools.search.describe({ paths: [item.path] })).items[0];
};
const found = await tools.search({ query: "framework.release" });
const create = await find("appManagement.create", ".appManagement.create");
const catalog = await find("appManagement.catalog", ".appManagement.catalog");
const commit = await find("appManagement.commit", ".appManagement.commit");
const release = await executor.framework.release(${JSON.stringify(scope)});
return { catalog: catalog?.signature, commit: commit?.signature, found: found.items.map(({ path, description }) => ({ path, description })), create: create?.signature, release };`,
    );
    yield* evidence.json("discovered.json", discovered);
    const found = (yield* Schema.decodeUnknownEffect(Discovered)(discovered)).execution.value;
    // A plain service name fails the optional name filter's pattern, so its input must show it.
    const [input] = found.catalog.split("): Promise<");
    expect(input).toMatch(/@pattern \^@\[a-z0-9\][^\n]*\n\s*name\?: string \| null/);
    // An app path parameter takes the app's ID, and its signature says so.
    expect(found.commit).toContain("App ID, such as app_…, from the app's `id`.");
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

    // A request Executor's API rejects against its operation's schema states where and why,
    // instead of a 400 the document does not declare. The input schema cannot express a root
    // index.ts, so the call reaches Executor.
    const unrooted = yield* execute(
      "Create an app without a root index.ts",
      `return await executor.appManagement.create({ ...${JSON.stringify(scope)}, body: { name: ${JSON.stringify(name)}, files: [{ path: "src/index.ts", content: "export default {};" }] } });`,
    );
    yield* evidence.json("create-without-root-index.json", unrooted);
    const unrootedFailure = (yield* Schema.decodeUnknownEffect(Refused)(unrooted)).execution.error
      .response;
    expect(unrootedFailure).toMatchObject({ code: "RequestInvalid", status: 400 });
    expect(unrootedFailure.message).toContain(
      "Executor rejected this request's body because it does not match the operation's schema: $.files: expected a root index.ts.",
    );
    // A local CLI agent's guess at the format of `links`, a JSON array of account links.
    if (organization === undefined) {
      const health = yield* execute(
        "List account health with links as a flag",
        `return await executor.accounts.listHealth({ query: { links: "true" } });`,
      );
      yield* evidence.json("account-health-links-flag.json", health);
      const healthFailure = (yield* Schema.decodeUnknownEffect(Refused)(health)).execution.error
        .response;
      expect(healthFailure).toMatchObject({ code: "RequestInvalid", status: 400 });
      expect(healthFailure.message).toContain("this request's query");
      expect(healthFailure.message).toContain("$.links");
    }

    const created = yield* execute(
      "Create and deploy the documented two-file app",
      `const { version } = await executor.framework.release(${JSON.stringify(scope)});
const files = ${documentedFiles};
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
const saved = await executor.appManagement.commit({ path, body: { expected: source.revision.commit, files: [...source.files, { path: "reference.md", content: "x".repeat(110000) }], message: "Add a large reference" } });
const deployed = await executor.appManagement.deploy({ path, body: { commit: saved.revision.commit } });
return { saved, deployed };`,
    );
    yield* evidence.json("deployed.json", deployed);
    const large = (yield* Schema.decodeUnknownEffect(Saved)(deployed)).execution.value;
    expect(large.saved.removed).toEqual({ count: 0, paths: [] });
    expect(large.deployed.app.id).toBe(app.app.id);
    expect(large.deployed.version.id).toBe(large.deployed.app.activeVersion);

    // ui.md: a hosted app without a UI has no address, and the location says why.
    if (organization !== undefined) {
      const location = yield* execute(
        "Get the URL of the tool-only app",
        `return await executor.appUi.location({ path: ${JSON.stringify({ organization, app: app.app.id })} });`,
      );
      yield* evidence.json("location.json", location);
      expect((yield* Schema.decodeUnknownEffect(Located)(location)).execution.value).toEqual({
        status: "unavailable",
        url: null,
        reason: "no_ui",
      });
    }
    return app.app.id;
  });

/** The documented two-file app with the large reference the saves below remove, not deployed. */
const createWithReference = (client: Connection, organization: string) =>
  Effect.gen(function* () {
    const { scope } = routes(organization);
    const created = yield* executeIn(client)(
      "Create an app with a large reference",
      `const { version } = await executor.framework.release(${JSON.stringify(scope)});
const files = [...${documentedFiles}, { path: "reference.md", content: "x".repeat(110000) }];
return await executor.appManagement.create({ ...${JSON.stringify(scope)}, body: { name: ${JSON.stringify(`Hello ${randomUUID().slice(0, 8)}`)}, files } });`,
    );
    return (yield* Schema.decodeUnknownEffect(Made)(created)).execution.value.id;
  });

/**
 * Saves of an app whose source has `reference.md`. A save that leaves a file out names it in
 * `removed`, and committing it again restores its contents. A save that nests a file under a
 * file, or names a path that is not valid Unicode, is refused and keeps the existing files.
 * Dropping 600 files reports the count and the first 100 paths in an untruncated result, and
 * dropping files with escaped names lists fewer to keep the JSON small.
 */
const saveSource = (client: Connection, app: string, organization?: string) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence;
    const execute = executeIn(client);
    const path = JSON.stringify({ ...routes(organization).tenant, app });

    // deploy.md: a complete file list deletes what it leaves out, and the result names it before
    // anything is deployed. Committing the file again restores it.
    const removal = yield* execute(
      "Save the source without a file, then restore it",
      `const path = ${path};
const source = await executor.appManagement.source({ path });
const trimmed = await executor.appManagement.commit({ path, body: { expected: source.revision.commit, files: source.files.filter((file) => file.path !== "reference.md"), message: "Drop the reference" } });
const restored = await executor.appManagement.commit({ path, body: { expected: trimmed.revision.commit, files: source.files, message: "Restore the reference" } });
const working = await executor.appManagement.source({ path });
const content = (files) => files.find((file) => file.path === "reference.md")?.content;
return { trimmed, restored, working: working.revision.commit, same: content(working.files) !== undefined && content(working.files) === content(source.files) };`,
    );
    yield* evidence.json("removal.json", removal);
    const { trimmed, restored, working, same } = (yield* Schema.decodeUnknownEffect(Removed)(
      removal,
    )).execution.value;
    expect(trimmed.removed).toEqual({ count: 1, paths: ["reference.md"] });
    expect(restored.removed).toEqual({ count: 0, paths: [] });
    expect(working).toBe(restored.revision.commit);
    expect(same).toBe(true);

    // Git stores a path as a file or a folder, never both, so a save that nests a file under
    // an existing file is refused before anything is written, naming both paths.
    const conflicted = yield* execute(
      "Save a file inside a path that is a file",
      `const path = ${path};
const source = await executor.appManagement.source({ path });
return await executor.appManagement.commit({ path, body: { expected: source.revision.commit, files: [...source.files, { path: "reference.md/part.md", content: "part" }], message: "Nest a file" } });`,
    );
    yield* evidence.json("path-conflict.json", conflicted);
    const conflict = (yield* Schema.decodeUnknownEffect(Refused)(conflicted)).execution.error
      .response;
    expect(conflict).toMatchObject({ code: "SourcePathConflict", status: 400 });
    expect(conflict.message).toBe(
      "The files use reference.md as both a file and a folder: reference.md/part.md is inside it. Git can store only one of them. Rename or remove one, then save again. Nothing was saved.",
    );
    // Only public files may be stored entries; an ordinary text file sent as one is rejected,
    // naming the file.
    const stored = yield* execute(
      "Save a text file as a stored entry",
      `const path = ${path};
const source = await executor.appManagement.source({ path });
return await executor.appManagement.commit({ path, body: { expected: source.revision.commit, files: [...source.files, { path: "notes.md", object: "${"a".repeat(40)}", size: 4 }], message: "Store a note" } });`,
    );
    yield* evidence.json("stored-text-file.json", stored);
    const storedFailure = (yield* Schema.decodeUnknownEffect(Refused)(stored)).execution.error
      .response;
    expect(storedFailure).toMatchObject({ code: "RequestInvalid", status: 400 });
    expect(storedFailure.message).toContain(
      "$.files: expected notes.md to be UTF-8 text: only files under ui/public/ may be binary or stored",
    );
    const unchanged = yield* execute(
      "Read the working revision after the refused save",
      `const path = ${path};
const source = await executor.appManagement.source({ path });
return { before: ${JSON.stringify(restored.revision.commit)}, after: source.revision.commit };`,
    );
    const revisions = (yield* Schema.decodeUnknownEffect(Unchanged)(unchanged)).execution.value;
    expect(revisions.after).toBe(revisions.before);

    // Git stores UTF-8 paths. A lone surrogate would encode as U+FFFD and overwrite the kept
    // `assets\uFFFD` file, so the save is refused and the file and revision survive.
    const kept = yield* execute(
      "Save a file named with U+FFFD",
      `const path = ${path};
const source = await executor.appManagement.source({ path });
return await executor.appManagement.commit({ path, body: { expected: source.revision.commit, files: [...source.files, { path: "assets\\uFFFD", content: "kept" }], message: "Keep a file" } });`,
    );
    const keptRevision = (yield* Schema.decodeUnknownEffect(Committed)(kept)).execution.value
      .revision.commit;
    const lone = yield* execute(
      "Save a path with a lone surrogate",
      `const path = ${path};
const source = await executor.appManagement.source({ path });
return await executor.appManagement.commit({ path, body: { expected: source.revision.commit, files: [...source.files, { path: "assets\\uD800/logo.txt", content: "logo" }], message: "Add a logo" } });`,
    );
    yield* evidence.json("lone-surrogate.json", lone);
    const notUnicode = (yield* Schema.decodeUnknownEffect(Refused)(lone)).execution.error.response;
    expect(notUnicode).toMatchObject({ code: "SourcePathNotUnicode", status: 400 });
    expect(notUnicode.message).toBe(
      'The file path "assets\\ud800/logo.txt" is not valid Unicode: it has a lone surrogate, a \\uD800-\\uDFFF character without its pair. Git stores paths as UTF-8, which cannot hold it. Rename the file, then save again. Nothing was saved.',
    );
    const survived = yield* execute(
      "Read the kept file after the refused save",
      `const path = ${path};
const source = await executor.appManagement.source({ path });
return { before: ${JSON.stringify(keptRevision)}, after: source.revision.commit, kept: source.files.find((file) => file.path === "assets\\uFFFD")?.content ?? null };`,
    );
    expect((yield* Schema.decodeUnknownEffect(Kept)(survived)).execution.value).toEqual({
      before: keptRevision,
      after: keptRevision,
      kept: "kept",
    });

    // A save that drops many files reports the count and the first paths, so the commit result
    // returned from execute stays an object instead of a truncated string. The drop commits the
    // files read before the notes, as the restore above does, without reading 600 notes back.
    const dropped = yield* execute(
      "Save 600 notes, then save the source without them",
      `const path = ${path};
const source = await executor.appManagement.source({ path });
const notes = Array.from({ length: 600 }, (_, n) => ({ path: \`notes/\${String(n).padStart(3, "0")}-${"n".repeat(100)}.md\`, content: String(n) }));
const added = await executor.appManagement.commit({ path, body: { expected: source.revision.commit, files: [...source.files, ...notes], message: "Add notes" } });
return await executor.appManagement.commit({ path, body: { expected: added.revision.commit, files: source.files, message: "Drop the notes" } });`,
    );
    yield* evidence.json("many-removed.json", dropped);
    const many = (yield* Schema.decodeUnknownEffect(Committed)(dropped)).execution.value;
    expect(many.removed.count).toBe(600);
    expect(many.removed.paths).toHaveLength(100);
    expect(many.removed.paths[0]).toBe(`notes/000-${"n".repeat(100)}.md`);
    expect(many.removed.paths[99]).toBe(`notes/099-${"n".repeat(100)}.md`);

    // JSON escapes a control character as six bytes, so the listed paths are bounded by their
    // encoded size: 100 paths of 150 U+0001 each would be over 90 KB, past an execute result.
    const escaped = yield* execute(
      "Save 100 files named with control characters, then save the source without them",
      `const path = ${path};
const source = await executor.appManagement.source({ path });
const controls = Array.from({ length: 100 }, (_, n) => ({ path: \`controls/\${String(n).padStart(3, "0")}-\${"\\u0001".repeat(150)}.md\`, content: String(n) }));
const added = await executor.appManagement.commit({ path, body: { expected: source.revision.commit, files: [...source.files, ...controls], message: "Add control files" } });
return await executor.appManagement.commit({ path, body: { expected: added.revision.commit, files: source.files, message: "Drop the control files" } });`,
    );
    yield* evidence.json("escaped-removed.json", escaped);
    const controls = (yield* Schema.decodeUnknownEffect(Committed)(escaped)).execution.value;
    const control = (n: number) =>
      `controls/${String(n).padStart(3, "0")}-${"\u0001".repeat(150)}.md`;
    expect(controls.removed.count).toBe(100);
    // Each path is 918 bytes of JSON, so 17 fit the 16 KiB budget with their commas.
    expect(controls.removed.paths).toEqual(Array.from({ length: 17 }, (_, n) => control(n)));
    expect(
      new TextEncoder().encode(JSON.stringify(controls.removed.paths)).length,
    ).toBeLessThanOrEqual(16 * 1024);
  });

/** deploy.md's local example deploys through `apps.deploy`; local `apps.commit` saves the same way. */
const deployThroughApps = (client: Connection, app: string) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence;
    const deployed = yield* client.use("Deploy a large source through apps", (client, signal) =>
      client.callTool(
        {
          name: "execute",
          arguments: {
            code: `const executor = tools.executor;
const path = { app: ${JSON.stringify(app)} };
const { owner } = await executor.apps.get({ path });
const source = await executor.apps.workspace({ path, query: { owner } });
const files = source.files.map((file) => file.path === "reference.md" ? { ...file, content: "y".repeat(110000) } : file);
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
    expect(result.version.id).toBe(result.app.activeVersion);
  });

/**
 * The owner's API key and management app, an MCP session on its organization, and app removal.
 * Deploys and saves are separate cases: on a deployed Cloud stage, each runs about 30 seconds of
 * sequential Git and build work, and together they reached the 60-second limit.
 */
const hostedAgent = Effect.gen(function* () {
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
  yield* managementApp(actors.owner);
  const client = yield* mcp.connect(token.key, "app-management-contracts", { organization });
  const remove = (app: string) =>
    api.request(actors.owner, "DELETE", `/api/organizations/${organization}/apps/${app}`);
  return { client, organization, remove };
});

layer(HostedLive, { excludeTestServices: true })("Hosted app management contracts", (it) => {
  it.effect(scenarios.appManagementContractsHosted.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { client, organization, remove } = yield* hostedAgent;
        yield* remove(yield* deployApp(client, organization));
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.appManagementSavesHosted.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { client, organization, remove } = yield* hostedAgent;
        const app = yield* createWithReference(client, organization);
        yield* saveSource(client, app, organization);
        yield* remove(app);
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
        const client = yield* mcp.connect(target.apiKey, "app-management-contracts");
        const app = yield* deployApp(client);
        yield* saveSource(client, app);
        yield* deployThroughApps(client, app);
        yield* session.send("DELETE", `/v1/apps/${app}`, undefined, headers);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
