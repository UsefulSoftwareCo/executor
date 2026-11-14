import { Suspense, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Equal, Option } from "effect";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  BoxesIcon,
  Calendar03Icon,
  Cancel01Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  ComputerIcon,
  ConnectIcon,
  FlowIcon,
  HourglassOffIcon,
  Key01Icon,
  RobotIcon,
  UnavailableIcon,
  UserIcon,
  WebhookIcon,
} from "@hugeicons/core-free-icons";
import type { App, Cursor } from "@executor-js/sdk";
import type {
  ToolCall,
  ToolCallFilters,
  ToolCallPage,
  ToolCallRange,
  ToolCallSource,
  ToolCallStatus,
} from "@executor-js/hosted-server/tool-call-log";
import { Avatar, AvatarFallback } from "@executor-js/ui/components/avatar";
import { Button } from "@executor-js/ui/components/button";
import { LocalTime, shortMoment } from "@executor-js/ui/components/local-time";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@executor-js/ui/components/dropdown-menu";
import { Skeleton } from "@executor-js/ui/components/skeleton";
import { CopyButton } from "@executor-js/ui/dashboard/code";
import { AgentIcon } from "@executor-js/ui/dashboard/agent-icon";
import { AppIcon, SearchInput } from "@executor-js/ui/dashboard/common";
import { usePreload } from "@executor-js/ui/dashboard/context";
import { EmptyState } from "@executor-js/ui/dashboard/empty-state";
import { productTitle, useDocumentTitle } from "@executor-js/ui/hooks/document-title";
import { useMediaQuery } from "@executor-js/ui/hooks/media-query";
import {
  activeFilters,
  anyToolCallAtom,
  appliedFilterCount,
  defaultToolCallRange,
  type FilterName,
  noFilters,
  searchedReference,
  toolCallFiltersAtom,
  ToolCallFiltersKey,
  toolCallPageAtom,
  toolCallPageKey,
  parseToolCallSearch,
  type ToolCallPageKey,
  type ToolCallSearch,
} from "../../contracts/tool-calls.ts";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import { MemberAvatar } from "../components/member-avatar.tsx";
import { type OrganizationPageReads, useOrganizationRoute } from "../components/organization.tsx";
import {
  ActivityFilterButton,
  ActivityFrame,
  ActivityListPending,
  activitySearchPlaceholder,
  activityTitle,
} from "../components/page-pending.tsx";

/** The list the address names and the Filter menu's choices for its range, read together. */
export const activityPageReads: OrganizationPageReads = (organization, _params, search = {}) => {
  const parsed = parseToolCallSearch(search);
  return [
    toolCallPageAtom(toolCallPageKey(organization, parsed)),
    toolCallFiltersAtom(
      new ToolCallFiltersKey({ organization, range: parsed.range ?? defaultToolCallRange }),
    ),
  ];
};

/** A change to the address. Typing replaces the history entry; every other change adds one. */
export type ActivitySearchChange = (
  next: Partial<ToolCallSearch>,
  options?: { readonly replace?: boolean },
) => void;

/**
 * The organization's tool call log: who called which tool and how each call ended. Owners and
 * admins see every call; members see their own. The search, filters and range are the address's.
 */
export function ActivityPage({
  search,
  onSearchChange,
}: {
  readonly search: ToolCallSearch;
  readonly onSearchChange: ActivitySearchChange;
}) {
  const { organization } = useOrganizationRoute();
  usePreload(...activityPageReads(organization, {}, search));
  useDocumentTitle(productTitle(activityTitle));
  return (
    <ActivityFrame>
      <ToolCalls key={organization} search={search} onChange={onSearchChange} />
    </ActivityFrame>
  );
}

const all = "*all";
type Icon = typeof Clock01Icon;

const ranges: ReadonlyArray<readonly [ToolCallRange, string]> = [
  ["24h", "Last 24 hours"],
  ["7d", "Last 7 days"],
  ["30d", "Last 30 days"],
];
const rangeLabel = (range: ToolCallRange) =>
  ranges.find(([each]) => each === range)?.[1] ?? "Last 7 days";

const sourceIcons: Record<ToolCallSource, Icon> = {
  agent: RobotIcon,
  "api-key": Key01Icon,
  dashboard: ComputerIcon,
  schedule: Calendar03Icon,
  webhook: WebhookIcon,
  workflow: FlowIcon,
};
const sourceKinds: Record<ToolCallSource, string> = {
  agent: "Agent",
  "api-key": "API key",
  dashboard: "Dashboard",
  schedule: "Schedule",
  webhook: "Webhook",
  workflow: "Workflow",
};
/** What made a call, by name when it has one. */
const sourceName = (source: ToolCall["source"]) => source.name ?? sourceKinds[source.kind];

/** What made a call: an agent's own mark, or the kind of source. `className` sizes it. */
function SourceMark({
  source,
  className,
}: {
  readonly source: Pick<ToolCall["source"], "kind" | "name" | "icon">;
  readonly className: string;
}) {
  return source.kind === "agent" ? (
    <AgentIcon name={source.name} icon={source.icon} className={className} />
  ) : (
    <HugeiconsIcon
      icon={sourceIcons[source.kind]}
      strokeWidth={2}
      className={className}
      aria-hidden
    />
  );
}

const pills = {
  good: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  bad: "bg-destructive/10 text-destructive",
  warn: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  muted: "bg-muted text-muted-foreground",
};
const statuses: Record<
  ToolCallStatus,
  { readonly label: string; readonly tone: string; readonly icon: Icon; readonly ink: string }
