import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const out = join(root, ".selfhost-runtime");
const serverOut = join(out, "apps/host-selfhost/dist-server");
const requireFromSelfHost = createRequire(join(root, "apps/host-selfhost/package.json"));

// libSQL ships its native addon as per-platform optional dependencies
// (`@libsql/<os>-<arch>-<abi>`), and Bun installs only the one matching the
// build platform. The self-host image is built for both linux/amd64 and
// linux/arm64, so a hardcoded `@libsql/linux-x64-gnu` throws on the arm64 leg
// (that package isn't installed there). Derive it from the current build
// platform instead. Under buildx/QEMU `process.platform`/`process.arch` are the
// emulated target's values; for local runs they are the host's. The build base
// (oven/bun:1) and runtime (distroless cc-debian12) are both glibc, so linux
// uses the `-gnu` binding; revisit if an Alpine/musl base is ever introduced.
const libsqlNativePackage = (): string => {
  const platformMap: Record<string, string> = {
    "darwin-arm64": "darwin-arm64",
    "darwin-x64": "darwin-x64",
    "linux-arm64": "linux-arm64-gnu",
    "linux-x64": "linux-x64-gnu",
    "win32-x64": "win32-x64-msvc",
  };
  const key = `${process.platform}-${process.arch}`;
  const target = platformMap[key];
  if (!target) {
    throw new Error(
      `package-runtime: no @libsql native package mapped for ${key}. ` +
        "Add it to the platform map in apps/host-selfhost/scripts/package-runtime.ts.",
    );
  }
  return `@libsql/${target}`;
};

// The `workerd` package's bin/workerd is a Node shim that execs the real
// binary from the per-platform optional dependency
// (`@cloudflare/workerd-<os>-<arch>`); without it the runtime throws
// "workerd is unavailable on this platform" on first app-tool bundle or
// invoke. Same per-platform shape as libsql above.
const workerdPlatformPackage = (): string => {
  const platformMap: Record<string, string> = {
    "darwin-arm64": "workerd-darwin-arm64",
    "darwin-x64": "workerd-darwin-64",
    "linux-arm64": "workerd-linux-arm64",
    "linux-x64": "workerd-linux-64",
    "win32-x64": "workerd-windows-64",
  };
  const key = `${process.platform}-${process.arch}`;
  const target = platformMap[key];
  if (!target) {
    throw new Error(
      `package-runtime: no workerd platform package mapped for ${key}. ` +
        "Add it to the platform map in apps/host-selfhost/scripts/package-runtime.ts.",
    );
  }
  return `@cloudflare/${target}`;
};

const externalPackages = [
  "@cloudflare/worker-bundler",
  "quickjs-emscripten",
  "quickjs-emscripten-core",
  "@jitl/quickjs-ffi-types",
  "@jitl/quickjs-wasmfile-release-sync",
  "@jitl/quickjs-wasmfile-debug-sync",
  "@jitl/quickjs-wasmfile-release-asyncify",
  "@jitl/quickjs-wasmfile-debug-asyncify",
  "workerd",
  workerdPlatformPackage(),
  libsqlNativePackage(),
] as const;

const quickJsExternals = externalPackages.filter(
  (name) => name === "quickjs-emscripten" || name.startsWith("@jitl/"),
);

const packageDir = (name: string): string => {
  const packageJson = requireFromSelfHost.resolve(`${name}/package.json`, {
    paths: [join(root, "node_modules/.bun/node_modules")],
  });
  return dirname(packageJson);
};

const copyPackage = (name: string): void => {
  const destination = join(out, "node_modules", name);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(packageDir(name), destination, { recursive: true, dereference: true });
};

// The worker-bundler backend (packages/plugins/apps/src/pipeline/
// worker-bundler-artifact.ts) loads `dist/index.bundled.js` from the resolved
// package, falling back to bundling `dist/index.js` with esbuild at runtime.
// The npm package doesn't ship the bundled entry and the runtime image has no
// esbuild, so produce it here, the same way apps/cli/src/build.ts does for the
// packed CLI.
const writeBundledWorkerBundler = async (): Promise<void> => {
  const distPath = join(packageDir("@cloudflare/worker-bundler"), "dist");
  const esbuildEntry = requireFromSelfHost.resolve("esbuild", {
    paths: [join(root, "node_modules/.bun/node_modules")],
  });
  const { build } = await import(pathToFileURL(esbuildEntry).href);
  const result = await build({
    entryPoints: [join(distPath, "index.js")],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["./esbuild.wasm"],
    logLevel: "silent",
    write: false,
  });
  const source = result.outputFiles[0]?.text;
  if (source === undefined) throw new Error("failed to bundle @cloudflare/worker-bundler");
  writeFileSync(join(out, "node_modules/@cloudflare/worker-bundler/dist/index.bundled.js"), source);
};

rmSync(out, { recursive: true, force: true });
mkdirSync(serverOut, { recursive: true });

await Bun.$`bun build apps/host-selfhost/src/serve.ts --target=bun --format=esm --outdir=${serverOut} ${quickJsExternals.map((name) => `--external=${name}`)}`;

for (const name of externalPackages) copyPackage(name);
await writeBundledWorkerBundler();

if (!existsSync(join(serverOut, "serve.js"))) {
  throw new Error(
    "Expected bundled self-host server at .selfhost-runtime/apps/host-selfhost/dist-server/serve.js",
  );
}

console.log(`Packaged self-host runtime into ${out}`);
