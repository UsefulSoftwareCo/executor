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

export const defaultToolCallRange: ToolCallRange = "7d";

export type ToolCallSearch = {
  readonly q?: string | undefined;
  readonly range?: ToolCallRange | undefined;
  readonly member?: string | undefined;
  readonly app?: AppId | undefined;
  readonly status?: ToolCallStatus | undefined;
  readonly agent?: string | undefined;
  readonly connection?: string | undefined;
  readonly session?: string | undefined;
  readonly run?: string | undefined;
};

const Text = Schema.NonEmptyString.check(Schema.isMaxLength(256));
const SearchText = Schema.NonEmptyString.check(Schema.isMaxLength(200));
const optional = <A>(schema: Schema.Decoder<A>, value: unknown): A | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value));

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

export const searchedReference = (search: ToolCallSearch): ToolCallId | undefined =>
  optional(ToolCallId, search.q?.trim());

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
export const activeFilters = (search: ToolCallSearch) =>
  filterNames.filter((name) => search[name] !== undefined);
export const appliedFilterCount = (search: ToolCallSearch) =>
  searchedReference(search) === undefined ? activeFilters(search).length : 0;

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

const trimmed = (text: string | undefined) => {
  const value = text?.trim();
  return value === "" ? undefined : value;
};

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

export const anyToolCallAtom = (organization: OrganizationReference) =>
  toolCallPageAtom(toolCallPageKey(organization, { range: "30d" }, { limit: 1 }));

export class ToolCallFiltersKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly range: ToolCallRange;
}> {}
export const toolCallFiltersAtom = Atom.family(({ organization, range }: ToolCallFiltersKey) =>
  HostedClient.query(
    "toolCalls",
    "filters",
    hydrated({ params: { organization }, query: { range } }),
  ).pipe(revalidated, protectedQuery),
);
