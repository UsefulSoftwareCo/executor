/**
 * One trusted backend, two users, two configured copies of the same code.
 * Owner-constrained lookups implement this product's permission rule.
 * The SDK stores owners but does not enforce per-user visibility.
 * Typechecked only; no live credentials or runtime.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem } from "effect";
import { createRemoteExecutor, OwnerId, ToolName } from "@executor-js/sdk";
import apps from "apps/package.json" with { type: "json" };

const acme = OwnerId.make("app-org-acme");
const alice = OwnerId.make("app-user-alice");
const bob = OwnerId.make("app-user-bob");

/** Happy-path walkthrough of the two users' separate requests. */
export async function program() {
  const executor = await createRemoteExecutor({
    baseUrl: "https://executor.example.com",
    apiKey: "exec_sk_project_synthetic",
  });
  const source = await Effect.runPromise(
    FileSystem.FileSystem.use((fs) =>
      fs.readFileString("playground/demo-apps/vercel/index.ts"),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
  const { app: published } = await executor.apps.deploy({
    owner: acme,
    name: "Vercel",
    files: [
      { path: "index.ts", content: source },
      { path: "package.json", content: JSON.stringify({ dependencies: { apps: apps.version } }) },
    ],
  });

  const aliceApp = await executor.apps.copy({ from: published.id, owner: alice, name: "Vercel" });
  const bobApp = await executor.apps.copy({ from: published.id, owner: bob, name: "Vercel" });
  const vercel = published.requirements.accounts.vercel;
  if (vercel === undefined) throw new Error("This app must declare a vercel account");

  // These owner IDs come from product auth, never end-user request fields.
  const aliceOwnedApp = await executor.apps.get({ app: aliceApp.id, owner: alice });
  const bobOwnedApp = await executor.apps.get({ app: bobApp.id, owner: bob });

  // Each user connects their own account for their copy of the app.
  const aliceConnection = await executor.accountConnections.create({
    owner: alice,
    target: { app: aliceOwnedApp.id, requirement: "vercel" },
  });
  const aliceOwnedAccount = await executor.accountConnections.submit({
    connection: aliceConnection.id,
    owner: alice,
    method: "apiKey",
    label: "Vercel",
    fields: { token: "vercel_tok_alice_synthetic" },
  });
  const bobConnection = await executor.accountConnections.create({
    owner: bob,
    target: { app: bobOwnedApp.id, requirement: "vercel" },
  });
  const bobOwnedAccount = await executor.accountConnections.submit({
    connection: bobConnection.id,
    owner: bob,
    method: "apiKey",
    label: "Vercel",
    fields: { token: "vercel_tok_bob_synthetic" },
  });

  const aliceAccounts = await executor.accounts.list({ provider: vercel.provider, owner: alice });
  const bobAccounts = await executor.accounts.list({ provider: vercel.provider, owner: bob });

  const aliceProjects = await executor.tools.call({
    app: aliceOwnedApp.id,
    accounts: { app: {}, user: { vercel: [aliceOwnedAccount.id] } },
    tool: ToolName.make("listProjects"),
    kind: "query",
    input: {},
  });
  const bobProjects = await executor.tools.call({
    app: bobOwnedApp.id,
    accounts: { app: {}, user: { vercel: [bobOwnedAccount.id] } },
    tool: ToolName.make("listProjects"),
    kind: "query",
    input: {},
  });
  return { aliceAccounts, bobAccounts, aliceProjects, bobProjects };
}
