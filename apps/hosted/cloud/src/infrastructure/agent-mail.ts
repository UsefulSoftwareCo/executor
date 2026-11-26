import { Resource } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Provider from "alchemy/Provider";
import * as emailRouting from "@distilled.cloud/cloudflare/email-routing";
import { Effect } from "effect";

export const AgentMailbox = Cloudflare.KV.Namespace("AgentMailbox", {
  title: "executor-agent-mailbox",
});

export class AgentMailReceiver extends Cloudflare.Worker<AgentMailReceiver, {}>()(
  "AgentMailReceiver",
) {}

export type EmailRoutingSubdomain = Resource<
  "Executor.EmailRoutingSubdomain",
  { readonly zoneId: string; readonly name: string },
  { readonly zoneId: string; readonly name: string }
>;
export const EmailRoutingSubdomain = Resource<EmailRoutingSubdomain>(
  "Executor.EmailRoutingSubdomain",
);

export const EmailRoutingSubdomainProvider = () =>
  Provider.succeed(EmailRoutingSubdomain, {
    stables: ["zoneId", "name"],
    read: ({ output }) => Effect.succeed(output),
    reconcile: ({ news }) =>
      emailRouting
        .createDns({ zoneId: news.zoneId, name: news.name })
        .pipe(Effect.as({ zoneId: news.zoneId, name: news.name })),
    delete: ({ output }) => emailRouting.deleteDns({ zoneId: output.zoneId }).pipe(Effect.asVoid),
  });
