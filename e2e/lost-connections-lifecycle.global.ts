/**
 * Global set-up for `lost-connections-lifecycle.config.ts`: a stand-in stage that answers the
 * first request on each connection and resets the second, and a run directory whose `run.json`
 * names it as a Cloud target. The teardown fails the run unless the lifecycle saved the scenario's
 * lost request and the setup file saved the one made outside any scenario.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem } from "effect";
import { createServer, type Socket } from "node:net";
import { readLostRequests } from "./lost-requests.ts";

const run = ".local/lost-connections-lifecycle/run";

class RecordsMissing extends Error {}

// Vitest's global set-up is a Promise API.
/* oxlint-disable executor/no-manual-effect-runtime-in-tests */
export default function setup() {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    let served = 0;
    socket.on("data", (chunk) => {
      if (!chunk.toString("latin1").includes("\r\n\r\n")) return;
      served += 1;
      if (served === 2) socket.resetAndDestroy();
      else
        socket.write(
          "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: keep-alive\r\n\r\n{}",
        );
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
  });
  const started = Effect.callback<number>((resume) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resume(Effect.succeed(typeof address === "object" && address !== null ? address.port : 0));
    });
  });
  return Effect.runPromise(
    Effect.gen(function* () {
      const port = yield* started;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(run, { recursive: true, force: true });
      yield* fs.makeDirectory(run, { recursive: true });
      yield* fs.writeFileString(
        `${run}/run.json`,
        JSON.stringify({
          target: "cloud",
          origin: `http://127.0.0.1:${port}`,
          mode: "attached",
          runtime: "stand-in",
          commit: "0000000",
          dirty: false,
          startedAt: new Date(0).toISOString(),
          interactive: false,
          diagnostics: "",
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  ).then(
    () => () =>
      Effect.runPromise(
        Effect.gen(function* () {
          for (const socket of sockets) socket.destroy();
          server.close();
          const records = yield* readLostRequests([run]);
          const inScenario = records.some(
            (record) =>
              record.scenario?.endsWith("is saved by the scenario lifecycle") === true &&
              record.outcome === "sent again: answered",
          );
          const outside = records.some(
            (record) =>
              record.scenario === undefined && record.file === "lost-connections-lifecycle.spec.ts",
          );
          if (!inScenario || !outside)
            throw new RecordsMissing(
              `The lifecycle did not save the lost requests: in a scenario ${inScenario}, outside any scenario ${outside}; ${records.length} records read.`,
            );
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );
}
/* oxlint-enable executor/no-manual-effect-runtime-in-tests */
