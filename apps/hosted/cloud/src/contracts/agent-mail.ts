/** Inbound mail for synthetic agent identities. Only local tooling with Cloudflare access reads it. */
import { Schema } from "effect";

/** The Alchemy stack and its single shared stage. */
export const agentMailStack = "executor-agent-mail";
export const agentMailStage = "shared";

/** The zone hosting Email Routing, and the subdomain whose every address is an agent inbox. */
export const agentMailZone = "executor.engineering";
export const agentMailDomain = `agents.${agentMailZone}`;

/** Messages expire from storage after a day; sign-in codes expire after five minutes anyway. */
export const agentMailRetentionSeconds = 24 * 60 * 60;

/** Local parts are lowercase so each address maps to exactly one storage prefix. */
export const AgentMailLocalPart = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9.-]{0,62}$/u),
);

/** Keys sort by arrival within one recipient: `<address>/<received ISO time>/<id>`. */
export const agentMailPrefix = (address: string) => `${address.toLowerCase()}/`;

export const AgentMailMessage = Schema.Struct({
  to: Schema.String,
  from: Schema.String,
  subject: Schema.String,
  text: Schema.String,
  html: Schema.String,
  receivedAt: Schema.String,
});
export type AgentMailMessage = typeof AgentMailMessage.Type;
