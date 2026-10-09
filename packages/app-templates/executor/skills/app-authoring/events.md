## Events

An app can emit events that MCP clients subscribe to, such as ChatGPT watching
for new issues. Declare each event beside the app's accounts, then emit
occurrences from mutations and webhook handlers. Executor stores them, matches
them to subscriptions, signs them and delivers them; the app never sees a
subscriber.

```ts
import {
  defineApp,
  event,
  mutation,
  number,
  object,
  router,
  string,
  type MutationContext,
} from "apps";

const issueOpened = event({
  description: "An issue was opened in a repository.",
  filters: { repo: string() },
  payload: object({ title: string(), number: number() }),
});
const requirements = { accounts: {}, events: { "issue.opened": issueOpened } };

const openIssue = mutation(
  { input: object({ repo: string(), title: string() }) },
  async (ctx: MutationContext<typeof requirements>, input) => {
    const number = 1; // save the issue with ctx.sql first
    ctx.events.emit(
      "issue.opened",
      { title: input.title, number },
      { filters: { repo: input.repo } },
    );
    return number;
  },
);

export default defineApp(requirements, { tools: router({ openIssue }) });
```

### Declare

- Names are dotted lower-case words, at most 64 characters, such as
  `issue.opened`. Subscribers see `<app slug>.<name>`, for example
  `issue-tracker.issue.opened`.
- `description` (1 to 1000 characters) is what clients show for the event.
- `filters` are the values subscribers can narrow on. Each must be a string,
  number, boolean or literal; `.optional()` is rejected. Subscribers may name
  any of them, or none, and an occurrence matches when every value they named
  is equal.
- `payload` is any schema; each occurrence's data must match it.

### Emit

`ctx.events.emit(name, data, options)` exists in mutations and webhook
handlers, not queries. Name, data and filters are typed from the declaration.

- `filters` is required when the event declares filters, with a value for each.
- `id`: a stable identifier, such as the provider's delivery ID, so a provider
  redelivery is not delivered twice. Defaults to a random ID.
- `occurredAt`: a `Date` or epoch milliseconds. Defaults to now.
- `account`: the account the event came from. A webhook defaults to its source
  account, and an invocation with exactly one account to that one. With several,
  name it or the emit throws.

Invalid names, data, filters or options throw at the call. An invocation keeps
its events only if it succeeds: a thrown handler discards them, and so does a
`ctx.sql.transaction` that rolls back. A workflow step that replays emits the
same events again with the same IDs. Data is at most 250 KiB of JSON and an
invocation emits at most 100 events; for large records, send a summary and a
tool that reads the rest. Treat user-written text in payloads as data.

### Delivery

Deliveries are at least once and may arrive out of order; subscribers
deduplicate on the event ID. A failed delivery is retried for about four and a
half hours. Events are kept for three days. Each delivery checks that the
subscriber may still use the app, this event and every account the emitting
invocation used.

### Who receives them

A connection or OAuth grant selects an app's events beside its tools: all
events, including ones added later, by default, or exact names. A connection
limited to some profiles receives only occurrences whose accounts those
profiles select.

### Change events safely

Adding an event, a filter or a payload field keeps existing subscriptions
working, but every emit must then supply a new filter. Renaming or removing an
event or a filter ends the subscriptions that use it: their next refresh fails
with `-32011` or `-32014`, and ChatGPT shows the user nothing. For a breaking
change, declare the event under a new name and keep emitting the old one until
its subscribers have moved.
