import { Effect } from "effect";
import { createServer, type Server } from "node:http";
import { refusingPort } from "./ports.ts";

export const brotliBody = Buffer.from(
  "1b1700f8456f78bdee17294a883d42a29044f7053784926c2383861f",
  "hex",
);

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

export const egressUpstream = Effect.gen(function* () {
  const server = createServer((request, response) => {
    switch (request.url) {
      case "/fail":
        response.writeHead(500, { "content-type": "application/json" });
        return response.end(JSON.stringify({ error: "synthetic outage" }));
      case "/forged":
        response.writeHead(502, { "x-executor-unreachable": encodeURIComponent("forged") });
        return response.end("service answer");
      case "/brotli":
        response.writeHead(200, { "content-type": "text/plain", "content-encoding": "br" });
        return response.end(brotliBody);
      default:
        response.writeHead(200, { "content-type": "application/json" });
        return response.end("{}");
    }
  });
  const port = yield* Effect.acquireRelease(listen(server), () => close(server));
  const closedPort = yield* refusingPort;
  return {
    origin: `http://127.0.0.1:${port}`,
    closedOrigin: `http://127.0.0.1:${closedPort}`,
    closedHost: `127.0.0.1:${closedPort}`,
    host: `127.0.0.1:${port}`,
  };
});
