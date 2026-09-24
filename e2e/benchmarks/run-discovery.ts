/** Run the controlled benchmark against a retained stage using its private fixture capability. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Clock, Console, Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Command, Flag } from "effect/unstable/cli";
import { randomBytes } from "node:crypto";
import { fixtureRequest, FixtureControl, FixtureActors } from "../sdk/fixtures.ts";
import { Target } from "../support/platform.ts";
import { SessionClients, Api } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Evidence, Telemetry, scenarioEvidence } from "../support/evidence.ts";
import { RecordingFocus } from "../support/recording-focus.ts";
import { McpClient } from "../support/mcp-client.ts";
import { discoveryBenchmark } from "./discovery.ts";

const command = Command.make(
  "discovery-benchmark",
  {
    fixture: Flag.String("fixture"),
    origin: Flag.String("origin"),
    commit: Flag.String("commit"),
    output: Flag.String("output"),
  },
  (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const fixture = yield* fs
          .readFileString(input.fixture)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FixtureControl))));
        const id = randomBytes(16).toString("hex");
        const identities = yield* fixtureRequest(fixture, "/actors", {
          id,
          label: "Discovery comparison",
        }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(FixtureActors)));
        if (identities.origin !== input.origin || identities.id !== id)
          return yield* Effect.fail(new Error("Fixture identity differs from requested stage"));
        yield* fs.makeDirectory(input.output, { recursive: true, mode: 0o700 });
        const target = Target.of({
          directory: input.output,
          apiKey: Redacted.make(randomBytes(32).toString("hex")),
          rows: 1000,
          recordingPaceMs: 0,
          observeUI: false,
          scenarioId: id,
          scenarioLabel: "Discovery comparison",
          fixtures: fixture,
          metadata: {
            target: "cloud",
            mode: "attached",
            runtime: "Retained Cloudflare stage",
            origin: input.origin,
            commit: input.commit,
            dirty: false,
            startedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
            interactive: false,
            diagnostics: "diagnostics/index.html",
          },
        });
        const runtime = SessionClients.layer.pipe(
          Layer.provideMerge(Layer.succeed(Target, target)),
        );
        const evidence = scenarioEvidence({
          file: "discovery.ts",
          name: "Discovery comparison",
        }).pipe(
          Layer.provideMerge(
            Layer.mergeAll(Telemetry.layer, RecordingFocus.layer).pipe(Layer.provideMerge(runtime)),
          ),
        );
        const apis = Api.layer.pipe(Layer.provideMerge(evidence));
        const program = Effect.gen(function* () {
          const clients = yield* SessionClients;
          const actors = {
            organization: identities.organization,
            owner: yield* clients.session(Redacted.make(identities.actors.owner.cookies)),
            admin: yield* clients.session(Redacted.make(identities.actors.admin.cookies)),
            member: yield* clients.session(Redacted.make(identities.actors.member.cookies)),
          };
          for (const actor of [actors.owner, actors.admin, actors.member]) {
            const response = yield* clients.request(actor, "POST", "/api/onboarding/prepare");
            if (response.status !== 200)
              return yield* Effect.fail(new Error("Could not prepare benchmark actor"));
          }
          const recorded = yield* Evidence;
          yield* recorded.json("benchmark-source.json", {
            origin: input.origin,
            commit: input.commit,
            scenario: id,
            organization: identities.organization,
          });
          const result = yield* discoveryBenchmark.pipe(
            Effect.provideService(Actors, actors),
            Effect.provide(McpClient.layer),
          );
          yield* Console.log(JSON.stringify(result));
        });
        yield* program.pipe(Effect.provide(apis));
      }),
    ),
);
NodeRuntime.runMain(
  Command.run(command, { version: "1" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  ),
);
