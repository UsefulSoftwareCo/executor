import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem } from "effect";
import {
  createExecutor,
  createRemoteExecutor,
  OwnerId,
  ToolName,
  type Executor,
  type ExecutorOptions,
} from "@executor-js/sdk";
import apps from "apps/package.json" with { type: "json" };

const me = OwnerId.make("app-user-me");

export async function vercelProjectsReport(executor: Executor) {
  const source = await Effect.runPromise(
    FileSystem.FileSystem.use((fs) =>
      fs.readFileString("playground/demo-apps/vercel/index.ts"),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
  const { app } = await executor.apps.deploy({
    owner: me,
    name: "Work Vercel",
    files: [
      { path: "index.ts", content: source },
      { path: "package.json", content: JSON.stringify({ dependencies: { apps: apps.version } }) },
    ],
  });

  if (app.requirements.accounts.vercel === undefined)
    throw new Error("This app must declare a vercel account");

  const connection = await executor.accountConnections.create({
    owner: me,
    target: { app: app.id, requirement: "vercel" },
  });
  const account = await executor.accountConnections.submit({
    connection: connection.id,
    method: "apiKey",
    label: "Work Vercel",
    fields: { token: "vercel_tok_synthetic_example_only" },
  });

  const projects = await executor.tools.call({
    app: app.id,
    accounts: { app: {}, user: { vercel: [account.id] } },
    tool: ToolName.make("listProjects"),
    kind: "query",
    input: {},
  });
  return { app, account, projects };
}

export const inProcess = async (options: ExecutorOptions) =>
  vercelProjectsReport(await createExecutor(options));

export const remote = async () =>
  vercelProjectsReport(
    await createRemoteExecutor({
      baseUrl: "https://executor.example.com",
      apiKey: "exec_sk_synthetic",
    }),
  );
