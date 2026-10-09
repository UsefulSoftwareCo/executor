import { event, number, object, string, type QueryContext, type WebhookContext } from "apps";
import { github, gmail } from "./providers.ts";

/** An opened issue and how many emails mention it. Subscribers may filter by repository. */
const issueOpened = event({
  description:
    "An issue was opened in a watched repository, with the number of emails that link to it.",
  filters: { repository: string() },
  payload: object({ number: number(), url: string(), matchingMessages: number() }),
});

/** Shared requirements contain declarations, never selected credentials. */
export const requirements = {
  accounts: { github, gmail },
  events: { "issue.opened": issueOpened },
};
/** The same account shape with interactive query capabilities. */
export type QueryCtx = QueryContext<typeof requirements>;
/** Webhook handlers cannot request interactive input. */
export type WebhookCtx = WebhookContext<typeof requirements>;
