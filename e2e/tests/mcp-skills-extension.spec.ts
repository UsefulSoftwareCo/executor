import { expect, layer } from "@effect/vitest";
import type { Skill } from "@modelcontextprotocol/client/ext/skills";
import { Effect, Layer, Redacted, Schedule, Schema } from "effect";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, TestLive, withCase, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence, Telemetry, type DeliveredSpan } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { ConnectionView, consentTo, revokeClientGrants } from "../support/mcp-connections.ts";
import { pairLocalOperator } from "../support/mcp-consent.ts";
import { McpSkillsClient } from "../support/mcp-skills-client.ts";
import { Target } from "../support/platform.ts";

const Token = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });
const Access = Schema.Struct({
  audience: Schema.Struct({ kind: Schema.String }),
  revision: Schema.String,
});
const Source = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});
const INVALID_PARAMS = -32602;
const RESOURCE_NOT_FOUND = -32002;

const skillMd = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
const skillAppFiles = (skill: string, marker: string) => [
  {
    path: "index.ts",
    content: 'import { defineApp } from "apps"; export default defineApp({}, async () => ({}));',
  },
  {
    path: `skills/${skill}/SKILL.md`,
    content: skillMd(
      skill,
      `Synthetic ${skill} instructions.`,
      `Read [notes](references/deep/notes.md). ${marker}`,
    ),
  },
  { path: `skills/${skill}/references/deep/notes.md`, content: `Notes ${marker} ✓\n` },
  { path: `skills/${skill}/references/Q&A #1.md`, content: `Answers ${marker}\n` },
  appsManifest,
];
const loaderAppFiles = (loader: string) => [
  {
    path: "index.ts",
    content: `import { defineApp, dynamicSkills } from "apps";
export default defineApp({}, async (ctx) => ({ dynamicSkills: dynamicSkills({ list: async () => { ${loader} } }) }));`,
  },
  appsManifest,
];
const failingLoader = 'throw new Error("synthetic skill source failure");';
const stalledLoader = "await new Promise(() => {}); return [];";
const slowLoader = `await ctx.cache.read?.("slow-skills");
await new Promise((done) => setTimeout(done, 6500));
return [{ name: "slow-guide", description: "Synthetic slow instructions.", files: [{ path: "SKILL.md", content: "---\\nname: slow-guide\\ndescription: Synthetic slow instructions.\\n---\\nSlow.\\n" }] }];`;

const sha256 = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const uris = (skills: ReadonlyArray<Skill>) => skills.map((skill) => skill.uri);

const readEveryFile = (
  client: Effect.Success<ReturnType<(typeof McpSkillsClient.Service)["connect"]>>,
  skills: ReadonlyArray<Skill>,
) =>
  Effect.forEach(skills, (skill) =>
    Effect.forEach(skill.resources === "dynamic" ? [] : skill.resources, (resource) =>
      client
        .use(`Read ${resource.uri}`, (skills) => skills.read(skill, resource.uri))
        .pipe(
          Effect.tap((file) =>
            Effect.sync(() => {
              expect(file.verified).toBe(true);
              expect(file.bytes.byteLength).toBe(resource.size);
              expect(sha256(file.bytes)).toBe(resource.digest);
            }),
          ),
        ),
    ),
  );