> = {
  succeeded: {
    label: "Succeeded",
    tone: pills.good,
    icon: CheckmarkCircle02Icon,
    ink: "text-emerald-600 dark:text-emerald-400",
  },
  failed: { label: "Failed", tone: pills.bad, icon: CancelCircleIcon, ink: "text-destructive" },
  "awaiting-approval": {
    label: "Needs approval",
    tone: pills.warn,
    icon: Clock01Icon,
    ink: "text-amber-600 dark:text-amber-400",
  },
  denied: {
    label: "Denied",
    tone: pills.muted,
    icon: UnavailableIcon,
    ink: "text-muted-foreground",
  },
  expired: {
    label: "Expired",
    tone: pills.muted,
    icon: HourglassOffIcon,
    ink: "text-muted-foreground",
  },
};
const statusOrder: readonly ToolCallStatus[] = [
  "succeeded",
  "failed",
  "awaiting-approval",
  "denied",
  "expired",
];

type Person = NonNullable<ToolCall["member"]>;
const personName = (person: Person) => person.name ?? person.email ?? "Unknown member";

/** The app's name, which a member is not told for an app they can no longer use. */
const appName = (call: ToolCall) => call.app.name ?? "An app you can no longer use";
/** The tool's name, which the log does not keep when the app has no such tool. */
const toolName = (call: ToolCall) => call.tool ?? "A tool the app does not have";
/** Someone else's account is named to nobody but its owner. */
const accountName = (account: ToolCall["accounts"][number]) => account.name ?? "Personal account";

/**
 * Why a call did not succeed, in Executor's words, built from what the log records: Executor's
 * name for the failure, the service's status and the app's name. Never the failure's own text,
 * which the log does not keep.
 */
export const failureReason = (call: ToolCall): string | undefined => {
  if (call.errorType === null) return undefined;
  const app = call.app.name ?? "The app";
  const code = call.statusCode;
  switch (call.errorType) {
    case "AppProviderFailed":
      return code === null ? `${app} could not complete the request.` : `${app} returned ${code}.`;
    case "ToolCallFailed":
      return code === null ? "The tool reported an error." : `${app} returned ${code}.`;
    case "McpToolError":
      return "The tool returned an error result.";
    case "OAuthReconnectRequired":
      return "The account must be reconnected.";
    case "OAuthRenewalFailed":
      return `Executor could not renew the account's sign-in with ${app}.`;
    case "AccountRequired":
      return "No account is linked to the app for this call.";
    case "AccountNotFound":
      return "An account the call needed no longer exists.";
    case "AccountSelectionInvalid":
      return "The linked accounts do not match what the app requires.";
    case "AccountChoiceUnsupported":
      return "The caller chose accounts for the call, which calls cannot do.";
    case "AppNotFound":
      return "The app does not exist, or the caller may not use it.";
    case "AppNotDeployed":
      return "The app has no deployed version.";
    case "VersionNotFound":
      return "The app's version is no longer available.";
    case "AppEvaluationFailed":
      return "The app failed to load before the tool ran.";
    case "ToolListingTimedOut":
      return "The app took too long to list its tools.";
    case "ToolNotFound":
      return "The app has no tool with this name.";
    case "ToolKindMismatch":
      return "The tool was called as a query when it writes, or the reverse.";
    case "InputInvalid":
      return "The input did not match the tool's schema.";
    case "ToolElicitationFailed":
      return "The tool asked for more input and did not get it.";
    case "ToolBlocked":
      return "The app's approval policy blocked the call.";
    case "ToolApprovalRequired":
      return "The tool needs approval, and the caller could not ask for it.";
    case "ToolPolicyFailed":
      return "The tool's approval policy failed before deciding.";
    case "ApprovalUnavailable":
      return "The app or its accounts changed after the call was reviewed, so it did not run.";
    case "StorageError":
      return "Executor could not read or write its saved data.";
    case "CredentialsError":
      return "Executor could not read the account's saved credentials.";
    case "OrganizationForbidden":
    case "Forbidden":
    case "AppAccessDenied":
      return "The caller was not allowed to use this app.";
    case "RequestInvalid":
      return "Executor could not read the request.";
    case "Interrupted":
      return "The call stopped before it finished.";
    case "Defect":
      return "Executor failed unexpectedly. Quote the reference when you report it.";
    default:
      return "The call failed.";
  }
};

