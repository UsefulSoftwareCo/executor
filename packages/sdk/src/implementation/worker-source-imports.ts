import type { InMemoryFileSystem } from "@cloudflare/worker-bundler";
import type { Path } from "effect";
import type { Plugin } from "esbuild";

const emittedExtensions: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx", ".js", ".jsx"],
  ".jsx": [".tsx", ".jsx"],
  ".mjs": [".mts", ".mjs"],
  ".cjs": [".cts", ".cjs"],
};
const implicitExtensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"];

export const sourceImports = (filesystem: InMemoryFileSystem, path: Path.Path): Plugin => ({
  name: "executor-source-imports",
  setup(build) {
    build.onResolve({ filter: /^\.\.?(?:\/|$)/, namespace: "virtual" }, (args) => {
      if (args.importer.startsWith("node_modules/")) return undefined;
      const target = path.resolve("/", args.resolveDir, args.path).slice(1);
      const extension = path.extname(target);
      const emitted = emittedExtensions[extension];
      const candidates =
        emitted === undefined
          ? [
              target,
              ...implicitExtensions.map((source) => `${target}${source}`),
              ...implicitExtensions.map((source) => `${target}/index${source}`),
            ]
          : emitted.map((source) => `${target.slice(0, -extension.length)}${source}`);
      const resolved = candidates.find((file) => filesystem.read(file) !== null);
      return resolved === undefined
        ? { errors: [{ text: `Cannot find "${args.path}" among the deployed source files.` }] }
        : { path: resolved, namespace: "virtual" };
    });
  },
});