layer(HostedLive, { excludeTestServices: true })("MCP Skills extension", (it) => {
  it.effect(scenarios.mcpSkillsExtension.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          skillsClients = yield* McpSkillsClient,
          mcp = yield* McpClient,
          browser = yield* Browser,
          oauth = yield* McpOAuth;
        const organization = actors.organization.id,
          prefix = `/api/organizations/${organization}`;
        const marker = randomUUID();
        const keys: { actor: Session; id: string }[] = [];
        const created: (typeof App.Type)[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const app of created)
              yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`);
            for (const key of keys)
              yield* api.request(key.actor, "POST", "/api/auth/api-key/delete", { keyId: key.id });
          }).pipe(Effect.orDie),
        );
        const keyFor = (actor: Session) =>
          Effect.gen(function* () {
            const response = yield* api.request(actor, "POST", "/api/auth/api-key/create", {
              name: "MCP skills extension",
            });
            expect(response.status).toBe(200);
            const token = yield* body(Token, response);
            keys.push({ actor, id: token.id });
            return token.key;
          });
        const deploy = (name: string, files: ReadonlyArray<{ path: string; content: string }>) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `${name} ${marker.slice(0, 8)}`,
              files,
            });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const app = yield* body(App, response);
            created.push(app);
            return app;
          });
        const [shared, hidden, failing, stalled] = yield* Effect.all(
          [
            deploy("Shared skills", skillAppFiles("shared-guide", marker)),
            deploy("Private skills", skillAppFiles("private-plan", marker)),
            deploy("Failing skills", loaderAppFiles(failingLoader)),
            deploy("Stalled skills", loaderAppFiles(stalledLoader)),
          ],
          { concurrency: 4 },
        );
        const access = yield* body(
          Access,
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${hidden.id}/access`),
        );
        expect(access.audience.kind).toBe("private");
        const sharing = yield* body(
          Access,
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${shared.id}/access`),
        );
        const shareResponse = yield* api.request(
          actors.owner,
          "PATCH",
          `${prefix}/apps/${shared.id}/access`,
          { audience: { kind: "everyone" }, revision: sharing.revision },
        );
        expect(shareResponse.status, JSON.stringify(shareResponse.body)).toBe(200);
        for (const app of [shared, hidden]) {
          const bundle = yield* api.request(
            actors.owner,
            "GET",
            `${prefix}/apps/${app.id}/skill-bundle`,
          );
          expect(bundle.status, JSON.stringify(bundle.body)).toBe(200);
        }
        const [ownerKey, memberKey] = yield* Effect.all([
          keyFor(actors.owner),
          keyFor(actors.member),
        ]);
        const sharedGuide = `skill://${shared.slug}/shared-guide/SKILL.md`;
        const privatePlan = `skill://${hidden.slug}/private-plan/SKILL.md`;

        const owner = yield* skillsClients.connect(ownerKey, "owner", {
          revision: "2026-07-28",
          organization,
        });
        expect(owner.revision).toBe("2026-07-28");
        const capabilities = owner.client.getServerCapabilities();
        expect(capabilities?.extensions?.["io.modelcontextprotocol/skills"]).toEqual({
          directoryRead: true,
        });
        expect(capabilities?.resources).toBeDefined();
        const listing = yield* owner.use("List the owner's skills", (skills) => skills.list());
        yield* evidence.json("owner-listing.json", listing);
        expect(listing.invalid).toEqual([]);
        expect(listing.cacheScope).toBe("private");
        const listed = uris(listing.skills);
        expect(listed).toEqual(
          expect.arrayContaining([sharedGuide, privatePlan, "skill://executor/executor/SKILL.md"]),
        );
        expect(listed.some((uri) => uri.startsWith(`skill://${failing.slug}/`))).toBe(false);
        expect(listed.some((uri) => uri.startsWith(`skill://${stalled.slug}/`))).toBe(false);
        const own = listing.skills.filter((skill) =>
          [sharedGuide, privatePlan].includes(skill.uri),
        );
        expect(own.map((skill) => skill.resources)).toEqual(
          own.map(() =>
            expect.arrayContaining([expect.objectContaining({ size: expect.any(Number) })]),
          ),
        );
        yield* readEveryFile(owner, listing.skills);
        const guideEntry = own.find((skill) => skill.uri === sharedGuide)!;
        const notes = yield* owner.use("Read the nested reference", (skills) =>
          skills.read(guideEntry, "references/deep/notes.md"),
        );
        expect(notes.text).toBe(`Notes ${marker} ✓\n`);
        expect(
          guideEntry.resources === "dynamic"
            ? []
            : guideEntry.resources.map((resource) => resource.uri),
        ).toContain(`skill://${shared.slug}/shared-guide/references/Q%26A%20%231.md`);
        const answers = yield* owner.use(
          "Read a file whose name has reserved characters",
          (skills) =>
            skills.read(
              guideEntry,
              `skill://${shared.slug}/shared-guide/references/Q%26A%20%231.md`,
            ),
        );
        expect(answers.text).toBe(`Answers ${marker}\n`);
        const got = yield* owner.use("Get one skill", (skills) => skills.get(sharedGuide));
        expect(got.skill).toEqual(guideEntry);
        const directory = yield* owner.use("Read a skill directory", (skills) =>
          skills.readDirectory(`skill://${shared.slug}/shared-guide/references`),
        );
        expect(directory.resources.map((entry) => entry.uri).toSorted()).toEqual([
          `skill://${shared.slug}/shared-guide/references/Q%26A%20%231.md`,
          `skill://${shared.slug}/shared-guide/references/deep`,
        ]);

        const refusals = yield* Effect.all({
          unknownSkill: owner.refusal("Get a skill the app does not have", (skills) =>
            skills.get(`skill://${shared.slug}/no-such-skill/SKILL.md`),
          ),
          unknownApp: owner.refusal("Get a skill of no app", (skills) =>
            skills.get("skill://no-such-app/shared-guide/SKILL.md"),
          ),
          notSkillMd: owner.refusal("Get a skill by a file that is not its SKILL.md", (skills) =>
            skills.get(`skill://${shared.slug}/shared-guide/references/deep/notes.md`),
          ),
          malformed: owner.refusal("Get a URI that is not a skill URI", (skills) =>
            skills.get("not a skill uri"),
          ),
          unknownFile: owner.refusal("Read a file the skill does not have", (_, client) =>
            client.readResource({ uri: `skill://${shared.slug}/shared-guide/missing.md` }),
          ),
          traversal: owner.refusal("Read a path that leaves the skill", (_, client) =>
            client.readResource({
              uri: `skill://${shared.slug}/shared-guide/../private-plan/SKILL.md`,
            }),
          ),
          notDirectory: owner.refusal("Read a file as a directory", (skills) =>
            skills.readDirectory(sharedGuide),
          ),
        });
        expect(refusals).toEqual({
          unknownSkill: INVALID_PARAMS,
          unknownApp: INVALID_PARAMS,
          notSkillMd: INVALID_PARAMS,
          malformed: INVALID_PARAMS,
          unknownFile: INVALID_PARAMS,
          traversal: INVALID_PARAMS,
          notDirectory: INVALID_PARAMS,
        });

        const member = yield* skillsClients.connect(memberKey, "member", {
          revision: "2026-07-28",
          organization,
        });
        const memberListing = yield* member.use("List the member's skills", (skills) =>
          skills.list(),
        );
        yield* evidence.json("member-listing.json", memberListing);
        const memberListed = uris(memberListing.skills);
        expect(memberListed).toContain(sharedGuide);
        expect(memberListed.some((uri) => uri.startsWith(`skill://${hidden.slug}/`))).toBe(false);
        expect(
          yield* Effect.all({
            get: member.refusal("The member gets the owner's private skill", (skills) =>
              skills.get(privatePlan),
            ),
            read: member.refusal("The member reads the owner's private skill", (_, client) =>
              client.readResource({ uri: privatePlan }),
            ),
          }),
        ).toEqual({ get: INVALID_PARAMS, read: INVALID_PARAMS });

        yield* browser.login(actors.owner);
        const grant = yield* oauth.authorize;
        const granted = yield* skillsClients.connect(
          Redacted.make(Redacted.value(grant.tokens).access_token),
          "owner-oauth",
          { revision: "2026-07-28" },
        );
        const grants = yield* body(
          Schema.Array(
            Schema.Struct({ clientId: Schema.String, grant: Schema.Struct({ id: Schema.String }) }),
          ),
          yield* api.request(actors.owner, "GET", "/api/auth/mcp/grants"),
        );
        const record = grants.find((item) => item.clientId === grant.clientId);
        if (record === undefined) return yield* Effect.die("The OAuth grant was not persisted");
        const narrowed = yield* api.request(actors.owner, "POST", "/api/auth/mcp/grants/narrow", {
          id: record.grant.id,
          policy: {
            kind: "tools",
            approval: "client",
            apps: [{ app: shared.id, tools: { kind: "all" } }],
          },
        });
        expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
        const narrowedListing = yield* granted.use("List the narrowed grant's skills", (skills) =>
          skills.list(),
        );
        expect(uris(narrowedListing.skills)).toEqual([sharedGuide]);
        expect(
          yield* Effect.all({
            get: granted.refusal("Get a skill of an app the grant excludes", (skills) =>
              skills.get(privatePlan),
            ),
            read: granted.refusal("Read a skill of an app the grant excludes", (_, client) =>
              client.readResource({ uri: privatePlan }),
            ),
            executor: granted.refusal(
              "Read the Executor app's skill the grant excludes",
              (_, client) => client.readResource({ uri: "skill://executor/executor/SKILL.md" }),
            ),
            directory: granted.refusal("Read a directory of an app the grant excludes", (skills) =>
              skills.readDirectory(`skill://${hidden.slug}/private-plan/references`),
            ),
          }),
        ).toEqual({
          get: INVALID_PARAMS,
          read: INVALID_PARAMS,
          executor: INVALID_PARAMS,
          directory: INVALID_PARAMS,
        });

        const legacy = yield* skillsClients.connect(ownerKey, "owner-legacy", {
          revision: "2025-11-25",
          organization,
        });
        expect(legacy.revision).toBe("2025-11-25");
        const legacyListing = yield* legacy.use("List skills on 2025-11-25", (skills) =>
          skills.list(),
        );
        expect(uris(legacyListing.skills).toSorted()).toEqual(listed.toSorted());
        yield* readEveryFile(
          legacy,
          legacyListing.skills.filter((skill) => skill.uri === sharedGuide),
        );
        expect(
          yield* legacy.refusal("Read a missing file on 2025-11-25", (_, client) =>
            client.readResource({ uri: `skill://${shared.slug}/shared-guide/missing.md` }),
          ),
        ).toBe(RESOURCE_NOT_FOUND);

        const plain = yield* mcp.connect(ownerKey, "plain", { organization });
        const offered = yield* plain.use("A plain client lists resources", (client, signal) =>
          Promise.all([
            client.listResources(undefined, { signal }),
            client.listResourceTemplates(undefined, { signal }),
          ]),
        );
        expect(offered.map((page) => Object.values(page).find(Array.isArray))).toEqual([[], []]);
      }).pipe(
        Effect.provide(Layer.mergeAll(McpSkillsClient.layer, McpClient.layer, McpOAuth.layer)),
      ),
    ),
  );

  it.effect(scenarios.mcpSkillsExtensionExecutorEdits.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          skillsClients = yield* McpSkillsClient;
        const organization = actors.organization.id,
          prefix = `/api/organizations/${organization}`;
        const response = yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
          name: "MCP skills extension",
        });
        expect(response.status).toBe(200);
        const token = yield* body(Token, response);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: token.id })
            .pipe(Effect.orDie),
        );
        const apps = yield* body(
          Schema.Array(App),
          yield* api.request(actors.owner, "GET", `${prefix}/apps`),
        );
        const executor = apps.find((app) => app.slug === "executor");
        if (executor === undefined)
          return yield* Effect.die("The organization must have its Executor app");
        const source = yield* body(
          Source,
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${executor.id}/source`),
        );
        const marker = randomUUID();
        const deployed = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${executor.id}/deploy`,
          {
            files: [
              ...source.files,
              {
                path: "skills/house-rules/SKILL.md",
                content: skillMd(
                  "house-rules",
                  "This organization's own rules.",
                  `Rules ${marker}.`,
                ),
              },
            ],
          },
        );
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const bundle = yield* api.request(
          actors.owner,
          "GET",
          `${prefix}/apps/${executor.id}/skill-bundle`,
        );
        expect(bundle.status, JSON.stringify(bundle.body)).toBe(200);
        const client = yield* skillsClients.connect(token.key, "executor-edits", {
          revision: "2026-07-28",
          organization,
        });
        const listing = yield* client.use("List the edited Executor app's skills", (skills) =>
          skills.list(),
        );
        const houseRules = listing.skills.find(
          (skill) => skill.uri === "skill://executor/house-rules/SKILL.md",
        );
        expect(houseRules).toBeDefined();
        expect(uris(listing.skills)).toContain("skill://executor/executor/SKILL.md");
        const document = yield* client.use("Read the organization's own Executor skill", (skills) =>
          skills.read(houseRules!),
        );
        expect(document.verified).toBe(true);
        expect(document.body).toContain(`Rules ${marker}.`);
      }).pipe(Effect.provide(McpSkillsClient.layer)),
    ),
  );
});

