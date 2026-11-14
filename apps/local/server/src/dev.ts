/** Development composition edge: Vite assets and product APIs share one origin. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, Redacted } from "effect";
import { localConfiguration } from "./implementation/bootstrap.ts";
import { developmentWeb } from "./implementation/development.ts";
import { localDevtools } from "./implementation/devtools.ts";
import { startLocalServer } from "./node.ts";

const development = Effect.gen(function* () {
  const settings = yield* localConfiguration(process.platform);
  const web = yield* developmentWeb(settings);
  const server = yield* startLocalServer(settings, {
    product: "cli",
    web,
    devtools: localDevtools,
  });
  const link = yield* server.issuePairingLink;
  yield* Console.log(
    `Executor dev: ${settings.browserOrigin ?? server.url}\nUI hot reload is enabled.\nConnect (one use, expires in 5 minutes):\n${Redacted.value(link.url)}`,
  );
  // It stops, as every server does, once another server has taken its data directory's lock.
  const reason = yield* server.stopped;
  yield* Console.error(`Executor dev stopped: ${reason}.`);
});

NodeRuntime.runMain(Effect.scoped(development).pipe(Effect.provide(NodeServices.layer)));
