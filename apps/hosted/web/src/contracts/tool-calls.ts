/**
 * The organization's tool call log as the Activity page reads it, and the page's address. Every
 * filter, the search text and the range live in the URL, so a refresh or a shared link opens the
 * same list; each distinct list is its own read.
 */
import { hydrated } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { AppId, type Cursor } from "@executor-js/sdk";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import {
  ToolCallId,
  ToolCallRange,
  ToolCallStatus,
  type ToolCallQuery,
} from "@executor-js/hosted-server/tool-call-log";
import { Data, Option, Schema } from "effect";
import { Atom } from "effect/reactivity";
import { HostedClient } from "./api.ts";
import { protectedQuery } from "./protected-query.ts";

/** The range a list covers when the address names none. */
export const defaultToolCallRange: ToolCallRange = "7d";

/**
 * What the Activity page lists. A filter left out is not applied; the range then covers the last
 * 7 days. `q` is search text, or a whole call reference, which lists that call alone.
 */
export type ToolCallSearch = {
  readonly q?: string | undefined;
  readonly range?: ToolCallRange | undefined;
  /** A member's user ID. */
  readonly member?: string | undefined;
  readonly app?: AppId | undefined;
  readonly status?: ToolCallStatus | undefined;
  /** The agent's grant or the API key that made the calls. */
  readonly agent?: string | undefined;
  /** The scoped connection the calls came through. */
  readonly connection?: string | undefined;
  /** The MCP session the calls arrived on. */
  readonly session?: string | undefined;
  /** The `execute` program or `call` batch that made the calls. */
  readonly run?: string | undefined;
};

const Text = Schema.NonEmptyString.check(Schema.isMaxLength(256));
const SearchText = Schema.NonEmptyString.check(Schema.isMaxLength(200));
const optional = <A>(schema: Schema.Decoder<A>, value: unknown): A | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value));

/** Read the page's address. Values the API would refuse are dropped, never replaced by defaults. */
export function parseToolCallSearch(search: Record<string, unknown>): ToolCallSearch {
  return {
    q: optional(SearchText, search.q),
    range: optional(ToolCallRange, search.range),
    member: optional(Text, search.member),
    app: optional(AppId, search.app),
    status: optional(ToolCallStatus, search.status),
    agent: optional(Text, search.agent),
    connection: optional(Text, search.connection),
    session: optional(Text, search.session),
    run: optional(Text, search.run),
  };
}

/** The search text names one call: the API lists it alone, whatever the filters and range say. */
export const searchedReference = (search: ToolCallSearch): ToolCallId | undefined =>
  optional(ToolCallId, search.q?.trim());

/** What the list can be narrowed by, besides its search text and time range. */
const filterNames = ["member", "app", "status", "agent", "connection", "session", "run"] as const;
export type FilterName = (typeof filterNames)[number];
export const noFilters: Pick<ToolCallSearch, FilterName> = {
  member: undefined,
  app: undefined,
  status: undefined,
  agent: undefined,
  connection: undefined,
  session: undefined,
  run: undefined,
};
/** The filters the address sets. */
export const activeFilters = (search: ToolCallSearch) =>
  filterNames.filter((name) => search[name] !== undefined);
/** How many filters narrow the list, for the Filter button. A reference ignores them all. */
export const appliedFilterCount = (search: ToolCallSearch) =>
  searchedReference(search) === undefined ? activeFilters(search).length : 0;

/** One page of one list. Equal keys share a read, so a page opened again reuses its value. */
export class ToolCallPageKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly range: ToolCallRange;
  readonly member: string | undefined;
  readonly app: AppId | undefined;
  readonly status: ToolCallStatus | undefined;
  readonly agent: string | undefined;
  readonly connection: string | undefined;
  readonly session: string | undefined;
  readonly run: string | undefined;
  readonly search: string | undefined;
  readonly cursor: Cursor | undefined;
  readonly limit: number | undefined;
}> {}

/** Search text as the API matches it; blank text searches nothing. */
const trimmed = (text: string | undefined) => {
  const value = text?.trim();
  return value === "" ? undefined : value;
};

/** The key of a list's page: its first page without `cursor`. */
export const toolCallPageKey = (
  organization: OrganizationReference,
  search: ToolCallSearch,
  page: { readonly cursor?: Cursor | undefined; readonly limit?: number | undefined } = {},
) =>
  new ToolCallPageKey({
    organization,
    range: search.range ?? defaultToolCallRange,
    member: search.member,
    app: search.app,
    status: search.status,
    agent: search.agent,
    connection: search.connection,
    session: search.session,
    run: search.run,
    search: trimmed(search.q),
    cursor: page.cursor,
    limit: page.limit,
  });

/** One page of calls, newest first, with its list's total. */
export const toolCallPageAtom = Atom.family(({ organization, ...key }: ToolCallPageKey) => {
  const query: ToolCallQuery = {
    range: key.range,
    member: key.member,
    app: key.app,
    status: key.status,
    agent: key.agent,
    connection: key.connection,
    session: key.session,
    run: key.run,
    search: key.search,
    cursor: key.cursor,
    limit: key.limit,
  };
  return HostedClient.query(
    "toolCalls",
    "list",
    hydrated({ params: { organization }, query }),
  ).pipe(revalidated, protectedQuery);
});

/**
 * Whether the organization has any call this viewer may see: the newest of the last 30 days, which
 * is as long as calls are kept. Read only when an unfiltered list is empty.
 */
export const anyToolCallAtom = (organization: OrganizationReference) =>
  toolCallPageAtom(toolCallPageKey(organization, { range: "30d" }, { limit: 1 }));

export class ToolCallFiltersKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly range: ToolCallRange;
}> {}
/** The members, apps, agents and connections the Filter menu offers for a range. */
export const toolCallFiltersAtom = Atom.family(({ organization, range }: ToolCallFiltersKey) =>
  HostedClient.query(
    "toolCalls",
    "filters",
    hydrated({ params: { organization }, query: { range } }),
  ).pipe(revalidated, protectedQuery),
);
