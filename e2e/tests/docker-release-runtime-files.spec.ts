/**
 * The image's runtime belongs to root. The host reads `/app/workerd.capnp`, `/app/product.mjs` and
 * the workerd binary again at every start, so the user that runs app code must not be able to change
 * them, or anything else under `/app` and the host's own executables. Only the product and telemetry
 * data directories are that user's. Before, the runtime was copied owned by that user.
 */
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { releasedServer } from "../support/docker-release-server.ts";

/**
 * Every path under /app outside the data directories, /app itself included, and the host's
 * executables that the running user may write, by access(2) and by opening the files the host reads
 * for appending, which writes nothing. The image has no `find`, so dash walks the tree.
 */
const writableRuntime = `
walk() {
  for f in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    case "$f" in /app/data|/app/motel-data) continue ;; esac
    [ -w "$f" ] && echo "$f"
    [ -d "$f" ] && [ ! -L "$f" ] && walk "$f"
  done
}
for f in /app /usr/local/bin /usr/local/bin/executor-host /usr/local/bin/executor-entrypoint; do
  [ -w "$f" ] && echo "$f"
done
walk /app
for f in /app/workerd.capnp /app/product.mjs /app/workerd; do
  (: >> "$f") 2>/dev/null && echo "opened $f"
done
for f in /app/data /app/motel-data; do
  [ -w "$f" ] && echo "data $f"
done
`;

it.live("released image's runtime files cannot be changed by the user that runs app code", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* releasedServer;
      const writable = (yield* server.exec(writableRuntime)).split("\n").filter(Boolean);
      expect(writable, "paths the running user may write").toEqual([
        "data /app/data",
        "data /app/motel-data",
      ]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
