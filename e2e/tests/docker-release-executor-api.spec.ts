/**
 * The built-in Executor app reads the server's own API through its app cache, and agents find its
 * tools through kept listings. Replacing the image with one whose API changed must not leave either
 * serving the previous API: after #2951 removed profiles, upgraded servers kept listing
 * `profiles.*`, which failed as unknown tools, and hid the new `appAccounts.*` tools for up to a day.
 * The same holds for an Executor app that owns a database, as after an operator adds a migration to
 * it: the upgrade keeps edited source, so its build stays the same and only the API's revision can
 * start its listing afresh.
 *
 * The Executor app calls the API with the agent's grant, so it lists only operations a bearer
 * credential may call. An operation the document secures with the browser session alone, such as
 * the dashboard's tool call log, is never listed, new or not.
 *
 * `EXECUTOR_E2E_DOCKER_UPGRADE_FROM_IMAGE` names the published image the server starts on, which
 * must serve a different API from `EXECUTOR_E2E_DOCKER_IMAGE`: without that difference the scenario
 * proves nothing, so it fails rather than replacing an image with itself.
 */
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, Exit, Schedule, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { driver } from "../support/platform.ts";

const Document = Schema.Struct({
  paths: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
});
const Operation = Schema.Struct({
  operationId: Schema.String,
  security: Schema.optional(
    Schema.Array(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  ),
});
/**
 * An operation whose only security is the browser session refuses every bearer credential, so the
 * Executor app, which calls with the agent's grant, must not list it. Every alternative must name
 * exactly the browser session: an empty one, `{}`, allows anonymous callers, so an operation that
 * has one is not browser-only and must be listed if it is new.
 */
const browserSessionOnly = (operation: typeof Operation.Type) =>
  operation.security !== undefined &&
  operation.security.length > 0 &&
  operation.security.every((requirement) => {
    const schemes = Object.keys(requirement);
    return schemes.length === 1 && schemes[0] === "browserSession";
  });
const SearchInput = Schema.Record(Schema.String, Schema.Json);
const SearchPage = Schema.Struct({
  items: Schema.Array(Schema.Struct({ path: Schema.String })),
  next: Schema.NullOr(SearchInput),
});

const Source = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});

