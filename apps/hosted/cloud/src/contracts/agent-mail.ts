import { Schema } from "effect";

export const agentMailStack = "executor-agent-mail";
export const agentMailStage = "shared";

export const agentMailZone = "executor.engineering";
export const agentMailDomain = `agents.${agentMailZone}`;

export const agentMailRetentionSeconds = 24 * 60 * 60;

export const AgentMailLocalPart = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9.-]{0,62}$/u),
);

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
