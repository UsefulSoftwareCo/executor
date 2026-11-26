import "./support/connect-timeout.ts";
import "./support/stage-connections.ts";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { hostSlot } from "./host-slot.ts";
import { runSuite } from "./sdk/suite.ts";
import { exactly, split } from "./scenario-parts.ts";
import { scenariosForSuite } from "./test-plan.ts";
import { cloudNotesSources } from "./support/cloud-release-notes.ts";
import { namesNoScenario, unnamedRefusal } from "./snapshot-updates.ts";

const defaultWorkers = Math.max(1, Math.min(16, Math.floor(navigator.hardwareConcurrency / 2)));

const Part = Schema.String.check(Schema.isPattern(/^[1-9]\d*\/[1-9]\d*$/u));

const partPattern = (target: "local" | "self-host", name: string, part: string) =>
  Effect.gen(function* () {
    const [index, count] = (yield* Schema.decodeUnknownEffect(Part)(part)).split("/").map(Number);
    const selected = new RegExp(name);
    const titles = scenariosForSuite("all")
      .filter(
        (scenario) =>
          scenario.targets[target].status === "scheduled" && selected.test(scenario.title),
      )
      .map((scenario) => scenario.title);
    const parts = split(titles, count!, target);
    if (index! > count! || parts.length !== count)
      return yield* Effect.die(
        new Error(`--part ${part}: the selected scenarios split into ${parts.length} parts.`),
      );
    return exactly(parts[index! - 1]!);
  });

const command = Command.make(
  "e2e",
  {
    target: Flag.Literals("target", ["self-host", "local", "cloud", "all", "hosted"]).pipe(
      Flag.withDefault("self-host"),
    ),
    name: Flag.String("test-name").pipe(Flag.withDefault("")),
    workers: Flag.Int("workers").pipe(Flag.optional),
    authRateLimit: Flag.Boolean("auth-rate-limit").pipe(Flag.withDefault(false)),
    rollback: Flag.Boolean("rollback").pipe(Flag.withDefault(false)),
    oauthProxyPreview: Flag.Boolean("oauth-proxy-preview").pipe(Flag.withDefault(false)),
    removalRevocationBudget: Flag.Boolean("removal-revocation-budget").pipe(
      Flag.withDefault(false),
    ),
    releaseNotes: Flag.Literals("release-notes", cloudNotesSources).pipe(Flag.optional),
    part: Flag.String("part").pipe(Flag.optional),
    updateSnapshots: Flag.Boolean("update-snapshots").pipe(Flag.withDefault(false)),
  },
  ({ part, ...flags }) =>
    Effect.gen(function* () {
      if (flags.updateSnapshots && namesNoScenario(flags.name))
        return yield* Effect.die(new Error(unnamedRefusal));
      if (flags.updateSnapshots && Option.isSome(part))
        return yield* Effect.die(
          new Error(
            "--update-snapshots records the scenarios --test-name names, not a part of a run: leave out --part.",
          ),
        );
      const name = Option.isNone(part)
        ? flags.name
        : flags.target === "local" || flags.target === "self-host"
          ? yield* partPattern(flags.target, flags.name, part.value)
          : yield* Effect.die(new Error("--part splits only a local or self-host run."));
      const available = yield* hostSlot(defaultWorkers);
      return yield* runSuite({
        ...flags,
        name,
        workers: Option.getOrUndefined(flags.workers),
        releaseNotes: Option.getOrUndefined(flags.releaseNotes),
        defaultWorkers: available,
      });
    }).pipe(Effect.scoped),
);
NodeRuntime.runMain(
  Command.run(command, { version: "1" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  ),
);
