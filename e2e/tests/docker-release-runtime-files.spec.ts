import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { releasedServer } from "../support/docker-release-server.ts";

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
