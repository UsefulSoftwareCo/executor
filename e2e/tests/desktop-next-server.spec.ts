/**
 * The desktop recovery harness's `nextServer` tells servers apart by the id each registers, not by
 * process ID: Windows soon gives a new background server the process ID of one that has exited, and
 * a harness that compared process IDs refused the server the desktop had joined. No release run
 * reuses a process ID on demand, so this case writes `server.json` itself and answers
 * `/api/service` from a stub, keeping the process ID and changing the id.
 */
import { randomUUID } from "node:crypto";
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Cause, Effect, FileSystem, Layer, Logger, Path } from "effect";
import { FetchHttpClient, HttpRouter, HttpServerResponse } from "effect/http";
import { serving } from "../support/background-service.ts";
import { nextServer } from "../support/desktop.ts";

const pid = 4242;

/** A stand-in for the background server: answers `/api/service` as `current` says. */
const stubServer = Effect.gen(function* () {
  const current = { id: "" };
  const url = yield* serving(
    HttpRouter.add(
      "GET",
      "/api/service",
      Effect.sync(() =>
        HttpServerResponse.jsonUnsafe({
          id: current.id,
          version: "0.0.0-dev",
          pid,
          status: "ready",
        }),
      ),
    ),
  );
  return { current, url };
});

const messages: Array<string> = [];
const capture = Logger.layer(
  [
    Logger.make(({ message }) => {
      messages.push(Array.isArray(message) ? message.join(" ") : String(message));
    }),
  ],
  { mergeWithExisting: true },
);

layer(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer, capture), {
  excludeTestServices: true,
})("desktop recovery's nextServer", (it) => {
  it.effect(
    "accepts a new server that has an earlier server's process ID, says so, and still refuses the earlier server",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped();
          const stub = yield* stubServer;
          /** Register the server with `id` in `server.json`, and make the stub answer as it. */
          const register = (id: string) =>
            Effect.gen(function* () {
              stub.current.id = id;
              yield* fs.writeFileString(
                path.join(directory, "server.json"),
                JSON.stringify({ id, version: "0.0.0-dev", url: stub.url, pid, password: "p" }),
              );
            });

          const earlierId = randomUUID();
          yield* register(earlierId);
          const earlier = yield* nextServer(directory, []);
          expect(earlier).toMatchObject({ id: earlierId, pid });

          // The next server has the same process ID and its own id: it is new.
          const laterId = randomUUID();
          yield* register(laterId);
          const later = yield* nextServer(directory, [earlier]);
          expect(later).toMatchObject({ id: laterId, pid });
          expect(messages).toContain(
            `Server ${laterId} has process ID ${pid}, which earlier server ${earlierId} had`,
          );

          // The earlier server, answering as itself again, is still not a new one.
          yield* register(earlierId);
          const refused = yield* nextServer(directory, [earlier]).pipe(
            Effect.timeout("2 seconds"),
            Effect.flip,
          );
          expect(Cause.isTimeoutError(refused)).toBe(true);
        }),
      ),
    30_000,
  );
});