layer(TestLive, { excludeTestServices: true })("Local MCP Skills extension", (it) => {
  it.effect(scenarios.localMcpSkillsExtension.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          evidence = yield* Evidence,
          skillsClients = yield* McpSkillsClient;
        const operator = yield* pairLocalOperator;
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const marker = randomUUID();
        const deploy = (name: string, files: ReadonlyArray<{ path: string; content: string }>) =>
          Effect.gen(function* () {
            const response = yield* operator.send(
              "POST",
              "/v1/apps/deploy",
              { owner: "local", name: `${name} ${marker.slice(0, 8)}`, files },
              headers,
            );
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const { app } = yield* body(Schema.Struct({ app: App }), response);
            yield* Effect.addFinalizer(() =>
              operator.send("DELETE", `/v1/apps/${app.id}`, undefined, headers).pipe(Effect.orDie),
            );
            return app;
          });
        const [granted, other, failing, slow] = yield* Effect.all(
          [
            deploy("Granted skills", skillAppFiles("granted-guide", marker)),
            deploy("Other skills", skillAppFiles("other-guide", marker)),
            deploy("Failing skills", loaderAppFiles(failingLoader)),
            deploy("Slow skills", loaderAppFiles(slowLoader)),
          ],
          { concurrency: 4 },
        );
        const grantedGuide = `skill://${granted.slug}/granted-guide/SKILL.md`;
        const otherGuide = `skill://${other.slug}/other-guide/SKILL.md`;

        const local = yield* skillsClients.connect(target.apiKey, "local", {
          revision: "2026-07-28",
        });
        const listing = yield* local.use("List every local app's skills", (skills) =>
          skills.list(),
        );
        yield* evidence.json("local-listing.json", listing);
        expect(listing.invalid).toEqual([]);
        const listed = uris(listing.skills);
        expect(listed).toEqual(
          expect.arrayContaining([grantedGuide, otherGuide, "skill://executor/executor/SKILL.md"]),
        );
        expect(listed.some((uri) => uri.startsWith(`skill://${failing.slug}/`))).toBe(false);
        const slowGuide = `skill://${slow.slug}/slow-guide/SKILL.md`;
        expect(listed).not.toContain(slowGuide);
        const later = yield* local
          .use("List again until the slow app's load has finished", (skills) => skills.list())
          .pipe(
            Effect.repeat({
              schedule: Schedule.spaced("500 millis"),
              until: (listing) => uris(listing.skills).includes(slowGuide),
            }),
            Effect.timeout("20 seconds"),
          );
        expect(uris(later.skills)).toContain(slowGuide);
        yield* readEveryFile(local, listing.skills);
        expect(
          yield* local.refusal("Get a skill the app does not have", (skills) =>
            skills.get(`skill://${granted.slug}/no-such-skill/SKILL.md`),
          ),
        ).toBe(INVALID_PARAMS);

        const clients: string[] = [];
        yield* revokeClientGrants(operator, () => clients);
        const created = yield* api.request(operator, "POST", "/dashboard/api/mcp/connections", {
          id: randomUUID(),
          name: "One app",
          apps: [{ app: granted.id, runsAs: [{ kind: "app" }], tools: { kind: "readOnly" } }],
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const connection = yield* body(ConnectionView, created);
        const consent = yield* consentTo(operator, connection.url);
        clients.push(consent.clientId);
        expect(consent.status).toBe(200);
        const tokens = yield* consent.tokens;
        const scoped = yield* skillsClients.connect(tokens, "local-scoped", {
          revision: "2026-07-28",
          connection: connection.id,
        });
        const scopedListing = yield* scoped.use("List the scoped connection's skills", (skills) =>
          skills.list(),
        );
        expect(uris(scopedListing.skills)).toEqual([grantedGuide]);
        expect(
          yield* Effect.all({
            get: scoped.refusal("Get a skill of an app the connection excludes", (skills) =>
              skills.get(otherGuide),
            ),
            read: scoped.refusal("Read a skill of an app the connection excludes", (_, client) =>
              client.readResource({ uri: otherGuide }),
            ),
          }),
        ).toEqual({ get: INVALID_PARAMS, read: INVALID_PARAMS });
      }).pipe(Effect.provide(McpSkillsClient.layer)),
    ),
  );
});

