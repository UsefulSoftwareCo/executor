/** Interactive CLI over the same SDK used by committed scenarios. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, FileSystem, Layer, Schedule, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import { serveEnvironment } from "./sdk/control.ts";
import { FixtureControl } from "./sdk/contracts.ts";
import { fixtureRequest } from "./sdk/fixtures.ts";
import { populations, DataShape } from "./sdk/data.ts";
const handle = Flag.String("handle");
const id = Flag.String("id");
const role = Flag.Literals("role", ["owner", "admin", "member"]).pipe(Flag.withDefault("owner"));
const call = (handle: string, operation: string, payload: unknown = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const control = yield* fs
      .readFileString(handle)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FixtureControl))));
    const result = yield* fixtureRequest(control, `/${operation}`, payload, "5 minutes");
    yield* Console.log(JSON.stringify(result, null, 2));
  });
const start = Command.make(
  "start",
  {
    handle,
    target: Flag.Literals("target", ["local", "self-host", "cloud", "deployed"]).pipe(
      Flag.withDefault("self-host"),
    ),
    headless: Flag.Boolean("headless").pipe(Flag.withDefault(false)),
    database: Flag.Literals("database", ["neon", "planetscale"]).pipe(Flag.withDefault("neon")),
  },
  (input) => Effect.scoped(serveEnvironment(input)),
);
const create = Command.make(
  "create",
  { handle, label: Flag.String("label") },
  ({ handle, label }) => call(handle, "create", { label }),
);
const list = Command.make("list", { handle }, ({ handle }) => call(handle, "list"));
const seed = Command.make(
  "seed",
  {
    handle,
    id,
    preset: Flag.Literals("preset", ["populated", "large"]).pipe(Flag.withDefault("populated")),
    shape: Flag.String("shape").pipe(Flag.withDefault("")),
  },
  ({ handle, id, preset, shape }) =>
    Effect.gen(function* () {
      const input =
        shape === ""
          ? populations[preset]
          : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(DataShape))(shape);
      yield* call(handle, "seed", { id, shape: input });
    }),
);
const request = Command.make(
  "request",
  {
    handle,
    id,
    role,
    method: Flag.Literals("method", ["GET", "POST", "PUT", "PATCH", "DELETE"]).pipe(
      Flag.withDefault("GET"),
    ),
    path: Flag.String("path"),
    body: Flag.String("body").pipe(Flag.withDefault("")),
  },
  ({ handle, id, role, method, path, body }) =>
    Effect.gen(function* () {
      const value =
        body === ""
          ? undefined
          : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(body);
      yield* call(handle, "request", {
        id,
        role,
        method,
        path,
        ...(value === undefined ? {} : { body: value }),
      });
    }),
);
const open = Command.make("open", { handle, id, role }, ({ handle, id, role }) =>
  call(handle, "open", { id, role }),
);
const remove = Command.make("remove", { handle, id }, ({ handle, id }) =>
  call(handle, "remove", { id }),
);
const stop = Command.make("stop", { handle }, ({ handle }) =>
  Effect.gen(function* () {
    yield* call(handle, "stop");
    const fs = yield* FileSystem.FileSystem;
    yield* fs.exists(handle).pipe(
      Effect.flatMap((exists) => (exists ? Effect.fail("Cleanup still running") : Effect.void)),
      Effect.retry(Schedule.spaced("250 millis")),
      Effect.timeout("12 minutes"),
    );
    yield* Console.log(JSON.stringify({ stopped: true }));
  }),
);
const root = Command.make("testing").pipe(
  Command.withSubcommands([start, create, list, seed, request, open, remove, stop]),
);
NodeRuntime.runMain(
  Command.run(root, { version: "1" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  ),
);
