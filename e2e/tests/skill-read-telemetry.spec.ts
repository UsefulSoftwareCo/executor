/**
 * Skill reads record which Executor skill an agent read, and nothing that names a customer's skill:
 * the request's span records the route's template, not the skill's name from its path.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schedule, Schema } from "effect";
import { randomBytes, randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withCase, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Target } from "../support/platform.ts";

const SkillIndex = Schema.Struct({
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      app: Schema.Struct({ id: Schema.String, slug: Schema.String }),
      profile: Schema.optional(Schema.String),
    }),
  ),
});
const SkillDocument = Schema.Struct({
  name: Schema.String,
  file: Schema.String,
  content: Schema.String,
});
type Tags = Readonly<Record<string, string>>;
type Connection = Effect.Success<ReturnType<Effect.Success<typeof McpClient>["connect"]>>;

/** A customer's skill that reuses the Executor app's skill and file names with its own text. */
const customerFiles = (marker: string) => [
  {
    path: "index.ts",
    content:
      'import { defineApp } from "apps"; export default defineApp({ accounts: {} }, async () => ({}));',
  },
  {
    path: "skills/executor/SKILL.md",
    content: `---\nname: executor\ndescription: Synthetic ${marker} guide.\n---\n# ${marker}\n`,
  },
  { path: "skills/executor/feedback.md", content: `Synthetic ${marker} notes.\n` },
  // A skill named after the marker, whose name is in the read's path.
  {
    path: `skills/${marker}/SKILL.md`,
    content: `---\nname: ${marker}\ndescription: Synthetic ${marker} skill.\n---\n# ${marker}\n`,
  },
  appsManifest,
];

const executorRead = (name: string, file: string) => ({
  "executor.skill.operation": "read",
  "executor.skill.source": "executor",
  "executor.skill.name": name,
  "executor.skill.file": file,
});

/** A customer read records its source only: no app, skill or file name, and no text of its own. */
const expectCustomerRead = (tags: Tags, privateValues: ReadonlyArray<string>) => {
  expect(tags).toMatchObject({
    "executor.skill.operation": "read",
    "executor.skill.source": "customer",
  });
  expect(tags).not.toHaveProperty("executor.skill.name");
  expect(tags).not.toHaveProperty("executor.skill.file");
  for (const value of privateValues) expect(JSON.stringify(tags)).not.toContain(value);
};

/** A read's request span names its route by template only, with none of the path's values. */
const expectTemplatedPath = (tags: Tags, route: string, privateValues: ReadonlyArray<string>) => {
  expect({ path: tags["url.path"], route: tags["http.route"] }).toEqual({ path: route, route });
  for (const value of privateValues) expect(JSON.stringify(tags)).not.toContain(value);
};

/** The tags of one delivered span in a trace, waiting until the collector has it. */
const deliveredSpan = (traceId: string, operation: string, matches: (tags: Tags) => boolean) =>
  Effect.gen(function* () {
    const telemetry = yield* Telemetry;
    return yield* telemetry.query(traceId).pipe(
      Effect.flatMap((result) => {
        const found = result.data.find(
          ({ span }) => span.operationName === operation && matches(span.tags),
        );
        return found === undefined
          ? Effect.fail(new Error(`Missing delivered ${operation} span`))
          : Effect.succeed(found.span.tags);
      }),
      Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 80 }),
    );
  });

const latestTrace = Effect.gen(function* () {
  const id = (yield* (yield* Evidence).requests).at(-1)?.traceId;
  if (id === undefined) return yield* Effect.die("The request trace was not recorded");
  return id;
});

/** Read skills through the MCP skills tool and return the mcp.skills span of each call. */
const mcpSkills = (client: Connection) => ({
  list: Effect.gen(function* () {
    const index = yield* client.use("List every visible skill", (client, signal) =>
      client.callTool({ name: "skills", arguments: {} }, undefined, { signal }),
    );
    const traceId = yield* latestTrace;
    return {
      skills: (yield* Schema.decodeUnknownEffect(SkillIndex)(index.structuredContent)).skills,
      tags: yield* deliveredSpan(traceId, "mcp.skills", () => true),
    };
  }),
  read: (app: string, name: string, file: string) =>
    Effect.gen(function* () {
      const read = yield* client.use(`Read ${file} of a skill`, (client, signal) =>
        client.callTool({ name: "skills", arguments: { app, name, file } }, undefined, {
          signal,
        }),
      );
      const traceId = yield* latestTrace;
      return {
        document: yield* Schema.decodeUnknownEffect(SkillDocument)(read.structuredContent),
        tags: yield* deliveredSpan(traceId, "mcp.skills", () => true),
      };
    }),
});

