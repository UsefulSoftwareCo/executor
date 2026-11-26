import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import type { PluginOption } from "vite-plus";

type StartOptions = NonNullable<Parameters<typeof tanstackStart>[0]>;
type RouterOptions = NonNullable<StartOptions["router"]>;

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

const e2eSourceMaps = (): PluginOption => ({
  name: "executor-e2e-source-maps",
  config: () =>
    process.env.EXECUTOR_DASHBOARD_SOURCEMAP === "hidden"
      ? { build: { sourcemap: "hidden" } }
      : undefined,
});

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
  e2eSourceMaps(),
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
