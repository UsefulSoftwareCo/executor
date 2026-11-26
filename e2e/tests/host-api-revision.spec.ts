import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schedule, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Api, body, SessionClients } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Inventory } from "../support/contracts.ts";
import { startDevelopmentServer } from "../support/managed-server.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Target } from "../support/platform.ts";

const apiDocument = "/api/devtools/api-document";
const otherRevisionSuffix = "OtherRevision";
const changing =
  "The app reported that Executor’s API is changing (a deploy is in progress), so it could not load its tools.";

const Users = Schema.Struct({
  users: Schema.Array(Schema.Struct({ id: Schema.String, email: Schema.String })),
});
const Organizations = Schema.Array(Schema.Struct({ id: Schema.String }));
const SearchInput = Schema.Record(Schema.String, Schema.Json);
const SearchPage = Schema.Struct({
  items: Schema.Array(Schema.Struct({ path: Schema.String })),
  next: Schema.NullOr(SearchInput),
  unavailableApps: Schema.Array(Schema.Struct({ app: Schema.String, reason: Schema.String })),
});
const Document = Schema.Struct({
  paths: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
});
const Operation = Schema.Struct({ operationId: Schema.String });
const Source = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});
const Reason = Schema.fromJsonString(
  Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    recovery: Schema.Struct({ action: Schema.String }),
    retryable: Schema.Boolean,
  }),
);
const CallFailure = Schema.Struct({
  _tag: Schema.String,
  failure: Schema.Struct({ code: Schema.optional(Schema.String) }),
  message: Schema.String,
  recovery: Schema.Struct({ action: Schema.String }),
});

layer(HostedLive, { excludeTestServices: true })("Host API revision", (it) => {
  it.effect(scenarios.hostApiRevision.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          mcp = yield* McpClient;
        const origin = yield* startDevelopmentServer(target);
        const api = yield* Api.pipe(
          Effect.provide(Layer.fresh(Api.layer)),
          Effect.provide(Layer.fresh(SessionClients.layer)),
          Effect.provideService(Target, { ...target, metadata: { ...target.metadata, origin } }),
        );
        const owner = yield* api.session(),
          headers = { origin };
        const send = (method: "GET" | "POST" | "DELETE", path: string, payload?: unknown) =>
          api.request(owner, method, `${origin}${path}`, payload, headers);
        expect((yield* send("POST", "/api/devtools/operator", {})).status).toBe(200);
        const directory = yield* body(Users, yield* send("GET", "/api/auth/admin/list-users"));
        const developer = directory.users.find((user) => user.email === "agent-agent@example.test");
        if (!developer) return yield* Effect.die("Development owner is missing");
        expect(
          (yield* send("POST", "/api/auth/admin/impersonate-user", { userId: developer.id }))
            .status,
        ).toBe(200);
        const organization = (yield* body(
          Organizations,
          yield* send("GET", "/api/auth/organization/list"),
        ))[0];
        if (!organization) return yield* Effect.die("Development organization is missing");
        const prefix = `/api/organizations/${organization.id}`;
        const executor = yield* Effect.gen(function* () {
          const inventory = yield* body(Inventory, yield* send("GET", `${prefix}/inventory`));
          const app = inventory.apps.find((app) => app.slug === "executor");
          if (app === undefined || !inventory.links.some((link) => link.app === app.id))
            return yield* Effect.fail(new Error("Executor app provisioning is pending"));
          return app;
        }).pipe(Effect.retry({ times: 40, schedule: Schedule.spaced("250 millis") }));
        const serve = (other: boolean) =>
          send(other ? "POST" : "DELETE", apiDocument).pipe(
            Effect.map((response) => expect(response.status).toBe(200)),
          );
        yield* Effect.addFinalizer(() => serve(false).pipe(Effect.orDie));
        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* send("POST", "/api/auth/api-key/create", { name: "Host API revision" }),
        );
        const client = yield* mcp.connect(key.key, "host-api-revision", {
          organization: organization.id,
          origin,
        });
        const list = (label: string) =>
          Effect.gen(function* () {
            const paths: string[] = [];
            const unavailable: { app: string; reason: string }[] = [];
            let input: typeof SearchInput.Type = { namespace: "executor", limit: 50 };
            for (;;) {
              const page = yield* client
                .use(label, (client, signal) =>
                  client.callTool({ name: "search", arguments: input }, undefined, { signal }),
                )
                .pipe(
                  Effect.flatMap((result) =>
                    Schema.decodeUnknownEffect(SearchPage)(result.structuredContent),
                  ),
                );
              paths.push(...page.items.map((item) => item.path));
              unavailable.push(...page.unavailableApps);
              if (page.next === null) return { paths, unavailable };
              input = page.next;
            }
          });
        const otherRevision = (paths: ReadonlyArray<string>) =>
          paths.filter((path) => path.endsWith(otherRevisionSuffix));

        yield* serve(true);
        const refused = yield* list("List the Executor app while another revision is served");
        expect(refused.paths, JSON.stringify(refused)).toEqual([]);
        expect(
          refused.unavailable.map((entry) => entry.app),
          JSON.stringify(refused),
        ).toEqual([executor.id]);
        const reason = yield* Schema.decodeUnknownEffect(Reason)(refused.unavailable[0]?.reason);
        expect(reason).toEqual({
          code: "AppEvaluationFailed",
          message: changing,
          recovery: { action: "Retry shortly." },
          retryable: true,
        });

        yield* serve(false);
        const listed = yield* list("List the Executor app while its own revision is served");
        expect(listed.unavailable, JSON.stringify(listed)).toEqual([]);
        expect(listed.paths, JSON.stringify(listed)).toEqual(
          expect.arrayContaining([expect.stringMatching(/^tools\.executor\.appAccounts\./)]),
        );
        expect(otherRevision(listed.paths)).toEqual([]);

        const appPath = `${prefix}/apps/${executor.id}`;
        const source = yield* body(Source, yield* send("GET", `${appPath}/source`));
        const deployed = yield* send("POST", `${appPath}/deploy`, {
          files: [
            ...source.files,
            {
              path: "migrations/0001_host_api_revision.sql",
              content: "CREATE TABLE host_api_revision (id TEXT PRIMARY KEY);",
            },
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const document = yield* body(Document, yield* send("GET", "/openapi.json"));
        const reads = new Set(
          Object.values(document.paths).flatMap((methods) =>
            Schema.is(Operation)(methods.get) ? [methods.get.operationId] : [],
          ),
        );
        const tool = listed.paths
          .map((path) => path.replace(/^tools\.executor\./, ""))
          .find((name) => reads.has(name));
        if (tool === undefined) return yield* Effect.die("The Executor app lists no read");

        yield* serve(true);
        const call = yield* send("POST", `${appPath}/tools/call`, {
          tool,
          kind: "query",
          input: {},
        });
        expect(call.status, JSON.stringify(call.body)).toBe(502);
        expect(yield* body(CallFailure, call)).toEqual({
          _tag: "AppEvaluationFailed",
          failure: { code: "EXECUTOR_API_CHANGING" },
          message: changing,
          recovery: {
            action:
              "Do not automatically repeat this call or duplicate its change. Executor could not confirm its outcome.",
          },
        });

        yield* serve(false);
        const after = yield* list("List the database-owning Executor app");
        expect(after.unavailable, JSON.stringify(after)).toEqual([]);
        expect(after.paths, JSON.stringify(after)).toEqual(
          expect.arrayContaining([expect.stringMatching(/^tools\.executor\.appAccounts\./)]),
        );
        expect(otherRevision(after.paths)).toEqual([]);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
