import type { SessionAuthContext } from "eve/context";
import {
  linearChannel,
  type LinearAgentSessionEvent,
} from "eve/channels/linear";

function getLinearOwnerUserId(): string {
  return process.env.OPEN_AGENTS_LINEAR_USER_ID ?? "linear-bot";
}

function openAgentsLinearAuth(event: LinearAgentSessionEvent): SessionAuthContext {
  const ownerUserId = getLinearOwnerUserId();
  const attributes: Record<string, string> = {
    linearAgentSessionId: event.agentSession.id,
  };

  if (event.agentSession.issue?.id) {
    attributes.linearIssueId = event.agentSession.issue.id;
  }
  if (event.agentSession.issue?.identifier) {
    attributes.linearIssueIdentifier = event.agentSession.issue.identifier;
  }
  if (event.agentSession.organizationId) {
    attributes.linearOrganizationId = event.agentSession.organizationId;
  }
  if (event.agentSession.creator?.id) {
    attributes.linearActorId = event.agentSession.creator.id;
  }

  return {
    attributes,
    authenticator: "open-agents-linear",
    principalId: ownerUserId,
    principalType: "user",
    subject: ownerUserId,
  };
}

export default linearChannel({
  onAgentSession: (_ctx, event) => {
    if (event.action !== "created" && event.action !== "prompted") {
      return null;
    }
    return { auth: openAgentsLinearAuth(event) };
  },
});
