import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import appPlugin from "@executor-js/app/vite";

const APP_ROOT = resolve(import.meta.dirname, "../../packages/app");
const APPS_LOCAL = resolve(import.meta.dirname, "../local");

// Electron's runtime is provided by the launcher binary, not the bundle.
// electron-log etc. ship native modules that also must stay external.
const ELECTRON_EXTERNALS = [
  "electron",
  "electron-log",
  "electron-log/main",
  "electron-store",
  "electron-updater",
  "electron-window-state",
  "@sentry/electron",
  "@sentry/electron/main",
];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      // Crash-report DSN baked in at build time (publish-desktop.yml).
      // Empty in local/dev builds → Sentry stays fully disabled.
      __EXECUTOR_SENTRY_DSN__: JSON.stringify(process.env.DESKTOP_SENTRY_DSN ?? ""),
    },
    build: {
      rollupOptions: {
        input: { index: "src/main/index.ts" },
        external: ELECTRON_EXTERNALS,
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        external: ELECTRON_EXTERNALS,
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    publicDir: resolve(APP_ROOT, "public"),
    define: {
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(
        process.env.npm_package_version ?? "0.0.0",
      ),
      "import.meta.env.VITE_GITHUB_URL": JSON.stringify("https://github.com/RhysSullivan/executor"),
      "import.meta.env.VITE_EXECUTOR_CIMD_CLIENT_ID_METADATA_BASE_URL": JSON.stringify(
        process.env.EXECUTOR_CIMD_CLIENT_ID_METADATA_BASE_URL ?? "https://executor.sh",
      ),
    },
    resolve: {
      alias: {
        "@executor-app/": `${APP_ROOT}/`,
      },
      dedupe: ["react", "react-dom"],
    },
    server: {
      fs: {
        allow: [resolve(import.meta.dirname, "../..")],
      },
    },
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
        },
      },
    },
    plugins: [
      appPlugin({
        executorConfigPath: resolve(APPS_LOCAL, "executor.config.ts"),
        executorJsoncPath: resolve(APPS_LOCAL, "executor.jsonc"),
      }),
    ],
  },
});
