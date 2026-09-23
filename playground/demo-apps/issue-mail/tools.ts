import { array, decodeJson, object, string, query as defineQuery } from "apps";
import type { QueryCtx, WebhookCtx } from "./context.ts";

const FindMailInput = object({ query: string() });
const MessagePage = object({
  messages: array(
    object({
      id: string(),
      threadId: string(),
    }),
  ).optional(),
});

/** Find the first page of message references in the selected Gmail account. */
export const searchMail = async (
  { accounts, fetch }: Pick<WebhookCtx, "accounts" | "fetch">,
  { query }: { readonly query: string },
) => {
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  url.searchParams.set("q", query);
  url.searchParams.set("maxResults", "20");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accounts.gmail.fields.access_token}` },
  });
  const page = await decodeJson(response, MessagePage);
  return page.messages ?? [];
};
/** Standalone query receives current account bindings when invoked. */
export const findMail = defineQuery(
  { description: "Find up to 20 messages in the selected Gmail account.", input: FindMailInput },
  (context: QueryCtx, input) => searchMail(context, input),
);
