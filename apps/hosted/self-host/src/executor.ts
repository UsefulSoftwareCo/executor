/** Native development host resources. The packaged product uses workerd bindings. */
import { nativeRepositories } from "@executor-js/app-source/node";
import { filesystemBlobStore, workerdApps } from "@executor-js/sdk/node/workerd";
import type { SourceFile } from "@executor-js/sdk/core";
import type { HostEgress } from "@executor-js/utils/url-policy";
import { Config, Effect, Path } from "effect";
import {
  allowPrivateAppFetch as allowPrivateAppFetchFor,
  dataDirectory,
} from "./contracts/config.ts";
import { selfHostExecutorServices } from "./implementation/executor-services.ts";

/** Acquire the native app process and files in the product server's Effect scope. */
export const selfHostExecutor = (skills: readonly SourceFile[], egress: HostEgress) =>
  selfHostExecutorServices(skills, egress, (executor) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const directory = yield* dataDirectory;
      const origin = yield* Config.String("BETTER_AUTH_URL");
      const allowPrivateAppFetch = yield* allowPrivateAppFetchFor(origin);
      const blobs = filesystemBlobStore({ directory: path.resolve(directory, "builds") });
      const host = yield* workerdApps({
        directory: path.resolve(directory, "workerd"),
        blobs,
        executor,
        legacyDataDirectories: [
          path.resolve(directory, "app-data"),
          path.resolve(directory, "workflow-engine"),
        ],
        allowPrivateAppFetch,
      });
      return {
        ...host,
        blobs,
        repositories: nativeRepositories(path.resolve(directory, "repositories")),
      };
    }),
  );
