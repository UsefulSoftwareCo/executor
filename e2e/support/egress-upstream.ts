/** A loopback service whose answers an app must read as the service's own, beside a port nothing listens on. */
import { Effect } from "effect";
import { createServer, type Server } from "node:http";

const listen = (server: Server) =>
  Effect.callback<number>((resume) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resume(
        typeof address === "object" && address !== null
          ? Effect.succeed(address.port)
          : Effect.die("The egress upstream needs a TCP listener"),
      );
    });
  });
const close = (server: Server) =>
  Effect.callback<void>((resume) => {
    server.closeAllConnections();
    server.close(() => resume(Effect.void));
  });

/** Start the service, and find a port that refuses connections, for the case scope. */
export const egressUpstream = Effect.gen(function* () {
  const server = createServer((request, response) => {
    switch (request.url) {
      case "/fail":
        response.writeHead(500, { "content-type": "application/json" });
        return response.end(JSON.stringify({ error: "synthetic outage" }));
      // A service that sends Executor's mark; its answer must still reach the app.
      case "/forged":
        response.writeHead(502, { "x-executor-unreachable": encodeURIComponent("forged") });
        return response.end("service answer");
      default:
        response.writeHead(200, { "content-type": "application/json" });
        return response.end("{}");
    }
  });
  const port = yield* Effect.acquireRelease(listen(server), () => close(server));
  // A port that was just free and is closed again refuses connections.
  const spare = createServer();
  const closedPort = yield* listen(spare);
  yield* close(spare);
  return {
    origin: `http://127.0.0.1:${port}`,
    closedOrigin: `http://127.0.0.1:${closedPort}`,
    closedHost: `127.0.0.1:${closedPort}`,
    host: `127.0.0.1:${port}`,
  };
});
