import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Config, Effect } from "effect";

export const credentialedRegistry = Effect.gen(function* () {
  const upstream = (yield* Config.String("E2E_NPM_REGISTRY").pipe(
    Config.withDefault("https://registry.npmjs.org"),
  )).replace(/\/$/, "");
  const user = `synthetic-user-${randomUUID().slice(0, 8)}`;
  const password = `synthetic-password-${randomUUID().slice(0, 8)}`;
  const token = `synthetic-token-${randomUUID().slice(0, 8)}`;
  const tokenPrefix = `/mirror?token=${token}`;
  const server = yield* Effect.acquireRelease(
    Effect.callback<ReturnType<typeof createServer>>((resume) => {
      const server = createServer((request, response) => {
        const url = request.url ?? "/";
        const path = url.startsWith(tokenPrefix) ? url.slice(tokenPrefix.length) || "/" : url;
        fetch(`${upstream}${path}`).then(
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
        server.close(() => resume(Effect.void));
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    return yield* Effect.die("The credentialed registry has no port");
  const host = `127.0.0.1:${address.port}`;
  return {
    url: `http://${user}:${password}@${host}/mirror?token=${token}`,
    location: `http://${host}/mirror`,
    secrets: [user, password, token],
  };
});
