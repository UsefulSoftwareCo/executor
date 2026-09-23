/** Promise SDK example using caller-provided storage, credentials and runtime. */
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

const me = OwnerId.make("app-user-me");

/** Deploy one configured app, create an account, select it, and call the tool. */
export async function vercelProjectsReport(executor: Executor) {
  const source = await Effect.runPromise(
    FileSystem.FileSystem.use((fs) =>
      fs.readFileString("playground/demo-apps/vercel/index.ts"),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
  const { app } = await executor.apps.deploy({
    owner: me,
    name: "Work Vercel",
    files: [{ path: "index.ts", content: source }],
  });

  // Runtime metadata has dynamic slot names; check the expected slot exists.
  const vercel = app.requirements.accounts.vercel;
  if (vercel === undefined) throw new Error("This app must declare a vercel account");

  const account = await executor.accounts.add({
    owner: me,
    provider: vercel.provider,
    method: "apiKey",
    label: "Work Vercel",
    fields: { token: "vercel_tok_synthetic_example_only" },
  });

  const profile = await executor.apps.profiles.create({
    owner: me,
    subject: "me",
    idempotencyKey: "work",
    app: app.id,
    accounts: { vercel: account.id },
  });

  const projects = await executor.tools.call({
    app: app.id,
    profile: profile.id,
    tool: ToolName.make("queries.listProjects"),
    input: {},
  });
  return { app, profile, account, projects };
}

/** Local/remote parity; neither function starts work until called. */
export const inProcess = async (options: ExecutorOptions) =>
  vercelProjectsReport(await createExecutor(options));

/** The remote client exposes exactly the same operations. */
export const remote = async () =>
  vercelProjectsReport(
    await createRemoteExecutor({
      baseUrl: "https://executor.example.com",
      apiKey: "exec_sk_synthetic",
    }),
  );
