import { build } from "esbuild";
import assert from "node:assert/strict";
/** Bundle the same isolated Worker for Miniflare and real Cloudflare validation. */
export const bundleHarness = async (facetCode?: string) => {
  const facet = await build({
    entryPoints: [new URL("./fixtures/storage-facet.mjs", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:workers"],
  });
  const code = facetCode ?? facet.outputFiles[0]?.text;
  assert.ok(code);
  const supervisor = await build({
    entryPoints: [new URL("./fixtures/supervisor.mjs", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:workers"],
    plugins: [
      {
        name: "facet",
        setup(build) {
          build.onResolve({ filter: /^facet:code$/ }, () => ({ path: "code", namespace: "facet" }));
          build.onLoad({ filter: /.*/, namespace: "facet" }, () => ({
            contents: code,
            loader: "text",
          }));
        },
      },
    ],
  });
  const output = supervisor.outputFiles[0]?.text;
  assert.ok(output);
  return output;
};
