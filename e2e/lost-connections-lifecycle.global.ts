import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem } from "effect";
import { createServer, type Socket } from "node:net";
import { readLostRequests } from "./lost-requests.ts";

const run = ".local/lost-connections-lifecycle/run";

class RecordsMissing extends Error {}

/* oxlint-disable executor/no-manual-effect-runtime-in-tests */
export default function setup() {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("data", (chunk) => {
      const text = chunk.toString("latin1");
      if (!text.includes("\r\n\r\n")) return;
      if (/^[A-Z]+ \/lose /u.test(text)) socket.resetAndDestroy();
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
              record.outcome === "lost: new connection",
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
