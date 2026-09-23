/** Build the product, app host and workflow engine for one shared workerd executable. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { readExecutorSkills } from "@executor-js/app-templates/executor";
import { bundleWorkerdHost } from "@executor-js/sdk/node/build";
import { build } from "esbuild";
import { Effect, FileSystem, Path, Schema } from "effect";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const InternalWorker = Schema.Struct({
  main: Schema.String,
  modules: Schema.Record(Schema.String, Schema.String),
});
const packageRuntime = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "../../../..");
  const output = path.join(root, "apps/hosted/self-host/dist/workerd");
  const resolve = createRequire(path.join(root, "apps/hosted/self-host/package.json"));
  const sdkResolve = createRequire(path.join(root, "packages/sdk/package.json"));
  const alchemyRoot = path.resolve(
    sdkResolve.resolve("@alchemy.run/cloudflare-runtime/core"),
    "../../../",
  );
  const alchemyResolve = createRequire(path.join(alchemyRoot, "package.json"));
  yield* fs.remove(output, { recursive: true, force: true });
  yield* fs.makeDirectory(output, { recursive: true });
  const web = path.join(root, "apps/hosted/self-host/web/dist");
  const types: Readonly<Record<string, string>> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".txt": "text/plain",
  };
  const dashboard = Object.fromEntries(
    (yield* fs.readDirectory(web, { recursive: true }))
      .filter((name) => path.extname(name) !== "")
      .map((name) => [
        name.split(path.sep).join("/"),
        types[path.extname(name)] ?? "application/octet-stream",
      ]),
  );
  const skills = Object.fromEntries(
    (yield* readExecutorSkills).map((file) => [file.path, file.content]),
  );
  const product = yield* Effect.tryPromise(() =>
    build({
      absWorkingDir: root,
      entryPoints: ["apps/hosted/self-host/src/worker.ts"],
      outfile: path.join(output, "product.mjs"),
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      conditions: ["workerd"],
      minify: true,
      keepNames: true,
      sourcemap: "external",
      sourcesContent: false,
      legalComments: "external",
      metafile: true,
      external: [
        "node:*",
        "cloudflare:*",
        "executor:pglite.wasm",
        "executor:initdb.wasm",
        "executor:pglite.data",
      ],
      plugins: [
        {
          name: "host-assets",
          setup(builder) {
            builder.onResolve({ filter: /^executor:(skills|dashboard)$/ }, (args) => ({
              path: args.path,
              namespace: "assets",
            }));
            builder.onLoad({ filter: /.*/, namespace: "assets" }, (args) => ({
              contents: `export default ${JSON.stringify(args.path === "executor:skills" ? skills : dashboard)}`,
              loader: "js",
            }));
          },
        },
        {
          name: "pglite-workerd",
          setup(builder) {
            // Emscripten only uses these modules to construct trusted PostgreSQL C
            // callback wrappers. No authored app receives the unsafeEval binding.
            builder.onLoad({ filter: /@electric-sql\/pglite\/dist\/.*\.js$/ }, async (args) => {
              const source = await readFile(args.path, "utf8");
              return {
                contents:
                  'import { env as __pgEnv } from "cloudflare:workers";\n' +
                  source
                    .replaceAll(
                      "import.meta.url",
                      JSON.stringify("https://pglite.invalid/pglite.js"),
                    )
                    .replaceAll(
                      "self.location.href",
                      JSON.stringify("https://pglite.invalid/pglite.js"),
                    )
                    .replaceAll("process.versions.node", "undefined")
                    .replaceAll("new WebAssembly.Module(", "__pgEnv.UNSAFE_EVAL.newWasmModule("),
                loader: "js",
              };
            });
          },
        },
      ],
    }),
  );
  yield* fs.writeFileString(
    path.join(output, "../workerd-meta.json"),
    JSON.stringify(product.metafile),
  );
  const pg = path.dirname(resolve.resolve("@electric-sql/pglite"));
  for (const file of ["pglite.wasm", "initdb.wasm", "pglite.data"])
    yield* fs.copyFile(path.join(pg, file), path.join(output, file));
  const modules = yield* bundleWorkerdHost;
  const moduleConfig: string[] = [];
  yield* fs.makeDirectory(path.join(output, "apps"), { recursive: true });
  for (const module of modules) {
    const file = `apps/${module.name}`;
    yield* fs.makeDirectory(path.dirname(path.join(output, file)), { recursive: true });
    if (module.type === "Wasm") yield* fs.writeFile(path.join(output, file), module.content);
    else
      yield* fs.writeFileString(
        path.join(output, file),
        Schema.decodeUnknownSync(Schema.String)(module.content),
      );
    const kind = module.type === "Wasm" ? "wasm" : module.type === "Json" ? "json" : "esModule";
    moduleConfig.push(`(name=${JSON.stringify(module.name)},${kind}=embed "@@RUNTIME@@/${file}")`);
  }
  const internal = (name: string) =>
    Effect.tryPromise(
      () =>
        import(path.join(alchemyRoot, `dist/core/workers/bindings/workflows/${name}.worker.mjs`)),
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(InternalWorker)));
  const workflow = yield* internal("binding"),
    wrapped = yield* internal("wrapped-binding");
  const workflowModules: string[] = [];
  yield* fs.makeDirectory(path.join(output, "workflows"), { recursive: true });
  for (const [name, code] of Object.entries(workflow.modules).sort(([a], [b]) =>
    a === workflow.main ? -1 : b === workflow.main ? 1 : a.localeCompare(b),
  )) {
    const file = `workflows/${workflowModules.length}.mjs`;
    yield* fs.writeFileString(path.join(output, file), code);
    workflowModules.push(`(name=${JSON.stringify(name)},esModule=embed "@@RUNTIME@@/${file}")`);
  }
  if (Object.keys(wrapped.modules).length !== 1)
    return yield* Effect.die(new Error("Unexpected workflow extension shape"));
  yield* fs.writeFileString(
    path.join(output, "workflow-binding.mjs"),
    Schema.decodeUnknownSync(Schema.String)(wrapped.modules[wrapped.main]),
  );
  yield* fs.copyFile(alchemyResolve.resolve("workerd/bin/workerd"), path.join(output, "workerd"));
  yield* fs.chmod(path.join(output, "workerd"), 0o755);
  yield* fs.copy(web, path.join(output, "web"), { overwrite: true });
  yield* fs.copy(
    path.join(root, "packages/telemetry/dist/motel-workerd"),
    path.join(output, "motel"),
    { overwrite: true },
  );
  const config = `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
 extensions=[(modules=[(name="cloudflare-runtime:workflows-wrapped-binding",internal=true,esModule=embed "@@RUNTIME@@/workflow-binding.mjs")])],
 services=[
  (name="product",worker=(
   compatibilityDate="2026-09-01",compatibilityFlags=["nodejs_compat"],
   modules=[(name="product.mjs",esModule=embed "@@RUNTIME@@/product.mjs"),(name="executor:pglite.wasm",wasm=embed "@@RUNTIME@@/pglite.wasm"),(name="executor:initdb.wasm",wasm=embed "@@RUNTIME@@/initdb.wasm"),(name="executor:pglite.data",data=embed "@@RUNTIME@@/pglite.data")],
   bindings=[(name="PRODUCT",durableObjectNamespace="ExecutorProduct"),(name="NATIVE",service="native"),(name="LEGACY_DATABASE",service="legacy-data"),(name="BLOBS",service="builds"),(name="DASHBOARD",service="dashboard"),(name="PUBLIC_FETCH",service="public"),(name="PRIVATE_FETCH",service="internet"),(name="APPS",service="apps"),(name="UNSAFE_EVAL",unsafeEval=void)],
   durableObjectNamespaces=[(className="ExecutorProduct",uniqueKey="executor-product",enableSql=true,preventEviction=true)],durableObjectStorage=(localDisk="product-data")
  )),
  (name="apps",worker=(
   compatibilityDate="2026-07-30",compatibilityFlags=["nodejs_compat"],modules=[${moduleConfig.join(",")}],
   bindings=[(name="LOADER",workerLoader=()),(name="DATA",durableObjectNamespace="AppDataSupervisor"),(name="AUTH",text="service-binding"),(name="APPS_PRIVATE_FETCH",json="@@APPS_PRIVATE_FETCH@@"),(name="PUBLIC_FETCH",service="public"),(name="HOST",service=(name="product",entrypoint="WorkflowCallbacks")),(name="RUNS",wrapped=(moduleName="cloudflare-runtime:workflows-wrapped-binding",innerBindings=[(name="binding",service=(name="workflows",entrypoint="WorkflowBinding"))]))],
   durableObjectNamespaces=[(className="AppDataSupervisor",uniqueKey="executor-app-data",enableSql=true)],durableObjectStorage=(localDisk="app-data")
  )),
  (name="workflows",worker=(
   compatibilityDate="2026-09-01",compatibilityFlags=["experimental","nodejs_compat"],modules=[${workflowModules.join(",")}],
   bindings=[(name="ENGINE",durableObjectNamespace="Engine"),(name="USER_WORKFLOW",service=(name="apps",entrypoint="AppWorkflows")),(name="BINDING_NAME",json=${JSON.stringify(JSON.stringify("executor-app-workflows"))}),(name="WORKFLOW_NAME",json=${JSON.stringify(JSON.stringify("executor-app-workflows"))})],
   durableObjectNamespaces=[(className="Engine",uniqueKey="executor-app-workflows",enableSql=true,preventEviction=true)],durableObjectStorage=(localDisk="workflow-data")
  )),
  (name="motel",worker=(
   compatibilityDate="2026-09-01",compatibilityFlags=["nodejs_compat"],modules=[(name="motel.mjs",esModule=embed "@@RUNTIME@@/motel/motel.mjs")],
   bindings=[(name="STORE",durableObjectNamespace="MotelCollector"),(name="ASSETS",service="motel-assets")],
   durableObjectNamespaces=[(className="MotelCollector",uniqueKey="motel",enableSql=true)],durableObjectStorage=(localDisk="motel-data")
  )),
  (name="native",external=(address="unix:/tmp/executor-native.sock",http=())),
  (name="public",network=(allow=["public"],tlsOptions=(trustBrowserCas=true,trustedCertificates=[@@EXTRA_CA_CERTIFICATES@@]))),
  (name="internet",network=(allow=["public","private","local"],tlsOptions=(trustBrowserCas=true,trustedCertificates=[@@EXTRA_CA_CERTIFICATES@@]))),
  (name="dashboard",disk=(path="@@RUNTIME@@/web")),(name="motel-assets",disk=(path="@@RUNTIME@@/motel/web/dist")),
  (name="product-data",disk=(path="/app/data/product",writable=true,allowDotfiles=true)),
  (name="legacy-data",disk=(path="/app/data/hosted.pglite",allowDotfiles=true)),
  (name="app-data",disk=(path="/app/data/workerd",writable=true,allowDotfiles=true)),
  (name="workflow-data",disk=(path="/app/data/workerd/workflows",writable=true,allowDotfiles=true)),
  (name="builds",disk=(path="/app/data/builds",writable=true)),
  (name="motel-data",disk=(path="/app/motel-data",writable=true,allowDotfiles=true))
 ],
 sockets=[(name="http",address="0.0.0.0:4400",http=(),service=@@PRODUCT_SERVICE@@),(name="motel",address="127.0.0.1:4318",http=(),service="motel")]
);
`;
  // Retain dependency notices with the executable image, including the embedded engines.
  const packageDirectories = new Set<string>([
    pg + "/..",
    alchemyRoot,
    path.dirname(alchemyResolve.resolve("workerd/package.json")),
  ]);
  for (const input of Object.keys(product.metafile.inputs)) {
    if (input.startsWith("(disabled):")) continue;
    const absolute = path.resolve(root, input),
      boundary = absolute.lastIndexOf("/node_modules/");
    if (boundary < 0) continue;
    const parts = absolute.slice(boundary + 14).split("/");
    packageDirectories.add(
      path.join(
        absolute.slice(0, boundary),
        "node_modules",
        ...parts.slice(0, parts[0]?.startsWith("@") ? 2 : 1),
      ),
    );
  }
  const inventory: string[] = [];
  for (const directory of packageDirectories) {
    const pkg = yield* fs
      .readFileString(path.join(directory, "package.json"))
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Struct({ name: Schema.String, version: Schema.String })),
          ),
        ),
      );
    inventory.push(`${pkg.name}@${pkg.version}`);
    const destination = path.join(
      output,
      "licenses",
      `${pkg.name.replaceAll("/", "__")}@${pkg.version}`,
    );
    yield* fs.makeDirectory(destination, { recursive: true });
    for (const name of yield* fs.readDirectory(directory))
      if (/^(licen[sc]e|notice|copying|copyright|third.party)([._-]|$)/i.test(name))
        yield* fs.copy(path.join(directory, name), path.join(destination, name));
  }
  yield* fs.writeFileString(
    path.join(output, "runtime-packages.txt"),
    inventory.sort().join("\n") + "\n",
  );
  yield* fs.writeFileString(path.join(output, "workerd.capnp"), config);
  // Count real files once, including native assets, and reject any link back to
  // the build tree. This budget covers both supported Linux architectures.
  const runtimeRoot = yield* fs.realPath(output);
  const counted = new Set<string>();
  const size = (file: string): Effect.Effect<number> =>
    Effect.gen(function* () {
      const real = yield* fs.realPath(file);
      if (!real.startsWith(runtimeRoot + path.sep))
        return yield* Effect.die(new Error(`Runtime asset escapes the package: ${file}`));
      if (counted.has(real)) return 0;
      counted.add(real);
      const info = yield* fs.stat(real);
      if (info.type === "File") return Number(info.size);
      if (info.type !== "Directory")
        return yield* Effect.die(new Error(`Unsupported runtime asset: ${file}`));
      let bytes = 0;
      for (const name of yield* fs.readDirectory(real)) bytes += yield* size(path.join(real, name));
      return bytes;
    }).pipe(Effect.orDie);
  const components: Record<string, number> = {};
  for (const name of (yield* fs.readDirectory(output)).sort()) {
    components[name] = yield* size(path.join(output, name));
  }
  const payloadBytes = Object.values(components).reduce((total, bytes) => total + bytes, 0);
  const budgetBytes = 600 * 1024 * 1024;
  if (payloadBytes > budgetBytes)
    return yield* Effect.die(new Error(`Runtime payload exceeds 600 MiB: ${payloadBytes} bytes`));
  yield* fs.writeFileString(
    path.join(output, "runtime-size.json"),
    JSON.stringify(
      {
        payloadBytes,
        budgetBytes,
        components,
      },
      null,
      2,
    ),
  );
  yield* Effect.logInfo(
    `Runtime payload: ${(payloadBytes / 1024 / 1024).toFixed(1)} MiB / 600 MiB`,
  );
  yield* Effect.logInfo(`Built workerd runtime at ${output}`);
});
NodeRuntime.runMain(Effect.scoped(packageRuntime).pipe(Effect.provide(NodeServices.layer)));
