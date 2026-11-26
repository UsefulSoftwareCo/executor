import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { randomBytes } from "node:crypto";
import type { ReleaseNetworks } from "./support/release-networks.ts";

const octet = (from: number, count: number) => from + (randomBytes(1).readUInt8(0) % count);

const docker = (args: readonly string[]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* processes.spawn(ChildProcess.make("docker", args, { stderr: "pipe" }));
      const [output, code] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(handle.all)), handle.exitCode],
        { concurrency: "unbounded" },
      );
      if (code !== 0)
        return yield* Effect.fail(
          new Error(`docker ${args.join(" ")} exited with ${code}: ${output.trim()}`),
        );
      return output;
    }),
  );

export default function setup(project: {
  readonly provide: (key: "releaseNetworks", value: ReleaseNetworks) => void;
}) {
  const id = randomBytes(6).toString("hex");
  const networks: ReleaseNetworks = {
    catalog: {
      name: `executor-release-catalog-${id}`,
      subnet: `11.${octet(1, 250)}.${octet(1, 250)}`,
    },
    proxies: { name: `executor-release-proxies-${id}` },
    tailnet: { name: `executor-release-tailnet-${id}`, subnet: `100.64.${octet(64, 190)}` },
  };
  const remove = Effect.forEach(
    [networks.catalog.name, networks.proxies.name, networks.tailnet.name],
    (name) =>
      docker(["network", "rm", name]).pipe(
        Effect.match({ onFailure: (error) => [error], onSuccess: () => [] }),
      ),
  ).pipe(Effect.map((failures) => failures.flat()));
  const removeAfterFailedSetup = remove.pipe(
    Effect.flatMap((failures) =>
      Effect.forEach(
        failures,
        (failure) => Console.error("Could not remove a Docker network", failure),
        { discard: true },
      ),
    ),
  );
  const removeAfterSuite = remove.pipe(
    Effect.flatMap((failures) =>
      failures.length === 0
        ? Effect.void
        : Effect.fail(
            new Error(
              `Could not remove ${failures.length} Docker network(s):\n${failures
                .map((failure) => failure.message)
                .join("\n")}`,
            ),
          ),
    ),
  );
  const create = Effect.all(
    [
      docker([
        "network",
        "create",
        "--subnet",
        `${networks.catalog.subnet}.0/24`,
        networks.catalog.name,
      ]),
      docker(["network", "create", networks.proxies.name]),
      docker([
        "network",
        "create",
        "--subnet",
        `${networks.tailnet.subnet}.0/24`,
        networks.tailnet.name,
      ]),
    ],
    { discard: true },
  );
  // oxlint-disable-next-line executor/no-manual-effect-runtime-in-tests -- Vitest's globalSetup must return a Promise
  return Effect.runPromise(
    create.pipe(
      Effect.onError(() => removeAfterFailedSetup),
      Effect.tap(() => Effect.sync(() => project.provide("releaseNetworks", networks))),
      Effect.as(() =>
        // oxlint-disable-next-line executor/no-manual-effect-runtime-in-tests -- Vitest's globalSetup teardown must return a Promise
        Effect.runPromise(removeAfterSuite.pipe(Effect.provide(NodeServices.layer))),
      ),
      Effect.provide(NodeServices.layer),
    ),
  );
}
