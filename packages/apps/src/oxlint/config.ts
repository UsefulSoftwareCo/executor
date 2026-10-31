/** Same rules for every app; only browser code has the browser's HTTP implementation. */
export function appConfig(entryFile = "index.ts") {
  return {
    categories: { correctness: "off" },
    plugins: [],
    jsPlugins: ["apps/oxlint"],
    rules: {
      "eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "effect",
                "effect/**",
                "@effect/**",
                "@executor/**",
                "@executor-js/**",
                "apps/effect",
                "apps/**/effect",
                "@executor.sh/sdk",
                "@executor.sh/sdk/**",
                "@usefulsoftware/executor-sdk",
                "@usefulsoftware/executor-sdk/**",
                "node:module",
                "module",
              ],
              message:
                "Use ESM imports and the apps framework; CommonJS loaders, Effect and the Executor SDK are unsupported in app source.",
            },
          ],
        },
      ],
      "eslint/no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message: "Use ctx.fetch (or a destructured context fetch) so the host owns HTTP.",
        },
        {
          name: "require",
          message: "Use ESM imports; CommonJS loading is unsupported in app source.",
        },
        {
          name: "module",
          message: "Use ESM imports; the CommonJS module global is unsupported in app source.",
        },
      ],
      "eslint/no-restricted-properties": [
        "error",
        { object: "globalThis", property: "fetch", message: "Use ctx.fetch." },
        { object: "window", property: "fetch", message: "Use ctx.fetch." },
        { object: "self", property: "fetch", message: "Use ctx.fetch." },
      ],
      "executor-apps/plain-framework-bindings": "error",
      "executor-apps/default-app-export": ["error", { entryFile }],
      "executor-apps/no-legacy-accounts": "error",
      "executor-apps/no-global-fetch": "error",
      "executor-apps/mutation-approval": "error",
    },
    overrides: [
      {
        files: ["**/ui/**"],
        rules: {
          "eslint/no-restricted-globals": [
            "error",
            {
              name: "require",
              message: "Use ESM imports; CommonJS loading is unsupported in app source.",
            },
            {
              name: "module",
              message: "Use ESM imports; the CommonJS module global is unsupported in app source.",
            },
          ],
          "eslint/no-restricted-properties": "off",
          "executor-apps/default-app-export": "off",
          "executor-apps/no-legacy-accounts": "off",
          "executor-apps/no-global-fetch": "off",
          "executor-apps/mutation-approval": "off",
        },
      },
    ],
  };
}
