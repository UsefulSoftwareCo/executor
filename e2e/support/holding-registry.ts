/**
 * A product npm registry that holds chosen requests open, for scenarios that must act while a call
 * or a build waits inside the product's runtime.
 */
import { createServer, type ServerResponse } from "node:http";
import { Config, Effect, Queue } from "effect";

/** What the holding server never answers: the app's own request, and the stalled package. */
const holds = (url: string) => url === "/held" || url.toLowerCase().includes("stalled-package");

/**
 * The product's npm registry, in front of the suite's. A request it holds is announced by its path
 * and kept open until the scope ends; the app's tool waits on one too. The scenario then knows
 * when a call or a build is waiting inside workerd. Every other request reaches the suite's
 * registry unchanged.
 */
export const holdingRegistry = Effect.gen(function* () {
  const upstream = (yield* Config.String("E2E_NPM_REGISTRY").pipe(
    Config.withDefault("https://registry.npmjs.org"),
  )).replace(/\/$/, "");
  const arrived = yield* Queue.unbounded<string>();
  const held = new Set<ServerResponse>();
  const server = yield* Effect.acquireRelease(
    Effect.callback<ReturnType<typeof createServer>>((resume) => {
      const server = createServer((request, response) => {
        const url = request.url ?? "/";
        if (holds(url)) {
          held.add(response);
          Queue.offerUnsafe(arrived, url);
          return;
        }
        fetch(`${upstream}${url}`).then(
          (reply) =>
            reply.arrayBuffer().then((bytes) => {
              response.writeHead(reply.status, {
                "content-type": reply.headers.get("content-type") ?? "application/octet-stream",
              });
              response.end(Buffer.from(bytes));
            }),
          () => {
            response.writeHead(502);
            response.end();
          },
        );
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        for (const response of held) response.destroy();
        server.close(() => resume(Effect.void));
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    return yield* Effect.die("The holding server has no port");
  return { origin: `http://127.0.0.1:${address.port}`, arrived };
});
