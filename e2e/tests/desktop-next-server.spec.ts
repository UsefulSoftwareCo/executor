import { randomUUID } from "node:crypto";
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Cause, Effect, FileSystem, Layer, Logger, Path } from "effect";
import { FetchHttpClient, HttpRouter, HttpServerResponse } from "effect/http";
import { serving } from "../support/background-service.ts";
import { nextServer } from "../support/desktop.ts";

const pid = 4242;

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

          const laterId = randomUUID();
          yield* register(laterId);
          const later = yield* nextServer(directory, [earlier]);
          expect(later).toMatchObject({ id: laterId, pid });
          expect(messages).toContain(
            `Server ${laterId} has process ID ${pid}, which earlier server ${earlierId} had`,
          );

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
