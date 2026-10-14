/** Choosing existing accounts never copies their credentials or transfers ownership. */
import {
  ToolName,
  type AccountId,
  type AppId,
  type Executor,
  type OwnerId,
} from "@executor-js/sdk";

/** List reusable accounts whose provider definition matches an app requirement. */
export async function listAxiomAccounts(executor: Executor, appId: AppId, owner: OwnerId) {
  const app = await executor.apps.get({ app: appId });
  const axiom = app.requirements.accounts.axiom;
  if (axiom === undefined) throw new Error("This app must declare an axiom account");
  return executor.accounts.list({ owner, provider: axiom.provider });
}

/** After product authorization, two apps can run with the exact same saved account. */
export async function reuseAxiomAccount(
  executor: Executor,
  first: AppId,
  second: AppId,
  selectedAccount: AccountId,
) {
  // Each app's tools are discovered live from Axiom with that account.
  const tools = (app: AppId) =>
    executor.tools.list({ app, accounts: { app: {}, user: { axiom: [selectedAccount] } } });
  return { first: await tools(first), second: await tools(second) };
}

/** One call to the Mail app runs with several accounts for its gmail.many() requirement. */
export async function listInboxes(
  executor: Executor,
  mail: AppId,
  work: AccountId,
  personal: AccountId,
) {
  return executor.tools.call({
    app: mail,
    accounts: { app: {}, user: { mailboxes: [work, personal] } },
    tool: ToolName.make("listInbox"),
    kind: "query",
    input: {},
  });
}
