/** Two configured Axiom apps, with separate OAuth accounts and the same code. */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem } from "effect";
import { type AccountConnectionId, type Executor, type OwnerId } from "@executor-js/sdk";
import apps from "apps/package.json" with { type: "json" };

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
    files: [
      { path: "index.ts", content: source },
      { path: "package.json", content: JSON.stringify({ dependencies: { apps: apps.version } }) },
    ],
  });
  const personal = await executor.apps.copy({ from: work.id, owner, name: "Personal Axiom" });
  const workConnection = await executor.accountConnections.create({
    owner,
    target: { app: work.id, requirement: "axiom" },
  });
  const workSignIn = await executor.accountConnections.startOAuth({
    connection: workConnection.id,
    method: "oauth",
    label: "Work Axiom",
    redirectUri: "https://my-product.example/oauth/callback",
  });
  const personalConnection = await executor.accountConnections.create({
    owner,
    target: { app: personal.id, requirement: "axiom" },
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
 * validates state/PKCE and saves the account; the product links it to the app in the same
 * transaction.
 */
export async function finishAxiomSignIn(
  executor: Executor,
  connection: AccountConnectionId,
  callbackUrl: string,
) {
  return executor.accountConnections.completeOAuth({ connection, callbackUrl });
}
