import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Layer } from "effect";
import AgentMailReceiverLive from "./src/agent-mail.ts";
import { agentMailDomain, agentMailStack, agentMailZone } from "./src/contracts/agent-mail.ts";
import {
  AgentMailReceiver,
  AgentMailbox,
  EmailRoutingSubdomain,
  EmailRoutingSubdomainProvider,
} from "./src/infrastructure/agent-mail.ts";

export default Alchemy.Stack(
  agentMailStack,
  {
    providers: EmailRoutingSubdomainProvider().pipe(Layer.provideMerge(Cloudflare.providers())),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const routing = yield* Cloudflare.Email.Routing("Routing", { zone: agentMailZone });
    yield* EmailRoutingSubdomain("AgentSubdomain", {
      zoneId: routing.zoneId,
      name: agentMailDomain,
    });
    const mailbox = yield* AgentMailbox;
    const receiver = yield* AgentMailReceiver;
    yield* Cloudflare.Email.CatchAll("CatchAll", {
      zone: routing.zoneId,
      name: "Agent mailboxes",
      actions: [{ type: "worker", value: [receiver.workerName] }],
    });
    return { namespaceId: mailbox.namespaceId, accountId: mailbox.accountId };
  }).pipe(Effect.provide(AgentMailReceiverLive)),
);
