/** Two configured Axiom apps, with separate OAuth accounts and the same code. */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem } from "effect";
import { type AccountConnectionId, type Executor, type OwnerId } from "@executor-js/sdk";

/** Create the two apps and begin their independent OAuth sign-ins. */
export async function startAxiomSignIns(executor: Executor, owner: OwnerId) {
  const source = await Effect.runPromise(
    FileSystem.FileSystem.use((fs) =>
      fs.readFileString("playground/demo-apps/axiom/index.ts"),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
  const { app: work } = await executor.apps.deploy({
    owner,
    name: "Work Axiom",
    files: [{ path: "index.ts", content: source }],
  });
  const personal = await executor.apps.copy({ from: work.id, owner, name: "Personal Axiom" });
  const workProfile = await executor.apps.profiles.create({
    app: work.id,
    owner,
    subject: "me",
    idempotencyKey: "work",
    accounts: {},
  });
  const personalProfile = await executor.apps.profiles.create({
    app: personal.id,
    owner,
    subject: "me",
    idempotencyKey: "personal",
    accounts: {},
  });
  const workConnection = await executor.accountConnections.create({
    owner,
    target: { app: work.id, profile: workProfile.id, requirement: "axiom" },
  });
  const workSignIn = await executor.accountConnections.startOAuth({
    connection: workConnection.id,
    method: "oauth",
    label: "Work Axiom",
    redirectUri: "https://my-product.example/oauth/callback",
  });
  const personalConnection = await executor.accountConnections.create({
    owner,
    target: { app: personal.id, profile: personalProfile.id, requirement: "axiom" },
  });
  const personalSignIn = await executor.accountConnections.startOAuth({
    connection: personalConnection.id,
    method: "oauth",
    label: "Personal Axiom",
    redirectUri: "https://my-product.example/oauth/callback",
  });
  // The product opens each authorizationUrl and retains the connection ID.
  return { work, personal, workConnection, personalConnection, workSignIn, personalSignIn };
}

/**
 * The product authorizes the target when creating the request. The callback
 * validates state/PKCE and saves the account and its app selection together.
 */
export async function finishAxiomSignIn(
  executor: Executor,
  connection: AccountConnectionId,
  callbackUrl: string,
) {
  return executor.accountConnections.completeOAuth({ connection, callbackUrl });
}
