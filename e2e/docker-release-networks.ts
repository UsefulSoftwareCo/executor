/**
 * Global setup for the released-image suite: create every Docker network its scenarios use before
 * any of them starts, and remove the networks once all of them have finished. A network created
 * while another scenario's browser loads a page aborts that page's requests; see
 * `support/release-networks.ts`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { randomBytes } from "node:crypto";
import type { ReleaseNetworks } from "./support/release-networks.ts";

const octet = (from: number, count: number) => from + (randomBytes(1).readUInt8(0) % count);

/** Run `docker`; a non-zero exit fails with its output, which `processes.string` would discard. */
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

/** Vitest's global setup. Returns the teardown, which runs after every test file has finished. */
export default function setup(project: {
  readonly provide: (key: "releaseNetworks", value: ReleaseNetworks) => void;
}) {
  const id = randomBytes(6).toString("hex");
  const networks: ReleaseNetworks = {
    // Public address space, not routed anywhere outside this network. Varied per run.
    catalog: {
      name: `executor-release-catalog-${id}`,
      subnet: `11.${octet(1, 250)}.${octet(1, 250)}`,
    },
    proxies: { name: `executor-release-proxies-${id}` },
    // Shared CGNAT space, the same range Tailscale assigns. Varied per run.
    tailnet: { name: `executor-release-tailnet-${id}`, subnet: `100.64.${octet(64, 190)}` },
  };
  /** Try to remove every network, and give back the removals that failed. */
  const remove = Effect.forEach(
    [networks.catalog.name, networks.proxies.name, networks.tailnet.name],
    (name) =>
      docker(["network", "rm", name]).pipe(
        Effect.match({ onFailure: (error) => [error], onSuccess: () => [] }),
      ),
  ).pipe(Effect.map((failures) => failures.flat()));
  // Setup failed, so some networks were never created: report what could not be removed and let
  // the failure that stopped setup stand.
  const removeAfterFailedSetup = remove.pipe(
    Effect.flatMap((failures) =>
      Effect.forEach(
        failures,
        (failure) => Console.error("Could not remove a Docker network", failure),
        { discard: true },
      ),
    ),
  );
  // Every scenario has removed its containers by now. A network that cannot be removed, such as
  // one a container is still attached to, fails the run once every removal has been tried.
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
      // A network that could not be created leaves none behind.
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
