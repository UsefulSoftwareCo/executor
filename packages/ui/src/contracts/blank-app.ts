/** Files a blank app starts from. The version is the one `framework.release` returns. */
import { appSlug } from "@executor-js/sdk";

type SourceFile = { readonly path: string; readonly content: string };

const index = `import { defineApp, router } from "apps";

export default defineApp({ accounts: {} }, async () => ({
  tools: router({}),
}));
`;

/** `index.ts` and a `package.json` that pins this host's `apps` release. */
export const blankAppFiles = (
  name: string,
  appsVersion: string,
): readonly [SourceFile, ...SourceFile[]] => [
  { path: "index.ts", content: index },
  {
    path: "package.json",
    content: `${JSON.stringify(
      {
        name: appSlug(name),
        private: true,
        type: "module",
        dependencies: { apps: appsVersion },
      },
      null,
      2,
    )}\n`,
  },
];
