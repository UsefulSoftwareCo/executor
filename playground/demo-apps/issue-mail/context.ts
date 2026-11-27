import { event, number, object, string, type QueryContext, type WebhookContext } from "apps";
import { github, gmail } from "./providers.ts";

const issueOpened = event({
  description:
    "An issue was opened in a watched repository, with the number of emails that link to it.",
  filters: { repository: string() },
  payload: object({ number: number(), url: string(), matchingMessages: number() }),
});

export const requirements = {
  user: { accounts: { github, gmail } },
  events: { "issue.opened": issueOpened },
};
export type QueryCtx = QueryContext<typeof requirements>;
export type WebhookCtx = WebhookContext<typeof requirements>;