/** Start on the previous image, warm the Executor app, replace the image and list its tools. */
const upgrade = (database: boolean) =>
  Effect.scoped(
    Effect.gen(function* () {
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      const image = yield* Config.String("EXECUTOR_E2E_DOCKER_IMAGE");
      const previous = yield* Config.NonEmptyString("EXECUTOR_E2E_DOCKER_UPGRADE_FROM_IMAGE");
      const id = `executor-release-api-${randomBytes(8).toString("hex")}`;
      const run = (args: readonly string[]) =>
        processes.string(ChildProcess.make("docker", args, { extendEnv: true }));
      const port = yield* driver(
        "allocate port",
        () =>
          new Promise<number>((resolve, reject) => {
            const listener = createServer();
            listener.once("error", reject);
            listener.listen(0, "127.0.0.1", () => {
              const address = listener.address();
              listener.close(() =>
                address === null || typeof address === "string"
                  ? reject(new Error("No test port"))
                  : resolve(address.port),
              );
            });
          }),
      );
      const address = `http://127.0.0.1:${port}`;
      // The server and the Executor app inside it reach the API at the container's own port.
      const origin = "http://localhost:8080";
      yield* Effect.acquireRelease(run(["volume", "create", id]), () =>
        run(["volume", "rm", id]).pipe(Effect.orDie),
      );
      const start = (tag: string) =>
        run([
          "run",
          "--detach",
          "--name",
          id,
          "--init",
          "--publish",
          `127.0.0.1:${port}:8080`,
          "--volume",
          `${id}:/app/data`,
          "--env",
          "DO_NOT_TRACK=1",
          "--env",
          "PORT=8080",
          "--env",
          `EXECUTOR_APP_UI_BASE_URL=${origin}`,
          tag,
        ]);
      const stop = run(["rm", "--force", id]).pipe(Effect.orDie);
      yield* Effect.addFinalizer((exit) =>
        (Exit.isFailure(exit)
          ? run(["logs", "--tail", "80", id]).pipe(Effect.flatMap(Console.error), Effect.ignore)
          : Effect.void
        ).pipe(Effect.andThen(stop)),
      );
      const request = (route: string, data?: unknown, cookie?: string) =>
        driver(`image ${route}`, () =>
          fetch(`${address}${route}`, {
            method: data === undefined ? "GET" : "POST",
            headers: {
              origin,
              "content-type": "application/json",
              ...(cookie === undefined ? {} : { cookie }),
            },
            ...(data === undefined ? {} : { body: JSON.stringify(data) }),
          }),
        );
      const ready = request("/health").pipe(
        Effect.flatMap((response) =>
          response.status === 200 ? Effect.void : Effect.fail("not ready"),
        ),
        Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 240 }),
      );
      /**
       * The operations of the API document the running image serves, which the Executor app reads,
       * each with whether only a browser session may call it.
       */
      const operations = request("/openapi.json").pipe(
        Effect.flatMap((response) => driver("API document", () => response.json())),
        Effect.flatMap(Schema.decodeUnknownEffect(Document)),
        Effect.map(
          (document) =>
            new Map(
              Object.values(document.paths).flatMap((methods) =>
                Object.values(methods).flatMap((operation) =>
                  Schema.is(Operation)(operation)
                    ? [[operation.operationId, browserSessionOnly(operation)] as const]
                    : [],
                ),
              ),
            ),
        ),
      );
      const connect = (key: string, organization: string) =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            const client = new Client({ name: "release-executor-api", version: "1" });
            const transport: Omit<StreamableHTTPClientTransport, "sessionId"> =
              new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
                requestInit: {
                  headers: {
                    authorization: `Bearer ${key}`,
                    "x-executor-organization": organization,
                  },
                },
              });
            yield* driver("connect over MCP", () => client.connect(transport));
            return client;
          }),
          (client) => driver("close MCP client", () => client.close()).pipe(Effect.orDie),
        );

      yield* start(previous);
      yield* ready;
      const setup = yield* request("/api/auth/self-host/setup", {
        name: "Release Owner",
        email: "release-api@example.test",
        password: "Synthetic-release-password-123!",
        organizationName: "Release API lab",
      });
      expect(setup.status).toBe(200);
      const cookie = setup.headers
        .getSetCookie()
        .map((part) => part.split(";")[0])
        .join("; ");
      const [organization] = yield* request("/api/auth/organization/list", undefined, cookie).pipe(
        Effect.flatMap((response) => driver("organizations", () => response.json())),
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.NonEmptyArray(Schema.Struct({ id: Schema.String }))),
        ),
      );
      // Setup installs the Executor app in the background.
      const executor = yield* request(
        `/api/organizations/${organization.id}/inventory`,
        undefined,
        cookie,
      ).pipe(
        Effect.flatMap((response) => driver("inventory", () => response.json())),
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({
              apps: Schema.Array(Schema.Struct({ id: Schema.String, slug: Schema.String })),
            }),
          ),
        ),
        Effect.flatMap(({ apps }) => {
          const app = apps.find((app) => app.slug === "executor");
          return app === undefined ? Effect.fail("Executor app pending") : Effect.succeed(app);
        }),
        Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 120 }),
      );
      if (database) {
        // The operator's edit: its version owns a database, and its tool calls run in a facet.
        const app = `/api/organizations/${organization.id}/apps/${executor.id}`;
        const source = yield* request(`${app}/source`, undefined, cookie).pipe(
          Effect.flatMap((response) => driver("app source", () => response.json())),
          Effect.flatMap(Schema.decodeUnknownEffect(Source)),
        );
        const deployed = yield* request(
          `${app}/deploy`,
          {
            files: [
              ...source.files,
              {
                path: "migrations/0001_release_check.sql",
                content: "CREATE TABLE release_check (id TEXT PRIMARY KEY);",
              },
            ],
          },
          cookie,
        );
        expect(deployed.status, yield* driver("deployed", () => deployed.text())).toBe(200);
      }
      const { key } = yield* request(
        "/api/auth/api-key/create",
        { name: "Release API" },
        cookie,
      ).pipe(
        Effect.flatMap((response) => driver("API key", () => response.json())),
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ key: Schema.String }))),
      );
      const before = yield* operations;
      // An agent's search on the previous image keeps the Executor app's listing and document.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const client = yield* connect(key, organization.id);
          const warmed = yield* driver("search on the previous image", (signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: { code: 'return await tools.search({ query: "list" });' },
              },
              undefined,
              { signal },
            ),
          );
          expect(warmed.isError, JSON.stringify(warmed.content)).not.toBe(true);
        }),
      );

      yield* stop;
      yield* start(image);
      yield* ready;
      const after = yield* operations;
      // The upgrade must change the API, or the listing checks below hold for a stale listing too.
      expect(
        [...before.keys()].filter((operation) => !after.has(operation)).length +
          [...after.keys()].filter((operation) => !before.has(operation)).length,
        `${previous} and ${image} serve the same API`,
      ).toBeGreaterThan(0);
      const listed = yield* Effect.scoped(
        Effect.gen(function* () {
          const client = yield* connect(key, organization.id);
          const paths: string[] = [];
          let input: typeof SearchInput.Type = { namespace: "executor", limit: 50 };
          for (;;) {
            const page = yield* driver("list the Executor app's tools", (signal) =>
              client.callTool({ name: "search", arguments: input }, undefined, { signal }),
            ).pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(SearchPage)(result.structuredContent),
              ),
            );
            paths.push(...page.items.map((item) => item.path));
            if (page.next === null) return paths;
            input = page.next;
          }
        }),
      );
      const tools = new Set(listed.map((path) => path.replace(/^tools\.executor\./, "")));
      expect(tools.size).toBeGreaterThan(0);
      // Every listed tool is an operation of the API now served, so none of them is a removed one.
      expect([...tools].filter((tool) => !after.has(tool))).toEqual([]);
      // No operation that refuses the agent's credential is listed.
      expect([...tools].filter((tool) => after.get(tool) === true)).toEqual([]);
      // Every operation the replacement added that the agent's credential can call is listed.
      expect(
        [...after]
          .filter(([operation, browserOnly]) => !browserOnly && !before.has(operation))
          .map(([operation]) => operation)
          .filter((operation) => !tools.has(operation)),
      ).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeServices.layer));

it.live(
  "replacing the image leaves the Executor app listing the new image's API",
  () => upgrade(false),
  300_000,
);

it.live(
  "replacing the image leaves an Executor app that owns a database listing the new image's API",
  () => upgrade(true),
  300_000,
);
