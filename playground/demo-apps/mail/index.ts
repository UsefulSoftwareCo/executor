/**
 * One Mail app with any number of saved Gmail selections. Executor configures
 * the mailbox IDs on the app; no sign-in UI lives here.
 * The host and OAuth flow remain unimplemented. Credentials stay server-side.
 */
import {
  query,
  type AccountOf,
  array,
  decodeJson,
  defineApp,
  defineProvider,
  oauth2,
  object,
  string,
} from "apps";

/** Gmail OAuth declaration; the host supplies its approved client configuration. */
export const gmail = defineProvider({
  name: "Gmail",
  auth: {
    oauth: oauth2({
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    }),
  },
});

// Gmail's list endpoint returns references. Message content needs messages.get.
const MessagePage = object({
  messages: array(
    object({
      id: string(),
      threadId: string(),
    }),
  ).optional(),
  nextPageToken: string().optional(),
});

const ListMessagesInput = object({
  accountId: string({ minLength: 1 }),
  pageToken: string().optional(),
});

class MailboxNotSelected extends Error {
  readonly _tag = "MailboxNotSelected";

  constructor() {
    super("Choose a mailbox selected in Executor's account picker.");
    this.name = "MailboxNotSelected";
  }
}

// An ordinary app helper, called only when a tool runs. `me` is the account
// authenticated by this token; Gmail does not receive the Executor account ID.
async function listGmailMessages(account: AccountOf<typeof gmail>, pageToken?: string) {
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  url.searchParams.set("labelIds", "INBOX");
  url.searchParams.set("maxResults", "20");
  if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${account.fields.access_token}` },
  });
  const page = await decodeJson(response, MessagePage);

  return {
    accountId: account.id,
    ...page,
    // Gmail may omit messages when there are no results.
    messages: page.messages ?? [],
  };
}

const accounts = { mailboxes: gmail.many() };

export default defineApp(
  { accounts },
  {
    queries: {
      listMessages: query(
        {
          description:
            "List message references in one selected inbox. Pass its nextPageToken to continue.",
          input: ListMessagesInput,
        },
        async ({ accounts }, { accountId, pageToken }) => {
          const account = accounts.mailboxes.find((mailbox) => mailbox.id === accountId);
          if (!account) throw new MailboxNotSelected();
          return listGmailMessages(account, pageToken);
        },
      ),
      listInbox: query(
        {
          description:
            "List the first page of message references from every selected inbox, grouped by account.",
          input: object({}),
        },
        async ({ accounts }) => {
          const inboxes: Array<Awaited<ReturnType<typeof listGmailMessages>>> = [];
          // Account count is user-selected; avoid unbounded request fan-out.
          for (const account of accounts.mailboxes) {
            inboxes.push(await listGmailMessages(account));
          }
          return inboxes;
        },
      ),
    },
  },
);
