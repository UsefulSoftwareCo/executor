/**
 * One trusted backend, two users, two configured copies of the same code.
 * Owner-constrained lookups implement this product's permission rule.
 * The SDK stores owners but does not enforce per-user visibility.
 * Typechecked only; no live credentials or runtime.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem } from "effect";
import { createRemoteExecutor, OwnerId, ToolName } from "@executor-js/sdk";

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
    files: [{ path: "index.ts", content: source }],
  });

  const aliceApp = await executor.apps.copy({ from: published.id, owner: alice, name: "Vercel" });
  const bobApp = await executor.apps.copy({ from: published.id, owner: bob, name: "Vercel" });
  const vercel = published.requirements.accounts.vercel;
  if (vercel === undefined) throw new Error("This app must declare a vercel account");

  const aliceAccount = await executor.accounts.add({
    provider: vercel.provider,
    method: "apiKey",
    label: "Vercel",
    owner: alice,
    fields: { token: "vercel_tok_alice_synthetic" },
  });
  const bobAccount = await executor.accounts.add({
    provider: vercel.provider,
    method: "apiKey",
    label: "Vercel",
    owner: bob,
    fields: { token: "vercel_tok_bob_synthetic" },
  });

  const aliceAccounts = await executor.accounts.list({ provider: vercel.provider, owner: alice });
  const bobAccounts = await executor.accounts.list({ provider: vercel.provider, owner: bob });

  // These owner IDs come from product auth, never end-user request fields.
  const aliceOwnedApp = await executor.apps.get({ app: aliceApp.id, owner: alice });
  const aliceOwnedAccount = await executor.accounts.get({ account: aliceAccount.id, owner: alice });
  const aliceProfile = await executor.apps.profiles.create({
    owner: alice,
    subject: "alice",
    idempotencyKey: "vercel",
    app: aliceOwnedApp.id,
    accounts: { vercel: aliceOwnedAccount.id },
  });

  const bobOwnedApp = await executor.apps.get({ app: bobApp.id, owner: bob });
  const bobOwnedAccount = await executor.accounts.get({ account: bobAccount.id, owner: bob });
  const bobProfile = await executor.apps.profiles.create({
    owner: bob,
    subject: "bob",
    idempotencyKey: "vercel",
    app: bobOwnedApp.id,
    accounts: { vercel: bobOwnedAccount.id },
  });

  const aliceProjects = await executor.tools.call({
    app: aliceOwnedApp.id,
    profile: aliceProfile.id,
    tool: ToolName.make("queries.listProjects"),
    input: {},
  });
  const bobProjects = await executor.tools.call({
    app: bobOwnedApp.id,
    profile: bobProfile.id,
    tool: ToolName.make("queries.listProjects"),
    input: {},
  });
  return { aliceAccounts, bobAccounts, aliceProjects, bobProjects };
}
