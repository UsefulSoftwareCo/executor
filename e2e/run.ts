/** CLI adapter for the shared suite lifecycle. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { hostSlot } from "./host-slot.ts";
import { runSuite } from "./sdk/suite.ts";
import { exactly, split } from "./scenario-parts.ts";
import { scenariosForSuite } from "./test-plan.ts";

/**
 * Self-host and local workers each run their own product server, PGlite database and browser, which
 * together keep about two cores busy. Sixteen workers on 12-16 vCPUs starved servers for seconds at
 * a time.
 */
const defaultWorkers = Math.max(1, Math.min(16, Math.floor(navigator.hardwareConcurrency / 2)));

/** `--part i/n`: part i (from 1) of the n into which `split` divides the scenarios selected. */
const Part = Schema.String.check(Schema.isPattern(/^[1-9]\d*\/[1-9]\d*$/u));

/**
 * The `--test-name` pattern of one part of a local or self-host run: the scheduled scenarios whose
 * title `name` matches, split as CI splits a full run, so separate runners share the suite.
 */
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
    const parts = split(titles, count!);
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
    // Without it, managed Cloud caps `defaultWorkers`; see `runSuite`.
    workers: Flag.Int("workers").pipe(Flag.optional),
    // Start managed Cloud with the per-address auth limit on and run only the scenarios proving it.
    authRateLimit: Flag.Boolean("auth-rate-limit").pipe(Flag.withDefault(false)),
    // Start managed Cloud with its rollback switch on, sign-in on the deployment origin, and run
    // only the scenarios proving it.
    rollback: Flag.Boolean("rollback").pipe(Flag.withDefault(false)),
    // Start a second managed Cloud as the OAuth proxy's production, run against a test stage that
    // signs in through it, and run only the scenarios that prove the proxy.
    oauthProxyPreview: Flag.Boolean("oauth-proxy-preview").pipe(Flag.withDefault(false)),
    // Run one part of a local or self-host run; see `partPattern`.
    part: Flag.String("part").pipe(Flag.optional),
  },
  // Outside CI, one run per machine: see host-slot.ts.
  ({ part, ...flags }) =>
    Effect.gen(function* () {
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
        defaultWorkers: available,
      });
    }).pipe(Effect.scoped),
);
NodeRuntime.runMain(
  Command.run(command, { version: "1" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  ),
);