layer(HostedLive, { excludeTestServices: true })("Skill read telemetry", (it) => {
  it.effect(scenarios.skillReadTelemetry.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const marker = `skill-marker-${randomUUID().slice(0, 8)}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Skill reader ${marker}`,
          files: customerFiles(marker),
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const customer = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${customer.id}`).pipe(Effect.orDie),
        );
        const key = yield* body(
          Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Skill read fixture",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const skills = mcpSkills(
          yield* (yield* McpClient).connect(Redacted.make(Redacted.value(key.key)), "skills", {
            organization: actors.organization.id,
          }),
        );
        const listed = yield* skills.list;
        expect(listed.tags["executor.skill.operation"]).toBe("list");
        expect(listed.tags).not.toHaveProperty("executor.skill.source");
        const guide = listed.skills.find(
          (skill) => skill.name === "executor" && skill.app.id !== customer.id,
        );
        if (guide?.profile === undefined)
          return yield* Effect.die("The Executor app's entry skill must name its profile");
        const privateValues = [marker, customer.slug];

        // The Executor app's own skill is named by skill and file.
        const own = yield* skills.read(guide.app.slug, "executor", "feedback.md");
        expect(own.document.content).toContain("feedback.submit");
        expect(own.tags).toMatchObject(executorRead("executor", "feedback.md"));
        // A customer skill with the same names is only counted.
        const theirs = yield* skills.read(customer.slug, "executor", "feedback.md");
        expect(theirs.document.content).toContain(marker);
        expectCustomerRead(theirs.tags, privateValues);

        // The Executor app's skills.read tool reads through the organization API.
        const viaApi = (app: string, name: string, query: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(
              actors.owner,
              "GET",
              `${prefix}/apps/${app}/skills/${name}?${query}`,
            );
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            return yield* deliveredSpan(
              yield* latestTrace,
              "product.operation",
              (tags) =>
                tags["executor.product.area"] === "skills" &&
                tags["executor.product.operation"] === "read",
            );
          });
        const ownViaApi = yield* viaApi(
          guide.app.id,
          "app-authoring",
          new URLSearchParams({ profile: guide.profile }).toString(),
        );
        expect(ownViaApi).toMatchObject(executorRead("app-authoring", "SKILL.md"));
        const theirsViaApi = yield* viaApi(customer.id, "executor", "file=feedback.md");
        expectCustomerRead(theirsViaApi, privateValues);
        // The skill's name is in the path; the request's span records the route instead, and the
        // organization by its ID.
        const named = yield* api.request(
          actors.owner,
          "GET",
          `${prefix}/apps/${customer.id}/skills/${marker}`,
        );
        expect(named.status, JSON.stringify(named.body)).toBe(200);
        const route = "/api/organizations/:organization/apps/:app/skills/:name";
        const namedRequest = yield* deliveredSpan(
          yield* latestTrace,
          "http.server GET",
          (tags) => tags["http.route"] === route,
        );
        expectTemplatedPath(namedRequest, route, privateValues);
        expect(namedRequest["executor.organization.id"]).toBe(actors.organization.id);
        yield* evidence.json("skill-read-spans.json", {
          list: listed.tags,
          own: own.tags,
          theirs: theirs.tags,
          ownViaApi,
          theirsViaApi,
          namedRequest,
        });
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.localSkillReadTelemetry.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          evidence = yield* Evidence,
          target = yield* Target;
        const session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const marker = `skill-marker-${randomUUID().slice(0, 8)}`;
        const deployed = yield* session.send(
          "POST",
          "/v1/apps/deploy",
          { owner: "local", name: `Skill reader ${marker}`, files: customerFiles(marker) },
          headers,
        );
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const { app: customer } = yield* body(Schema.Struct({ app: App }), deployed);
        yield* Effect.addFinalizer(() =>
          session.send("DELETE", `/v1/apps/${customer.id}`, undefined, headers).pipe(Effect.orDie),
        );
        const skills = mcpSkills(
          yield* (yield* McpClient).connect(target.apiKey, "local-skill-telemetry"),
        );
        const listed = yield* skills.list;
        expect(listed.tags["executor.skill.operation"]).toBe("list");
        expect(listed.tags).not.toHaveProperty("executor.skill.source");
        const guide = listed.skills.find(
          (skill) => skill.name === "executor" && skill.app.id !== customer.id,
        );
        if (guide?.profile === undefined)
          return yield* Effect.die("The Executor app's entry skill must name its profile");
        const privateValues = [marker, customer.slug];

        const own = yield* skills.read(guide.app.slug, "executor", "feedback.md");
        expect(own.document.content).toContain("feedback.submit");
        expect(own.tags).toMatchObject(executorRead("executor", "feedback.md"));
        const theirs = yield* skills.read(customer.slug, "executor", "feedback.md");
        expect(theirs.document.content).toContain(marker);
        expectCustomerRead(theirs.tags, privateValues);

        // The Executor app's skills.read tool reads through the local management API, which
        // takes no Origin header, so this request carries its own trace context.
        const viaApi = (app: string, name: string, query: string) =>
          Effect.gen(function* () {
            const trace = randomBytes(16).toString("hex");
            const response = yield* session.send(
              "GET",
              `/v1/apps/${app}/skills/${name}?${query}`,
              undefined,
              { ...headers, traceparent: `00-${trace}-${randomBytes(8).toString("hex")}-01` },
            );
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            return yield* deliveredSpan(trace, "http.server GET", (tags) =>
              Object.hasOwn(tags, "executor.skill.operation"),
            );
          });
        const ownViaApi = yield* viaApi(
          guide.app.id,
          "app-authoring",
          new URLSearchParams({ profile: guide.profile }).toString(),
        );
        expect(ownViaApi).toMatchObject(executorRead("app-authoring", "SKILL.md"));
        const theirsViaApi = yield* viaApi(customer.id, "executor", "file=feedback.md");
        expectCustomerRead(theirsViaApi, privateValues);
        // The skill's name is in the path; the request's span records the route instead.
        const namedRequest = yield* viaApi(customer.id, marker, "");
        expectTemplatedPath(namedRequest, "/v1/apps/:app/skills/:name", privateValues);
        yield* evidence.json("skill-read-spans.json", {
          list: listed.tags,
          own: own.tags,
          theirs: theirs.tags,
          ownViaApi,
          theirsViaApi,
          namedRequest,
        });
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