const holdingUpstream = Effect.gen(function* () {
  let arrivals = 0;
  const held: ServerResponse[] = [];
  const server = createServer((request, response) => {
    if (request.url === "/stall") {
      arrivals += 1;
      held.push(response);
      return;
    }
    response.writeHead(404).end();
  });
  const port = yield* Effect.acquireRelease(
    Effect.callback<number>((resume) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resume(
          typeof address === "object" && address !== null
            ? Effect.succeed(address.port)
            : Effect.die("The holding upstream needs a TCP listener"),
        );
      });
    }),
    () =>
      Effect.callback<void>((resume) => {
        for (const response of held) response.destroy();
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );
  return { origin: `http://127.0.0.1:${port}`, arrivals: Effect.sync(() => arrivals) };
});

const gatedUpstream = Effect.gen(function* () {
  let held: ServerResponse[] | undefined;
  let counting = false;
  let arrivals = 0;
  const answer = (response: ServerResponse) => response.writeHead(200).end("open");
  const server = createServer((request, response) => {
    if (request.url !== "/gate") {
      response.writeHead(404).end();
      return;
    }
    if (counting) arrivals += 1;
    if (held === undefined) return answer(response);
    held.push(response);
  });
  const port = yield* Effect.acquireRelease(
    Effect.callback<number>((resume) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resume(
          typeof address === "object" && address !== null
            ? Effect.succeed(address.port)
            : Effect.die("The gated upstream needs a TCP listener"),
        );
      });
    }),
    () =>
      Effect.callback<void>((resume) => {
        for (const response of held ?? []) response.destroy();
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );
  return {
    origin: `http://127.0.0.1:${port}`,
    hold: Effect.sync(() => {
      held = [];
      counting = true;
    }),
    open: Effect.sync(() => {
      for (const response of held ?? []) answer(response);
      held = undefined;
    }),
    arrivals: Effect.sync(() => arrivals),
  };
});
const gatedApps = 10;

