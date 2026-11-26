import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { layer } from "alchemy/Alchemist/Runtime";
import { store } from "alchemy/Alchemist/routes/state";
import { Effect } from "effect";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    stack: { type: "string" },
    stage: { type: "string" },
    "delete-local": { type: "boolean", default: false },
  },
});
const stack = values.stack;
const stage = values.stage;
if (!stack || !stage) throw new Error("--stack and --stage are required");

const program = Effect.gen(function* () {
  const local = yield* store({ backend: "local" });
  const shared = yield* store({ backend: "cloudflare" });
  const target = { stack, stage };

  const existing = yield* shared.list(target);
  if (existing.length > 0)
    return yield* Effect.fail(
      new Error(`${stack}/${stage} already has ${existing.length} records in the shared store`),
    );

  const fqns = yield* local.list(target);
  if (fqns.length === 0)
    return yield* Effect.fail(new Error(`${stack}/${stage} has no local state`));

  for (const fqn of fqns) {
    const value = yield* local.get({ ...target, fqn });
    if (value === undefined) continue;
    yield* shared.set({ ...target, fqn, value });
  }
  const output = yield* local.getOutput(target);
  if (output !== undefined) yield* shared.setOutput({ ...target, value: output });

  const copied = yield* shared.list(target);
  if (copied.length !== fqns.length)
    return yield* Effect.fail(
      new Error(`copied ${copied.length} of ${fqns.length} records; local state kept`),
    );
  yield* Effect.log(`${stack}/${stage}: copied ${copied.length} records to the shared store`);

  if (values["delete-local"]) {
    yield* local.deleteStack(target);
    yield* Effect.log(`${stack}/${stage}: deleted local records`);
  }
});

NodeRuntime.runMain(program.pipe(Effect.provide(layer()), Effect.scoped));
