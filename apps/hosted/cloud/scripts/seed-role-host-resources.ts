import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Console, Effect } from "effect";
import { parseArgs } from "node:util";
import { seedRoleHostResources } from "../src/implementation/role-host-resources.ts";

const { values } = parseArgs({ options: { apply: { type: "boolean", default: false } } });

NodeRuntime.runMain(
  seedRoleHostResources(values.apply ? "apply" : "report").pipe(
    Effect.flatMap((summary) => Console.log(JSON.stringify(summary))),
  ),
);