layer(HostedLive, { excludeTestServices: true })("MCP Skills extension loads", (it) => {
  it.effect(scenarios.mcpSkillsExtensionLoadsTogether.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry,
          skillsClients = yield* McpSkillsClient;
        const organization = actors.organization.id,
          prefix = `/api/organizations/${organization}`;
        const upstream = yield* gatedUpstream;
        const run = randomUUID().slice(0, 8);
        const deploy = (name: string, loader: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `${name} ${run}`,
              files: loaderAppFiles(loader),
            });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const app = yield* body(App, response);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
            );
            return app;
          });
        const gated = yield* Effect.forEach(
          Array.from({ length: gatedApps }, (_, index) => index),
          (index) =>
            deploy(
              `Gated skills ${index}`,
              `await (await ctx.fetch(${JSON.stringify(`${upstream.origin}/gate`)}, { signal: ctx.signal })).text();
return [{ name: "gated-${index}", description: "Synthetic gated instructions.", files: [{ path: "SKILL.md", content: ${JSON.stringify(skillMd(`gated-${index}`, "Synthetic gated instructions.", "Gated."))} }] }];`,
            ),
          { concurrency: 4 },
        );
        yield* Effect.forEach(
          gated,
          (app) =>
            api
              .request(actors.owner, "GET", `${prefix}/apps/${app.id}/skill-bundle`)
              .pipe(
                Effect.tap((response) =>
                  Effect.sync(() =>
                    expect(response.status, JSON.stringify(response.body)).toBe(200),
                  ),
                ),
              ),
          { concurrency: 4 },
        );
        const created = yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
          name: "MCP skills extension loads",
        });
        expect(created.status).toBe(200);
        const token = yield* body(Token, created);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: token.id })
            .pipe(Effect.orDie),
        );
        const client = yield* skillsClients.connect(token.key, "loads-together", {
          revision: "2026-07-28",
          organization,
        });

        yield* upstream.hold;
        let listings = 1;
        const listing = yield* client.use("List while the gate holds every load", (skills) =>
          skills.list(),
        );
        yield* evidence.json("gated-listing.json", listing);
        const started = yield* upstream.arrivals;
        expect(started).toBeGreaterThanOrEqual(2);
        expect(started).toBeLessThan(gatedApps);
        const listed = uris(listing.skills);
        const gatedGuides = gated.map(
          (app, index) => `skill://${app.slug}/gated-${index}/SKILL.md`,
        );
        expect(listed.filter((uri) => gatedGuides.includes(uri))).toEqual([]);

        yield* upstream.open;
        expect(
          yield* upstream.arrivals.pipe(
            Effect.repeat({
              schedule: Schedule.spaced("100 millis"),
              until: (count) => count >= gatedApps,
            }),
            Effect.timeout("30 seconds"),
          ),
        ).toBe(gatedApps);
        const later = yield* client
          .use("List again until every gated app is served", (skills) => skills.list())
          .pipe(
            Effect.tap(() => Effect.sync(() => (listings += 1))),
            Effect.repeat({
              schedule: Schedule.spaced("500 millis"),
              until: (listing) => gatedGuides.every((uri) => uris(listing.skills).includes(uri)),
            }),
            Effect.timeout("30 seconds"),
          );
        expect(uris(later.skills)).toEqual(expect.arrayContaining(gatedGuides));

        const first = yield* telemetry.search("mcp.skills.extension.list", { organization }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("250 millis"),
            until: (found) => found.data.length >= listings,
          }),
          Effect.map(
            (found) =>
              found.data.toSorted((a, b) => a.span.startTime.localeCompare(b.span.startTime))[0],
          ),
          Effect.timeout("30 seconds"),
        );
        const loaded = (spans: ReadonlyArray<DeliveredSpan>) => {
          const children = new Map<string, Array<DeliveredSpan>>();
          for (const span of spans)
            if (span.parentSpanId !== null)
              children.set(span.parentSpanId, [...(children.get(span.parentSpanId) ?? []), span]);
          const below = (span: DeliveredSpan): Array<DeliveredSpan> =>
            (children.get(span.spanId) ?? []).flatMap((child) => [child, ...below(child)]);
          const listing = spans.find((span) => span.spanId === first!.span.spanId);
          return new Set(
            (listing === undefined ? [] : below(listing))
              .filter((span) => span.operationName === "sdk.skills.bundle" && span.status === "ok")
              .flatMap((bundle) => below(bundle).map((span) => span.tags["executor.app.id"])),
          );
        };
        const spans = yield* telemetry.settled(first!.traceId, (spans) =>
          gated.every((app) => loaded(spans).has(app.id)),
        );
        yield* evidence.json("gated-listing-spans.json", spans);
        expect(gated.filter((app) => !loaded(spans).has(app.id))).toEqual([]);
      }).pipe(Effect.provide(McpSkillsClient.layer)),
    ),
  );

  it.effect(scenarios.mcpSkillsExtensionStalledLoad.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          skillsClients = yield* McpSkillsClient;
        const organization = actors.organization.id,
          prefix = `/api/organizations/${organization}`;
        const upstream = yield* holdingUpstream;
        const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Stalled source ${randomUUID().slice(0, 8)}`,
          files: loaderAppFiles(
            `await ctx.fetch(${JSON.stringify(`${upstream.origin}/stall`)}, { signal: ctx.signal }); return [];`,
          ),
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const app = yield* body(App, response);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const access = yield* body(
          Access,
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/access`),
        );
        const shared = yield* api.request(
          actors.owner,
          "PATCH",
          `${prefix}/apps/${app.id}/access`,
          {
            audience: { kind: "everyone" },
            revision: access.revision,
          },
        );
        expect(shared.status, JSON.stringify(shared.body)).toBe(200);
        const privateResponse = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Owner only ${randomUUID().slice(0, 8)}`,
          files: skillAppFiles("owner-only", randomUUID()),
        });
        expect(privateResponse.status, JSON.stringify(privateResponse.body)).toBe(200);
        const ownerOnly = yield* body(App, privateResponse);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${ownerOnly.id}`).pipe(Effect.orDie),
        );
        const warmed = yield* api.request(
          actors.owner,
          "GET",
          `${prefix}/apps/${ownerOnly.id}/skill-bundle`,
        );
        expect(warmed.status, JSON.stringify(warmed.body)).toBe(200);
        const keyFor = (actor: Session) =>
          Effect.gen(function* () {
            const created = yield* api.request(actor, "POST", "/api/auth/api-key/create", {
              name: "MCP skills extension",
            });
            expect(created.status).toBe(200);
            const token = yield* body(Token, created);
            yield* Effect.addFinalizer(() =>
              api
                .request(actor, "POST", "/api/auth/api-key/delete", { keyId: token.id })
                .pipe(Effect.orDie),
            );
            return token.key;
          });
        const [ownerKey, memberKey] = yield* Effect.all([
          keyFor(actors.owner),
          keyFor(actors.member),
        ]);
        const memberApps = yield* body(
          Schema.Array(App),
          yield* api.request(actors.member, "GET", `${prefix}/apps`),
        );
        expect(memberApps.map((listed) => listed.id)).toContain(app.id);
        const [owner, member, ownerLegacy] = yield* Effect.all([
          skillsClients.connect(ownerKey, "stalled-owner", {
            revision: "2026-07-28",
            organization,
          }),
          skillsClients.connect(memberKey, "stalled-member", {
            revision: "2026-07-28",
            organization,
          }),
          skillsClients.connect(ownerKey, "stalled-owner-legacy", {
            revision: "2025-11-25",
            organization,
          }),
        ]);
        const list = (
          client: Effect.Success<ReturnType<(typeof McpSkillsClient.Service)["connect"]>>,
          label: string,
        ) =>
          client
            .use(`List as ${label} while the source holds`, (skills) => skills.list())
            .pipe(Effect.map((listing) => uris(listing.skills)));
        const first = yield* list(owner, "owner");
        expect(first.some((uri) => uri.startsWith(`skill://${app.slug}/`))).toBe(false);
        expect(first).toContain(`skill://${ownerOnly.slug}/owner-only/SKILL.md`);
        const held = yield* upstream.arrivals.pipe(
          Effect.repeat({ schedule: Schedule.spaced("100 millis"), until: (count) => count > 0 }),
          Effect.timeout("30 seconds"),
        );
        expect(held).toBe(1);
        for (const [client, label] of [
          [member, "member"],
          [ownerLegacy, "owner-legacy"],
        ] as const) {
          const listed = yield* list(client, label);
          expect(listed.some((uri) => uri.startsWith(`skill://${app.slug}/`))).toBe(false);
          expect(listed.includes(`skill://${ownerOnly.slug}/owner-only/SKILL.md`)).toBe(
            label !== "member",
          );
          expect(yield* upstream.arrivals).toBe(1);
        }
      }).pipe(Effect.provide(McpSkillsClient.layer)),
    ),
  );
});