const counted = (count: number, noun: string) =>
  `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
const duration = (ms: number | null) =>
  ms === null ? "–" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
const exactMoment: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "long" };

const typingDelayMs = 250;

/**
 * The search box's text. Typing stays local so the field never waits on the address, which follows
 * it after a pause; a change to the address that this field did not write, such as Back, replaces it.
 */
function useSearchText(q: string | undefined, write: (q: string | undefined) => void) {
  const [text, setText] = useState(q ?? "");
  const written = useRef(q);
  const writeLatest = useEffectEvent(write);
  useEffect(() => {
    if (q === written.current) return;
    written.current = q;
    // oxlint-disable-next-line react/set-state-in-effect -- an address change this field did not make replaces its text
    setText(q ?? "");
  }, [q]);
  useEffect(() => {
    const next = text === "" ? undefined : text;
    if (next === written.current) return;
    const timer = setTimeout(() => {
      written.current = next;
      writeLatest(next);
    }, typingDelayMs);
    return () => clearTimeout(timer);
  }, [text]);
  /** Set text and address together, as a choice made from a record does. */
  const replace = (next: string | undefined) => {
    written.current = next;
    setText(next ?? "");
  };
  return { text, setText, replace };
}

function ToolCalls({
  search,
  onChange,
}: {
  readonly search: ToolCallSearch;
  readonly onChange: ActivitySearchChange;
}) {
  const field = useSearchText(search.q, (q) => onChange({ q }, { replace: true }));
  const reference = searchedReference(search);
  const toolbar = useRef<HTMLDivElement>(null);
  /**
   * Narrow to one record's agent, session or run; a reference in the search would override it. The
   * filters a reference ignored did not choose that record, so they go with it. The record may be
   * far down the list, so the toolbar and its new chip come back into view.
   */
  const narrow = (next: Partial<ToolCallSearch>) => {
    if (reference !== undefined) field.replace(undefined);
    onChange({ ...(reference === undefined ? {} : { ...noFilters, q: undefined }), ...next });
    toolbar.current?.scrollIntoView({ block: "nearest" });
  };
  const count = appliedFilterCount(search);
  return (
    <>
      <div ref={toolbar} className="mb-2.5 flex scroll-mt-4 items-center gap-2">
        <SearchInput
          value={field.text}
          onChange={field.setText}
          placeholder={activitySearchPlaceholder}
        />
        <FilterMenu search={search} onChange={onChange} count={count} />
      </div>
      <CallList search={search} onChange={onChange} narrow={narrow} />
    </>
  );
}

/** A choice in a filter: its value in the address, its label and its mark. */
type Choice = { readonly value: string; readonly label: string; readonly mark: ReactNode };
/** One thing the list can be narrowed by. */
type Facet = {
  readonly name: FilterName | "range";
  readonly label: string;
  readonly icon: Icon;
  /** Choosing nothing; the range has no such choice. */
  readonly none?: string;
  readonly value: string | undefined;
  readonly choices: readonly Choice[];
  /** The label of a value no choice names, such as a member with no calls in this range. */
  readonly fallback: string;
};

/** An app's icon at the size of a menu row. */
function AppMark({ app, name }: { readonly app: App | undefined; readonly name: string }) {
  return (
    <span className="contents [&_.provider-icon]:size-5 [&_.provider-icon]:rounded-[5px]">
      <AppIcon app={app} name={name} />
    </span>
  );
}

const StatusMark = ({ status }: { readonly status: ToolCallStatus }) => (
  <HugeiconsIcon
    icon={statuses[status].icon}
    strokeWidth={2}
    aria-hidden
    className={statuses[status].ink}
  />
);

/**
 * The filters the menu offers. Members see only their own calls, so they are offered no member
 * filter; member, agent and connection filters appear when the range has any, or with `every`
 * before the range's choices are known.
 */
const facetsFor = (
  search: ToolCallSearch,
  filters: ToolCallFilters | undefined,
  admin: boolean,
  calls: readonly ToolCall[],
  every = false,
): readonly Facet[] => {
  const records = new Map(filters?.appRecords.map((app) => [app.id, app]));
  const members = filters?.members ?? [];
  const agents = filters?.agents ?? [];
  const connections = filters?.connections ?? [];
  const facets: Facet[] = [];
  if (admin && (every || members.length > 0 || search.member !== undefined))
    facets.push({
      name: "member",
      label: "Member",
      icon: UserIcon,
      none: "All members",
      value: search.member,
      choices: members.map((member) => {
        const label = member.name ?? member.email ?? "Unknown member";
        return {
          value: member.id,
          label,
          mark: <MemberAvatar name={label} image={member.image} className="size-5" />,
        };
      }),
      fallback: Option.match(
        Option.fromNullishOr(calls.find((call) => call.member?.id === search.member)?.member),
        { onNone: () => "Another member", onSome: personName },
      ),
    });
  facets.push({
    name: "app",
    label: "App",
    icon: BoxesIcon,
    none: "All apps",
    value: search.app,
    choices: (filters?.apps ?? []).map((app) => {
      const label = app.name ?? "An app you can no longer use";
      return { value: app.id, label, mark: <AppMark app={records.get(app.id)} name={label} /> };
    }),
    fallback: Option.match(Option.fromNullishOr(calls.find((call) => call.app.id === search.app)), {
      onNone: () => "Another app",
      onSome: appName,
    }),
  });
  facets.push({
    name: "status",
    label: "Status",
    icon: CheckmarkCircle02Icon,
    none: "All statuses",
    value: search.status,
    choices: statusOrder.map((status) => ({
      value: status,
      label: statuses[status].label,
      mark: <StatusMark status={status} />,
    })),
    fallback: "Another status",
  });
  if (every || agents.length > 0 || search.agent !== undefined)
    facets.push({
      name: "agent",
      label: "Agent",
      icon: RobotIcon,
      none: "All agents and keys",
      value: search.agent,
      choices: agents.map((agent) => ({
        value: agent.id,
        label: agent.name ?? sourceKinds[agent.source],
        mark: (
          <SourceMark
            source={{ kind: agent.source, name: agent.name, icon: agent.icon }}
            className="size-4"
          />
        ),
      })),
      fallback: Option.match(
        Option.fromNullishOr(calls.find((call) => call.source.id === search.agent)?.source),
        { onNone: () => "Another agent", onSome: sourceName },
      ),
    });
  if (every || connections.length > 0 || search.connection !== undefined)
    facets.push({
      name: "connection",
      label: "Connection",
      icon: ConnectIcon,
      none: "All connections",
      value: search.connection,
      choices: connections.map((connection) => ({
        value: connection.id,
        label: connection.name ?? "Unnamed connection",
        mark: <HugeiconsIcon icon={ConnectIcon} strokeWidth={2} aria-hidden />,
      })),
      fallback:
        calls.find((call) => call.connection?.id === search.connection)?.connection?.name ??
        "Another connection",
    });
  return facets;
};

const chosen = (facet: Facet) =>
  facet.value === undefined
    ? (facet.none ?? "")
    : (facet.choices.find((choice) => choice.value === facet.value)?.label ?? facet.fallback);

/** The menu's choices for the range in the address, and whether the viewer may see every call. */
function useFacetSource(search: ToolCallSearch) {
  const { organization, role } = useOrganizationRoute();
  const range = search.range ?? defaultToolCallRange;
  const filters = useAtomValue(
    toolCallFiltersAtom(new ToolCallFiltersKey({ organization, range })),
  );
  return {
    filters: Option.getOrUndefined(AsyncResult.value(filters)),
    loading: AsyncResult.isInitial(filters),
    admin: role === "owner" || role === "admin",
  };
}

/**
 * One menu for every filter and the time range. Where the page is wide enough, a filter's choices
 * open beside it when the pointer rests on it. On a narrow screen nothing fits beside the menu, so
 * the choices replace the list of filters in place.
 */
function FilterMenu({
  search,
  onChange,
  count,
}: {
  readonly search: ToolCallSearch;
  readonly onChange: ActivitySearchChange;
  readonly count: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <ActivityFilterButton count={count} />
      </DropdownMenuTrigger>
      {open && <FilterMenuContent search={search} onChange={onChange} count={count} />}
    </DropdownMenu>
  );
}

/** Wide enough for a filter's choices to open beside the menu; narrower pages use touch sizes. */
const roomBeside = "(min-width: 741px)";

function FilterMenuContent({
  search,
  onChange,
  count,
}: {
  readonly search: ToolCallSearch;
  readonly onChange: ActivitySearchChange;
  readonly count: number;
}) {
  const source = useFacetSource(search);
  // Opened before its choices arrived, the menu lists every filter that may have some until it
  // closes, each saying its choices are loading: rows that appeared or went as they arrived would
  // move the one under the pointer. The next opening lists only the filters with choices.
  const [every] = useState(source.loading);
  const beside = useMediaQuery(roomBeside);
  const [picking, setPicking] = useState<Facet["name"]>();
  const content = useRef<HTMLDivElement>(null);
  const range = search.range ?? defaultToolCallRange;
  const facets: readonly Facet[] = [
    ...facetsFor(search, source.filters, source.admin, [], every),
    {
      name: "range",
      label: "Time range",
      icon: Clock01Icon,
      value: range,
      choices: ranges.map(([value, label]) => ({
        value,
        label,
        mark: <HugeiconsIcon icon={Clock01Icon} strokeWidth={2} aria-hidden />,
      })),
      fallback: rangeLabel(range),
    },
  ];
  /** In place, the filter whose choices replaced the list of filters. */
  const facet = beside ? undefined : facets.find((candidate) => candidate.name === picking);
  /** The filter the reader stepped back from, whose row takes the focus again. */
  const [left, setLeft] = useState<Facet["name"]>();
  /** The pressed row leaves the menu, so the menu takes the focus to keep arrow keys working. */
  const step = (event: Event, next: Facet["name"] | undefined) => {
    event.preventDefault();
    content.current?.focus();
    setLeft(next === undefined ? picking : undefined);
    setPicking(next);
  };
  useEffect(() => {
    if (picking !== undefined || left === undefined) return;
    content.current?.querySelector<HTMLElement>(`[data-facet="${left}"]`)?.focus();
  }, [picking, left]);
  const choose = (facet: Facet, value: string) => {
    if (facet.name === "range") {
      const next = ranges.find(([each]) => each === value)?.[0];
      onChange({ range: next === defaultToolCallRange ? undefined : next });
    } else if (facet.name === "status") {
      onChange({ status: statusOrder.find((status) => status === value) });
    } else if (facet.name === "app") {
      onChange({ app: source.filters?.apps.find((app) => app.id === value)?.id });
    } else onChange({ [facet.name]: value === all ? undefined : value });
  };
  const choices = (facet: Facet) => (
    <Choices facet={facet} loading={source.loading} onChoose={(value) => choose(facet, value)} />
  );
  const row = (facet: Facet) => (
    <>
      <HugeiconsIcon icon={facet.icon} strokeWidth={2} aria-hidden />
      {facet.label}
      <span className="min-w-0 flex-1 truncate pl-3 text-right text-xs text-muted-foreground">
        {chosen(facet)}
      </span>
    </>
  );
  return (
    <DropdownMenuContent
      ref={content}
      align="start"
      collisionPadding={16}
      className="w-64 max-w-[calc(100vw-32px)]"
    >
      {facet === undefined ? (
        <>
          <DropdownMenuGroup aria-label="Filters">
            {facets.map((each) =>
              beside ? (
                <DropdownMenuSub key={each.name}>
                  <DropdownMenuSubTrigger>{row(each)}</DropdownMenuSubTrigger>
                  <DropdownMenuPortal>
                    <DropdownMenuSubContent
                      collisionPadding={16}
                      className="max-h-[min(360px,60dvh)] w-60 overflow-y-auto"
                    >
                      {choices(each)}
                    </DropdownMenuSubContent>
                  </DropdownMenuPortal>
                </DropdownMenuSub>
              ) : (
                <DropdownMenuItem
                  key={each.name}
                  data-facet={each.name}
                  onSelect={(event) => step(event, each.name)}
                >
                  {row(each)}
                  <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} aria-hidden />
                </DropdownMenuItem>
              ),
            )}
          </DropdownMenuGroup>
          {count > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onChange(noFilters)}>
                Clear filters
              </DropdownMenuItem>
            </>
          )}
        </>
      ) : (
        <>
          <DropdownMenuItem
            onSelect={(event) => step(event, undefined)}
            className="text-muted-foreground"
            aria-label={`${facet.label}, back to filters`}
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} aria-hidden />
            {facet.label}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <div className="max-h-[min(360px,60dvh)] overflow-y-auto">{choices(facet)}</div>
        </>
      )}
    </DropdownMenuContent>
  );
}

/** One filter's choices; the one in use is checked. */
function Choices({
  facet,
  loading,
  onChoose,
}: {
  readonly facet: Facet;
  /** The range's members, apps, agents and connections are still on the way. */
  readonly loading: boolean;
  readonly onChoose: (value: string) => void;
}) {
  return (
    <DropdownMenuRadioGroup
      aria-label={facet.label}
      value={facet.value ?? all}
      onValueChange={onChoose}
    >
      {facet.none !== undefined && (
        <DropdownMenuRadioItem value={all}>
          <ChoiceMark>
            <HugeiconsIcon icon={facet.icon} strokeWidth={2} aria-hidden />
          </ChoiceMark>
          {facet.none}
        </DropdownMenuRadioItem>
      )}
      {facet.value !== undefined &&
        !facet.choices.some((choice) => choice.value === facet.value) && (
          <DropdownMenuRadioItem value={facet.value}>
            <ChoiceMark>
              <HugeiconsIcon icon={facet.icon} strokeWidth={2} aria-hidden />
            </ChoiceMark>
            {facet.fallback}
          </DropdownMenuRadioItem>
        )}
      {facet.choices.map((choice) => (
        <DropdownMenuRadioItem key={choice.value} value={choice.value}>
          <ChoiceMark>{choice.mark}</ChoiceMark>
          <span className="min-w-0 truncate">{choice.label}</span>
        </DropdownMenuRadioItem>
      ))}
      {loading && facet.name !== "status" && facet.name !== "range" && (
        <div role="status" className="px-2 py-1.5 text-xs text-muted-foreground">
          Loading choices…
        </div>
      )}
    </DropdownMenuRadioGroup>
  );
}

const ChoiceMark = ({ children }: { readonly children: ReactNode }) => (
  <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
    {children}
  </span>
);

/** A filter in use; pressing it removes the filter. */
function Chip({
  children,
  onRemove,
}: {
  readonly children: string;
  readonly onRemove: () => void;
}) {
  return (
    <Button
      variant="outline"
      size="xs"
      className="max-w-full rounded-full font-normal shadow-none max-[740px]:min-h-8 max-[740px]:px-2.5"
      aria-label={`Remove filter ${children}`}
      onClick={onRemove}
    >
      <span className="min-w-0 truncate">{children}</span>
      <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} aria-hidden />
    </Button>
  );
}

/** What is listed, and the filters in use as chips that remove themselves. */
function Summary({
  page,
  search,
  onChange,
  waiting,
  stale,
}: {
  readonly page: ToolCallPage;
  readonly search: ToolCallSearch;
  readonly onChange: ActivitySearchChange;
  readonly waiting: boolean;
  /** The page shown is the previous list's, kept while this one loads. */
  readonly stale: boolean;
}) {
  const source = useFacetSource(search);
  const range = search.range ?? defaultToolCallRange;
  const reference = searchedReference(search) !== undefined;
  const total = `${page.totalCapped ? "More than " : ""}${counted(page.total, "tool call")}${
    source.admin ? "" : " by you"
  }`;
  // The kept page's count belongs to the previous search and filters, so it is not stated.
  const text = stale
    ? "Loading tool calls…"
    : reference
      ? page.items.length === 0
        ? "No tool call has this reference"
        : "1 tool call with this reference"
      : `${total} in the ${rangeLabel(range).toLowerCase()}`;
  const facets = facetsFor(search, source.filters, source.admin, page.items);
  const ignored = reference && activeFilters(search).length > 0;
  return (
    <div
      className="mb-3 flex min-h-6 flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
      aria-busy={waiting}
    >
      <span role="status" className="mr-1">
        {text}
      </span>
      {ignored && <span>Filters do not apply to a reference.</span>}
      {!reference &&
        facets
          .filter((facet) => facet.value !== undefined)
          .map((facet) => (
            <Chip
              key={facet.name}
              onRemove={() => onChange({ [facet.name]: undefined })}
            >{`${facet.label}: ${chosen(facet)}`}</Chip>
          ))}
      {!reference && search.session !== undefined && (
        <Chip onRemove={() => onChange({ session: undefined })}>One session</Chip>
      )}
      {!reference && search.run !== undefined && (
        <Chip onRemove={() => onChange({ run: undefined })}>One run</Chip>
      )}
    </div>
  );
}

const callColumns =
  "min-[900px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1.1fr)_minmax(0,1.1fr)_124px_112px]";

/** Rows the reader opened or closed; a referenced call starts open. */
type Opened = {
  readonly isOpen: (call: ToolCall) => boolean;
  readonly toggle: (call: ToolCall) => void;
};

/**
 * The list the address names. While another list loads, the previous one stays on screen, marked
 * busy, so typing and filtering never flash an empty page. A list read again that fails stays on
 * screen too, under the failure and its Retry, so calls already read never pass for current ones.
 */
function CallList({
  search,
  onChange,
  narrow,
}: {
  readonly search: ToolCallSearch;
  readonly onChange: ActivitySearchChange;
  readonly narrow: (next: Partial<ToolCallSearch>) => void;
}) {
  const { organization } = useOrganizationRoute();
  const key = toolCallPageKey(organization, search);
  const atom = toolCallPageAtom(key);
  const result = useAtomValue(atom);
  const retry = useAtomRefresh(atom);
  const current = Option.getOrUndefined(AsyncResult.value(result));
  const [kept, setKept] = useState(current);
  if (current !== undefined && current !== kept) setKept(current);
  const reference = searchedReference(search);
  const [toggled, setToggled] = useState<{ readonly id: string; readonly open: boolean }>();
  const opened: Opened = {
    isOpen: (call) => (toggled?.id === call.id ? toggled.open : call.id === reference),
    toggle: (call) => setToggled({ id: call.id, open: !opened.isOpen(call) }),
  };
  // Pages after the first are opened on demand and closed when the list changes.
  const [more, setMore] = useState<{
    readonly key: ToolCallPageKey;
    readonly cursors: readonly Cursor[];
  }>({ key, cursors: [] });
  const cursors = Equal.equals(more.key, key) ? more.cursors : [];
  if (AsyncResult.isFailure(result) && current === undefined)
    return (
      <>
        <div className="mb-3 min-h-6" />
        <HostedFailure cause={result.cause} retry={retry} retrying={result.waiting} />
      </>
    );
  const page = current ?? kept;
  if (page === undefined) return <ActivityListPending />;
  const waiting = current === undefined || result.waiting;
  return (
    <>
      <Summary
        page={page}
        search={search}
        onChange={onChange}
        waiting={waiting}
        stale={current === undefined}
      />
      {AsyncResult.isFailure(result) && (
        <div className="mb-3">
          <HostedFailure
            cause={result.cause}
            retry={retry}
            retrying={result.waiting}
            layout="compact"
          />
        </div>
      )}
      {page.items.length === 0 ? (
        <NoCalls search={search} onChange={onChange} />
      ) : (
        <div className={waiting && current === undefined ? "opacity-60 transition-opacity" : ""}>
          <div
            aria-hidden
            className={`hidden gap-4 border-b px-3 pb-2.5 text-xs text-muted-foreground min-[900px]:grid ${callColumns}`}
          >
            <span>Tool</span>
            <span>Called by</span>
            <span>Account</span>
            <span>Status</span>
            <span className="text-right">Time</span>
          </div>
          <ul aria-label="Tool calls" className="divide-y border-b">
            <Rows page={page} opened={opened} narrow={narrow} />
            {current !== undefined && (
              <Continuation
                listKey={key}
                next={page.next}
                cursors={cursors}
                open={(cursor) => setMore({ key, cursors: [...cursors, cursor] })}
                opened={opened}
                narrow={narrow}
              />
            )}
          </ul>
        </div>
      )}
    </>
  );
}

function Rows({
  page,
  opened,
  narrow,
}: {
  readonly page: ToolCallPage;
  readonly opened: Opened;
  readonly narrow: (next: Partial<ToolCallSearch>) => void;
}) {
  const apps = new Map(page.apps.map((app) => [app.id, app]));
  return page.items.map((call) => (
    <CallRow
      key={call.id}
      call={call}
      app={apps.get(call.app.id)}
      open={opened.isOpen(call)}
      onToggle={() => opened.toggle(call)}
      narrow={narrow}
    />
  ));
}

/** The next page, once asked for, or the button that asks for it. */
function Continuation({
  listKey,
  next,
  cursors,
  open,
  opened,
  narrow,
}: {
  readonly listKey: ToolCallPageKey;
  readonly next: Cursor | undefined;
  readonly cursors: readonly Cursor[];
  readonly open: (cursor: Cursor) => void;
  readonly opened: Opened;
  readonly narrow: (next: Partial<ToolCallSearch>) => void;
}) {
  if (next === undefined) return null;
  if (!cursors.includes(next))
    return (
      <li className="flex justify-center py-4">
        <Button variant="outline" size="sm" onClick={() => open(next)}>
          Load more tool calls
        </Button>
      </li>
    );
  return (
    <NextPage
      listKey={listKey}
      cursor={next}
      cursors={cursors}
      open={open}
      opened={opened}
      narrow={narrow}
    />
  );
}

function NextPage({
  listKey,
  cursor,
  ...rest
}: {
  readonly listKey: ToolCallPageKey;
  readonly cursor: Cursor;
  readonly cursors: readonly Cursor[];
  readonly open: (cursor: Cursor) => void;
  readonly opened: Opened;
  readonly narrow: (next: Partial<ToolCallSearch>) => void;
}) {
  const atom = toolCallPageAtom(
    toolCallPageKey(
      listKey.organization,
      {
        q: listKey.search,
        range: listKey.range,
        member: listKey.member,
        app: listKey.app,
        status: listKey.status,
        agent: listKey.agent,
        connection: listKey.connection,
        session: listKey.session,
        run: listKey.run,
      },
      { cursor },
    ),
  );
  const result = useAtomValue(atom);
  const retry = useAtomRefresh(atom);
  const page = Option.getOrUndefined(AsyncResult.value(result));
  // A page read again that fails keeps its calls on screen, above the failure.
  const failure = AsyncResult.isFailure(result) && (
    <li className="py-3">
      <HostedFailure
        cause={result.cause}
        retry={retry}
        retrying={result.waiting}
        layout={page === undefined ? undefined : "compact"}
      />
    </li>
  );
  if (page !== undefined)
    return (
      <>
        <Rows page={page} opened={rest.opened} narrow={rest.narrow} />
        {failure}
        <Continuation listKey={listKey} next={page.next} {...rest} />
      </>
    );
  if (failure) return failure;
  return (
    <li role="status" aria-label="Loading more tool calls" className="flex flex-col">
      {[0, 1, 2].map((row) => (
        <span key={row} className="flex items-center gap-3 border-b px-3 py-3 last:border-0">
          <Skeleton className="size-8.5 rounded-[8px]" />
          <Skeleton className="h-3.5 w-48" />
        </span>
      ))}
    </li>
  );
}

/** Why the list is empty, and what the reader can do about it. */
function NoCalls({
  search,
  onChange,
}: {
  readonly search: ToolCallSearch;
  readonly onChange: ActivitySearchChange;
}) {
  const { organization, slug, role } = useOrganizationRoute();
  const admin = role === "owner" || role === "admin";
  if (searchedReference(search) !== undefined)
    return (
      <EmptyState title="No tool call has this reference">
        Check that the whole reference was pasted. Calls are kept for 30 days
        {admin ? "." : ", and you can see only your own."}
      </EmptyState>
    );
  const range = search.range ?? defaultToolCallRange;
  if (search.q !== undefined || activeFilters(search).length > 0)
    return (
      <EmptyState
        title="No tool calls match"
        action={
          activeFilters(search).length > 0 && (
            <Button variant="outline" size="sm" onClick={() => onChange(noFilters)}>
              Clear filters
            </Button>
          )
        }
      >
        Try another search, or widen the filters and time range.
      </EmptyState>
    );
  return range === "30d" ? (
    <FirstVisit admin={admin} slug={slug} />
  ) : (
    <Suspense fallback={<div className="min-h-64" />}>
      <EmptyRange
        organization={organization}
        admin={admin}
        slug={slug}
        range={range}
        onWiden={() => onChange({ range: "30d" })}
      />
    </Suspense>
  );
}

/** An unfiltered range with no calls: the organization may still have older ones. */
function EmptyRange({
  organization,
  admin,
  slug,
  range,
  onWiden,
}: {
  readonly organization: ToolCallPageKey["organization"];
  readonly admin: boolean;
  readonly slug: string;
  readonly range: ToolCallRange;
  readonly onWiden: () => void;
}) {
  const result = useAtomValue(anyToolCallAtom(organization));
  const any = Option.getOrUndefined(AsyncResult.value(result));
  if (any === undefined) return <div className="min-h-64" />;
  if (any.items.length === 0) return <FirstVisit admin={admin} slug={slug} />;
  return (
    <EmptyState
      title={`No tool calls in the ${rangeLabel(range).toLowerCase()}`}
      action={
        <Button variant="outline" size="sm" onClick={onWiden}>
          Show the last 30 days
        </Button>
      }
    >
      {admin ? "Older calls are kept for 30 days." : "Your older calls are kept for 30 days."}
    </EmptyState>
  );
}

/** No call this viewer may see in the 30 days calls are kept. */
function FirstVisit({ admin, slug }: { readonly admin: boolean; readonly slug: string }) {
  return (
    <EmptyState
      title="No tool calls yet"
      action={
        <Button asChild variant="outline" size="sm">
          <Link to="/org/$organizationSlug/connect" params={{ organizationSlug: slug }}>
            Connect an agent
          </Link>
        </Button>
      }
    >
      {admin
        ? "When people or their agents call an app's tools through Executor, each call is listed here."
        : "When you or your agents call an app's tools through Executor, each call is listed here."}
    </EmptyState>
  );
}

function Pill({ tone, children }: { readonly tone: string; readonly children: ReactNode }) {
  return (
    <span
      className={`w-fit whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}
    >
      {children}
    </span>
  );
}

