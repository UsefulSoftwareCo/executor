/** Shared TanStack Start build for every dashboard. Hosts supply only their routes and entries. */
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import type { PluginOption } from "vite-plus";

type StartOptions = NonNullable<Parameters<typeof tanstackStart>[0]>;
type RouterOptions = NonNullable<StartOptions["router"]>;

/**
 * Build metadata is public page configuration. The environment name is compiled into both bundles.
 * The build id is compiled into the server bundle only: a browser file naming it would change with
 * every deploy, and so would every file importing it, so deploys would remove files that pages
 * still running the previous build need. The browser reads it from the document instead.
 */
const buildMetadata = (): PluginOption => ({
  name: "executor-build-metadata",
  config: () => ({
    define: {
      "import.meta.env.VITE_EXECUTOR_ENVIRONMENT_NAME": JSON.stringify(
        process.env.EXECUTOR_ENVIRONMENT ?? "development",
      ),
    },
    environments: {
      ssr: {
        define: {
          "import.meta.env.VITE_EXECUTOR_BUILD": JSON.stringify(
            process.env.EXECUTOR_BUILD_VERSION ?? "development",
          ),
        },
      },
    },
  }),
});

/** Server builds are self-contained; dev keeps dependencies external to Vite's Node module runner. */
const serverBundle = (runtime: "workerd" | "node"): PluginOption => ({
  name: "executor-dashboard-server-bundle",
  config: (_, { command }) => ({
    environments: {
      ssr: {
        resolve: {
          ...(command === "build" ? { noExternal: true } : {}),
          ...(runtime === "workerd" && command === "build"
            ? { conditions: ["workerd", "worker", "module", "import", "default"] }
            : {}),
        },
      },
    },
  }),
});

/**
 * Start's server manifest records each route's absolute source path, which the server never
 * reads. Recording it relative to the app keeps the server build identical wherever the
 * repository is checked out, so a size measured in one checkout holds in every other.
 */
const relativeRouteFiles = (): PluginOption => {
  let root = "";
  return {
    name: "executor-relative-route-files",
    enforce: "post",
    configResolved: (config) => {
      root = `${config.root}/`;
    },
    transform: (code, id) =>
      id.includes("tanstack-start-manifest:v") ? code.replaceAll(root, "") : undefined,
  };
};

/** Start owns routing, code splitting, the browser entry and the server document handler. */
export const dashboardStartPlugins = ({
  runtime,
  router = {},
  tailwind = tailwindcss(),
}: {
  readonly runtime: "workerd" | "node";
  readonly router?: Pick<RouterOptions, "codeSplittingOptions">;
  readonly tailwind?: ReturnType<typeof tailwindcss>;
}): Array<PluginOption> => [
  buildMetadata(),
  serverBundle(runtime),
  tanstackStart({
    srcDirectory: "src",
    router: {
      routesDirectory: "implementation/routes",
      generatedRouteTree: "implementation/routeTree.gen.ts",
      entry: "implementation/router.tsx",
      ...router,
    },
    client: { entry: "client.tsx" },
    server: { entry: "server.ts" },
  }),
  relativeRouteFiles(),
  react(),
  tailwind,
];
