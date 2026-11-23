/**
 * Run test-stage cleanup's deletion of one `AppDomains` record (`TestStageDomainCleanup`) against
 * the Alchemy records given, as `alchemy destroy alchemy.test-cleanup.ts` does for a stage. Prints
 * `{"deleted": true}`; a failure prints its tag and exits 1.
 *
 *   node scripts/test-stage-domain-cleanup.ts --stage test-<slug> --records <file> --olds <file>
 *
 * `--records` is a JSON object of the stage's Alchemy records by logical ID, encoded as Alchemy
 * stores them; `--olds` the record's props. `test-stage-domain-cleanup.spec.ts` runs it against a local stand-in for Cloudflare's API
 * and the stage's drain endpoint.
 */
import { readFileSync } from "node:fs";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Provider from "alchemy/Provider";
import { noopSession } from "alchemy/Report";
import { StackContext } from "alchemy/StackContext";
import { Stage } from "alchemy/Stage";
import { inMemoryState } from "alchemy/State/InMemoryState";
import type { ResourceState } from "alchemy/State/ResourceState";
import { reviveState } from "alchemy/State/StateEncoding";
import { Console, Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { AppDomainLifecycle } from "../src/infrastructure/app-domain-lifecycle.ts";
import { TestStageDomainCleanup } from "../src/infrastructure/test-stage-cleanup-providers.ts";

const option = (name: string) => {
  const at = process.argv.indexOf(name);
  const value = at === -1 ? undefined : process.argv[at + 1];
  if (value === undefined) throw new Error(`Pass ${name}.`);
  return value;
};
const stack = "executor-next-hosted";
const stage = option("--stage");
// Read as Alchemy's state store reads its records, so a `__redacted__` value is a Redacted again.
const records: Record<string, ResourceState> = JSON.parse(
  readFileSync(option("--records"), "utf8"),
  reviveState,
);
const olds = JSON.parse(readFileSync(option("--olds"), "utf8"));

NodeRuntime.runMain(
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(AppDomainLifecycle);
    yield* provider.delete({
      id: "AppDomains",
      fqn: "AppDomains",
      instanceId: "AppDomains",
      olds,
      output: { origin: olds.origin },
      session: { ...noopSession, note: () => Effect.void },
      bindings: [],
    });
    yield* Console.log(JSON.stringify({ deleted: true }));
  }).pipe(
    Effect.provide(TestStageDomainCleanup()),
    // Alchemy's engine provides the stage's state to a deletion, as it does here.
    Effect.provide(inMemoryState({ [stack]: { [stage]: records } })),
    Effect.provideService(Stage, stage),
    Effect.provideService(StackContext, {
      name: stack,
      stage,
      resources: {},
      bindings: {},
      actions: {},
    }),
    Effect.provide(FetchHttpClient.layer),
    Effect.catchCause((cause) =>
      Console.error(`Deletion failed: ${cause.toString().split("\n")[0]}`).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
      ),
    ),
  ),
);