/** Who a call ran as, or what made it when no member did, with what made it beneath. */
function Actor({ call }: { readonly call: ToolCall }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      {call.member === null ? (
        <Avatar size="sm" aria-hidden>
          <AvatarFallback>
            <SourceMark source={call.source} className="size-[13px]" />
          </AvatarFallback>
        </Avatar>
      ) : (
        <MemberAvatar name={personName(call.member)} image={call.member.image} />
      )}
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-medium">
          {call.member === null ? sourceKinds[call.source.kind] : personName(call.member)}
        </span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <SourceMark source={call.source} className="size-3" />
          <span className="truncate">{sourceName(call.source)}</span>
        </span>
      </span>
    </span>
  );
}

function Accounts({ accounts }: { readonly accounts: ToolCall["accounts"] }) {
  if (accounts.length === 0) return <span className="text-xs text-muted-foreground">None</span>;
  return <span className="block truncate text-[13px]">{accounts.map(accountName).join(", ")}</span>;
}

function CallRow({
  call,
  app,
  open,
  onToggle,
  narrow,
}: {
  readonly call: ToolCall;
  readonly app: App | undefined;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly narrow: (next: Partial<ToolCallSearch>) => void;
}) {
  const reason =
    call.status === "failed" || call.status === "denied" ? failureReason(call) : undefined;
  const detail = `${call.id}-detail`;
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={open ? detail : undefined}
        className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-3 py-3 text-left outline-none hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-expanded:bg-muted/40 ${callColumns}`}
      >
        <span className="flex min-w-0 items-center gap-3">
          <AppIcon app={app} name={appName(call)} />
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span
                className={`truncate text-[13px] font-medium ${call.tool === null ? "text-muted-foreground" : "font-mono"}`}
              >
                {toolName(call)}
              </span>
              {call.kind === "mutation" && (
                <span className="rounded border px-1 text-[10px] leading-4 text-muted-foreground">
                  write
                </span>
              )}
            </span>
            <span className="block text-xs text-muted-foreground min-[900px]:truncate">
              {appName(call)}
              {reason !== undefined && (
                <span className={call.status === "failed" ? "text-destructive" : undefined}>
                  {" "}
                  · {reason}
                </span>
              )}
            </span>
          </span>
        </span>
        <span className="max-[899px]:order-3 max-[899px]:col-span-2">
          <Actor call={call} />
        </span>
        <span className="min-w-0 max-[899px]:hidden">
          <Accounts accounts={call.accounts} />
        </span>
        <Pill tone={statuses[call.status].tone}>{statuses[call.status].label}</Pill>
        <span className="text-right text-xs text-muted-foreground max-[899px]:hidden">
          <span className="block">
            <LocalTime value={call.startedAt} options={shortMoment} />
          </span>
          <span className="block font-mono text-[11px]">{duration(call.durationMs)}</span>
        </span>
        <span className="order-4 col-span-2 truncate pl-8.5 text-xs text-muted-foreground min-[900px]:hidden">
          {call.accounts.length > 0 && `${call.accounts.map(accountName).join(", ")} · `}
          <LocalTime value={call.startedAt} options={shortMoment} />
        </span>
      </button>
      {open && <CallDetail id={detail} call={call} narrow={narrow} />}
    </li>
  );
}

/** One label and value in a call's detail. */
function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-3 py-1.5 text-[13px]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 wrap-anywhere">{children}</dd>
    </div>
  );
}

/**
 * Narrows the list to calls sharing something with this one. Below a value it starts a line of its
 * own; `alone` is a field whose only content is this link, level with the label. Its text sits at
 * the top of its touch target, so the target adds no space above it.
 */
function Narrow({
  children,
  onClick,
  alone = false,
}: {
  readonly children: string;
  readonly onClick: () => void;
  readonly alone?: boolean;
}) {
  return (
    <button
      type="button"
      className={`${alone ? "pt-px" : "mt-0.5"} flex w-fit items-start text-left text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground max-[740px]:-mb-2 max-[740px]:min-h-8`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Approval({ approval }: { readonly approval: NonNullable<ToolCall["approval"]> }) {
  const by = approval.decidedBy === null ? undefined : personName(approval.decidedBy);
  const at = approval.decidedAt ?? approval.expiresAt;
  switch (approval.decision) {
    case "pending":
      return (
        <>
          Waiting for an answer
          <span className="block text-xs text-muted-foreground">
            Expires <LocalTime value={approval.expiresAt} options={shortMoment} />
          </span>
        </>
      );
    case "approved":
    case "denied":
      return (
        <>
          {approval.decision === "approved" ? "Approved" : "Denied"}
          {by !== undefined && ` by ${by}`}
          <span className="block text-xs text-muted-foreground">
            <LocalTime value={at} options={shortMoment} />
          </span>
        </>
      );
    case "expired":
      return (
        <>
          No answer was recorded
          <span className="block text-xs text-muted-foreground">
            Expired <LocalTime value={approval.expiresAt} options={shortMoment} />
          </span>
        </>
      );
  }
}

const sourceLabels: Record<ToolCallSource, string> = {
  agent: "Agent",
  "api-key": "API key",
  dashboard: "Made from",
  schedule: "Schedule",
  webhook: "Webhook",
  workflow: "Workflow",
};

/**
 * Whether the caller was certainly given the call's reference, beside the error or refusal it was
 * told. A call that stopped before it answered told it nothing, and one that failed in a way
 * Executor did not expect may have answered without one.
 */
const returned = (call: ToolCall) =>
  (call.status === "failed" || call.status === "denied") &&
  call.errorType !== "Interrupted" &&
  call.errorType !== "Defect";

function CallDetail({
  id,
  call,
  narrow,
}: {
  readonly id: string;
  readonly call: ToolCall;
  readonly narrow: (next: Partial<ToolCallSearch>) => void;
}) {
  const reason = failureReason(call);
  const member = call.member;
  const source = call.source;
  const run = call.run;
  return (
    <section id={id} aria-label={`Details of ${call.id}`} className="bg-muted/20 px-5 py-4">
      <dl className="grid gap-x-10 min-[900px]:grid-cols-2">
        <Field label="Called by">
          {member === null ? (
            call.app.name === null ? (
              "The app, on its own"
            ) : (
              `The ${call.app.name} app, on its own`
            )
          ) : (
            <>
              {personName(member)}
              <span className="block text-xs text-muted-foreground">
                {member.member ? member.email : "No longer a member"}
              </span>
            </>
          )}
        </Field>
        <Field label={sourceLabels[source.kind]}>
          {source.kind === "dashboard" ? "The dashboard" : sourceName(source)}
          {source.id !== null && (source.kind === "agent" || source.kind === "api-key") && (
            <Narrow onClick={() => narrow({ agent: source.id ?? undefined })}>
              {source.kind === "agent" ? "Show this agent's calls" : "Show this key's calls"}
            </Narrow>
          )}
        </Field>
        {call.connection !== null && (
          <Field label="Connection">
            {call.connection.name ?? "Unnamed connection"}
            <Narrow onClick={() => narrow({ connection: call.connection?.id })}>
              Show this connection's calls
            </Narrow>
          </Field>
        )}
        <Field label="Tool">
          <span className={call.tool === null ? "text-muted-foreground" : "font-mono"}>
            {toolName(call)}
          </span>
          <span className="block text-xs text-muted-foreground">
            {appName(call)}
            {call.kind === "mutation" && " · Can make changes"}
            {call.kind === "query" && " · Reads only"}
          </span>
        </Field>
        {call.version !== null && (
          <Field label="Version">
            <span className="font-mono text-xs">{call.version}</span>
          </Field>
        )}
        <Field label={call.accounts.length > 1 ? "Accounts" : "Account"}>
          {call.accounts.length === 0 ? (
            <span className="text-muted-foreground">None</span>
          ) : (
            call.accounts.map((account, index) => (
              <span key={account.id ?? `personal-${index}`} className="block">
                {accountName(account)}
              </span>
            ))
          )}
        </Field>
        {call.approval !== null && (
          <Field label="Approval">
            <Approval approval={call.approval} />
          </Field>
        )}
        {reason !== undefined && (
          <Field label={call.status === "denied" ? "Reason" : "Failure"}>
            <span className={call.status === "failed" ? "text-destructive" : undefined}>
              {reason}
            </span>
          </Field>
        )}
        <Field label="Reference">
          <span className="flex items-center gap-1">
            <span className="font-mono">{call.id}</span>
            {/* Its touch target overlaps the row's padding, so the row is as tall as its text. */}
            <span className="max-[740px]:-my-3">
              <CopyButton code={call.id} label="Copy reference" inline text="" />
            </span>
          </span>
          {returned(call) && (
            <span className="block text-xs text-muted-foreground">
              Returned with the {call.status === "failed" ? "error" : "refusal"}, so{" "}
              {member === null ? "the caller" : personName(member)} can quote it.
            </span>
          )}
        </Field>
        <Field label="Started">
          <LocalTime value={call.startedAt} options={exactMoment} />
        </Field>
        <Field label="Duration">
          {call.durationMs === null ? "Not recorded" : duration(call.durationMs)}
        </Field>
        {call.session !== null && (
          <Field label="MCP session">
            <Narrow alone onClick={() => narrow({ session: call.session ?? undefined })}>
              Show this session's calls
            </Narrow>
          </Field>
        )}
        {run !== null && run.calls > 1 && (
          <Field label="Run">
            One of {run.calls} calls made by the same program.
            <Narrow onClick={() => narrow({ run: run.id })}>Show the run</Narrow>
          </Field>
        )}
      </dl>
    </section>
  );
}
