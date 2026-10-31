import { Effect, FileSystem, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Target } from "./platform.ts";
import { serverControl } from "./server-control.ts";

/** Launch the complete product with the same public typed registration an operator supplies. */
export const acquisitionProduct = (input: {
  readonly provider: string;
  readonly origin: string;
  readonly revision?: string;
  readonly retained?: readonly string[];
  readonly check?: boolean | "void";
}) =>
  Effect.gen(function* () {
    const target = yield* Target,
      fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const hosted = target.metadata.target === "self-host";
    const entry = path.join(target.directory, "acquisition-product.ts");
    const revision = input.revision ?? "dpl_fixture_driver_revision";
    const source = `
import * as Runtime from ${JSON.stringify(hosted ? "@effect/platform-bun/BunRuntime" : "@effect/platform-node/NodeRuntime")};
${hosted ? 'import { main } from "@executor-js/hosted-self-host/server";' : 'import { serveProcess } from "@executor-js/local-server";\nimport * as NodeServices from "@effect/platform-node/NodeServices";'}
import { AccountAcquisitionConfiguration, ProviderId, type AccountAcquisitionContext } from "@executor-js/sdk/core";
import { accountAcquisitionDriver } from "@executor-js/sdk";
import { InteractiveStart, InteractiveStatus, AccountCheckResult, HostOperationFailed } from "apps/contracts";
import { Effect, Redacted, Schema } from "effect";

const call = async <A, I>(context: AccountAcquisitionContext, step: string, schema: Schema.Codec<A, I>, data: object = {}) => {
    const response = await context.fetch(${JSON.stringify(input.origin + "/connect")}, {
      method: "POST", signal: context.signal,
      headers: { authorization: "Bearer synthetic-backend-key", "content-type": "application/json" },
      body: JSON.stringify({ step, method: context.method, caller: context.owner, operation: context.operation, ...data }),
    });
    if (!response.ok) throw new HostOperationFailed({});
    return Schema.decodeUnknownSync(schema)(await response.json());
};
const driver = (revision: string) => accountAcquisitionDriver({
  id: "synthetic-account-driver", revision,
  start: (ctx, reconnect) => call(ctx, "start", InteractiveStart,
    reconnect === undefined ? {} : { ref: Redacted.value(reconnect.reference) }),
  status: (ctx, value) => call(ctx, "status", InteractiveStatus, value),
  submit: (ctx, value) => call(ctx, "submit", InteractiveStatus, value),
  cancel: async (ctx, value) => { await call(ctx, "cancel", Schema.Null, value); },
  remove: async (ctx) => { await call(ctx, "remove", Schema.Null, { ref: Redacted.value(ctx.reference) }); },
  ${input.check === false ? "" : input.check === "void" ? "check: async () => undefined," : 'check: (ctx) => call(ctx, "check", AccountCheckResult, { ref: Redacted.value(ctx.reference) }),'}
});
const configuration = { registrations: ${JSON.stringify([revision, ...(input.retained ?? [])])}.map((revision, index) => ({
  provider: ProviderId.make(${JSON.stringify(input.provider)}), method: "paste", current: index === 0, driver: driver(revision),
  fetch: globalThis.fetch,
})) };
Runtime.runMain(
  ${hosted ? "main" : 'Effect.scoped(serveProcess({ mode: "foreground", platform: process.platform })).pipe(Effect.provide(NodeServices.layer))'}
    .pipe(Effect.provideService(AccountAcquisitionConfiguration, configuration)),
);
`;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const packages = path.join(target.directory, "node_modules", "@executor-js");
    yield* fs.makeDirectory(packages, { recursive: true });
    const packageName = hosted ? "hosted-self-host" : "local-server";
    const packageLink = path.join(packages, packageName);
    if (!(yield* fs.exists(packageLink)))
      yield* fs.symlink(
        path.resolve(hosted ? "apps/hosted/self-host" : "apps/local/server"),
        packageLink,
      );
    const linked = [
      ["apps", "packages/apps"],
      ...(hosted
        ? [["@effect/platform-bun", "apps/hosted/self-host/node_modules/@effect/platform-bun"]]
        : []),
    ] as const;
    for (const [name, location] of linked) {
      const destination = path.join(target.directory, "node_modules", name);
      yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
      if (!(yield* fs.exists(destination))) yield* fs.symlink(path.resolve(location), destination);
    }
    yield* fs.writeFileString(entry, source);
    const configuration = path.join(target.directory, "acquisition-tsconfig.json");
    yield* fs.writeFileString(
      configuration,
      JSON.stringify({
        extends: path.resolve("tsconfig.json"),
        compilerOptions: { typeRoots: [path.resolve("node_modules/@types")] },
        files: [entry],
        include: [],
        exclude: [],
      }),
    );
    const checked = yield* processes.exitCode(
      ChildProcess.make(
        path.resolve("node_modules/.bin/tsc-rs"),
        ["--noEmit", "-p", configuration],
        { stdout: "inherit", stderr: "inherit" },
      ),
    );
    if (checked !== 0)
      return yield* Effect.die("Public acquisition product entry failed its typecheck");
    yield* serverControl("stop");
    yield* serverControl("environment", 200, { EXECUTOR_E2E_PRODUCT_ENTRY: entry });
    yield* serverControl("start");
  });

/** The management app and every consumer declare the same canonical provider. */
export const acquisitionAppSource = (origin: string) => `
import { defineApp, defineProvider, interactive, secrets, object, string, query, router } from "apps";
const account = defineProvider({ name: "Reusable synthetic account", hosts: [${JSON.stringify(new URL(origin).host)}], auth: {
  paste: interactive({ label: "Sign in", acquisition: "host" }),
  manual: secrets({ label: "Manual", fields: object({ token: string() }) }),
} });
const requirements = { user: { accounts: { identity: account.many() } } };
export default defineApp(requirements, { tools: router({ ids: query({ input: object({}) }, async (ctx) =>
  ctx.user.accounts.identity.map((account) => ({ id: account.id, method: account.method, fields: account.fields }))) }) });
`;
