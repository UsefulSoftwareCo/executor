/** Native development host resources. The packaged product uses workerd bindings. */
import { nativeRepositories } from "@executor-js/app-source/node";
import { filesystemBlobStore, workerdApps } from "@executor-js/sdk/node/workerd";
import type { SourceFile } from "@executor-js/sdk/core";
import type { HostEgress } from "@executor-js/utils/url-policy";
import { Config, Effect, Path } from "effect";
import { allowPrivateAppFetch, dataDirectory } from "./contracts/config.ts";
import { selfHostExecutorServices } from "./implementation/executor-services.ts";

/** Acquire the native app process and files in the product server's Effect scope. */
export const selfHostExecutor = (skills: readonly SourceFile[], egress: HostEgress) =>
  selfHostExecutorServices(skills, egress, (executor) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const directory = yield* dataDirectory;
      const origin = yield* Config.String("BETTER_AUTH_URL");
      const hostname = yield* Config.String("HOST").pipe(Config.withDefault("0.0.0.0"));
      const port = yield* Config.Number("PORT").pipe(Config.withDefault(4400));
      // A wildcard listener also accepts loopback connections.
      const listener = hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname;
      const blobs = filesystemBlobStore({ directory: path.resolve(directory, "builds") });
      const host = yield* workerdApps({
        directory: path.resolve(directory, "workerd"),
        blobs,
        executor,
        legacyDataDirectories: [
          path.resolve(directory, "app-data"),
          path.resolve(directory, "workflow-engine"),
        ],
        allowPrivateAppFetch: yield* allowPrivateAppFetch,
        selfOrigin: {
          origin,
          address: `${listener.includes(":") ? `[${listener}]` : listener}:${port}`,
        },
      });
      return {
        ...host,
        blobs,
        repositories: nativeRepositories(path.resolve(directory, "repositories")),
      };
    }),
  );
