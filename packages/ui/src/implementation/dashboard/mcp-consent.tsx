import { useRef, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import type { ApprovalMode, GrantAccessChoice, GrantTarget } from "@executor-js/mcp-auth/grants";
import { Button } from "../components/button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "../components/select.tsx";
import { Skeleton } from "../components/skeleton.tsx";
import type { ConsentConnection } from "../../contracts/scoped-connections.ts";

/** A summary line: the term on the left, its value against the right edge. */
const row = "grid min-h-12 grid-cols-[7.5rem_1fr] items-center gap-x-4 py-1 max-[740px]:min-h-13";
/** Hairlines between the lines, and above and below them, instead of a boxed card. */
const list = "mcp-consent-summary m-0 divide-y divide-foreground/10 border-y border-foreground/10";

/** Stable consent shell shared by local and hosted connections, including their loading state. */
export function McpConsentLayout({
  children,
  description,
}: {
  readonly children: ReactNode;
  readonly description: ReactNode;
}) {
  return (
    <main className="mcp-consent-page min-h-dvh py-[48px] px-[20px] max-[480px]:py-[28px] max-[480px]:px-[16px]">
      <section className="mcp-consent-form w-full max-w-sm my-0 mx-auto flex flex-col gap-7 [&_h1]:text-[28px] [&_h1]:leading-[1.2] [&_h1]:[margin:0_0_10px] max-[480px]:gap-5.5 max-[480px]:[&_h1]:text-[24px]">
        <div className="mcp-consent-brand flex items-center gap-2.25 text-[19px] [font-weight:550] tracking-[-0.04em] mb-2 [&_img]:w-6.25 [&_img]:h-6.25">
          <img src="/favicon.png" alt="" />
          executor
        </div>
        <header>
          <h1 className="font-semibold tracking-[-0.035em]">Connect to Executor</h1>
          <div className="mcp-consent-intro text-muted-foreground text-[14px] leading-[1.6] [&_strong]:text-foreground [&_strong]:[font-weight:550]">
            {description}
          </div>
        </header>
        {children}
      </section>
    </main>
  );
}

/** Loading keeps the same shape as the consent form without flashing a full-page spinner. */
export function McpConsentLoading() {
  return (
    <McpConsentLayout description={<Skeleton className="h-5 w-3/4" />}>
      <div
        role="status"
        aria-label="Loading connection"
        className="mcp-consent-loading flex flex-col gap-7 max-[480px]:gap-5.5"
      >
        <span className="sr-only">Loading connection…</span>
        <div className="flex flex-col gap-3.5">
          <div className={list}>
            {["w-20", "w-16", "w-32"].map((width) => (
              <div key={width} className={row}>
                <Skeleton className="h-4 w-20" />
                <Skeleton className={`h-4 justify-self-end ${width}`} />
              </div>
            ))}
          </div>
          <Skeleton className="h-4 w-3/4" />
        </div>
        <div className="mcp-consent-actions grid grid-cols-2 gap-2.5">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      </div>
    </McpConsentLayout>
  );
}

/**
 * A registered client chooses its own display name, so the name alone cannot tell
 * the person who is asking. The authorization server has already matched this
 * redirect URI against the client's registration, and it is where the
 * authorization code is delivered, so it is shown as the destination.
 */
export const consentDestination = (redirectUri: string | null): string | undefined => {
  if (redirectUri === null || redirectUri.length === 0) return undefined;
  const target = URL.parse(redirectUri);
  if (target === null) return undefined;
  return target.origin === "null" ? `${target.protocol}//` : target.origin;
};

/** One line of the consent summary: what is granted, then its value or the control that sets it. */
export function McpConsentRow({
  label,
  htmlFor,
  children,
}: {
  readonly label: string;
  /** The control this row labels, when its value can be changed. */
  readonly htmlFor?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div className={row}>
      <dt className="text-[14px] font-medium">
        {htmlFor === undefined ? label : <label htmlFor={htmlFor}>{label}</label>}
      </dt>
      {htmlFor === undefined ? (
        <dd className="m-0 min-w-0 truncate text-right text-[14px] text-muted-foreground">
          {children}
        </dd>
      ) : (
        <dd className="m-0 flex min-w-0 justify-end">{children}</dd>
      )}
    </div>
  );
}

/** A row whose value is still being read; the line keeps its loaded height. */
export function McpConsentRowPending({ label }: { readonly label: string }) {
  return (
    <McpConsentRow label={label}>
      <span
        role="status"
        aria-label={`Loading ${label.toLowerCase()}`}
        className="flex justify-end"
      >
        <Skeleton className="h-4 w-24" />
      </span>
    </McpConsentRow>
  );
}

/** A row whose value could not be read: the failure and its retry take the value's place. */
export function McpConsentRowFailure({
  label,
  message,
  retry,
  retrying,
}: {
  readonly label: string;
  readonly message: string;
  readonly retry: () => void;
  readonly retrying: boolean;
}) {
  return (
    <div className={row}>
      <dt className="text-[14px] font-medium">{label}</dt>
      <dd role="alert" className="m-0 flex min-w-0 items-center justify-end gap-1">
        <span className="min-w-0 truncate text-[13px] text-destructive">{message}</span>
        <Button
          variant="ghost"
          size="sm"
          className="-mr-2 h-8 shrink-0 px-2 text-[14px]"
          loading={retrying}
          disabled={retrying}
          onClick={retry}
        >
          Retry
        </Button>
      </dd>
    </div>
  );
}

export interface ConsentOption {
  readonly value: string;
  readonly label: string;
  readonly detail?: string | undefined;
}

/** A row's value as a menu. It reads as the value until it is opened. */
export function McpConsentSelect({
  id,
  value,
  options,
  onChange,
  disabled = false,
  children,
}: {
  readonly id: string;
  readonly value: string;
  readonly options: readonly ConsentOption[];
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean | undefined;
  /** Further menu entries, after the options. */
  readonly children?: ReactNode;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger
        id={id}
        className="-mr-2 h-8 gap-1.5 border-0 bg-transparent px-2 text-[14px] font-normal shadow-none hover:bg-muted data-[state=open]:bg-muted max-[740px]:text-[14px] dark:bg-transparent"
      >
        <SelectValue>{options.find((option) => option.value === value)?.label}</SelectValue>
      </SelectTrigger>
      <SelectContent align="end" className="min-w-64">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} className="items-start py-2">
            <span className="flex flex-col gap-0.5 text-left">
              <span className="font-medium">{option.label}</span>
              {option.detail !== undefined && (
                <span className="text-[13px] text-muted-foreground">{option.detail}</span>
              )}
            </span>
          </SelectItem>
        ))}
        {children}
      </SelectContent>
    </Select>
  );
}

const approvalOptions: readonly (ConsentOption & { readonly value: ApprovalMode })[] = [
  {
    value: "model",
    label: "Through your agent",
    detail: "Your agent shows you the request and resumes the call.",
  },
  { value: "browser", label: "In Executor", detail: "You review the call in your browser." },
  // Last, because the page cannot know whether this client supports MCP prompts.
  {
    value: "native",
    label: "In your client",
    detail: "Your client prompts you, if it supports MCP prompts.",
  },
];

/** Where approvals are answered: a menu when the person may change it, otherwise its name. */
export function McpConsentApprovals({
  mode,
  onMode,
  disabled,
}: {
  readonly mode: ApprovalMode;
  readonly onMode?: ((mode: ApprovalMode) => void) | undefined;
  readonly disabled?: boolean | undefined;
}) {
  if (onMode === undefined)
    return (
      <McpConsentRow label="Approvals">
        {approvalOptions.find((option) => option.value === mode)?.label}
      </McpConsentRow>
    );
  return (
    <McpConsentRow label="Approvals" htmlFor="mcp-consent-approvals">
      <McpConsentSelect
        id="mcp-consent-approvals"
        value={mode}
        disabled={disabled}
        options={approvalOptions}
        onChange={(value) => {
          const chosen = approvalOptions.find((option) => option.value === value);
          if (chosen !== undefined) onMode(chosen.value);
        }}
      />
    </McpConsentRow>
  );
}

/** What the request's resource names, for a page that offers no choice. */
export function McpConsentTargetRows({ target }: { readonly target: GrantTarget }) {
  return (
    <>
      <McpConsentRow label="Access">
        {target.kind === "api"
          ? "Executor API"
          : target.connection === undefined
            ? "All apps"
            : "One of your connections"}
      </McpConsentRow>
      {target.kind === "mcp" && <McpConsentApprovals mode={target.mode} />}
    </>
  );
}

/** Menu values that no connection ID can equal. */
const everyApp = "*";
const newConnection = "+";
const appsLabel = (apps: readonly string[]) => {
  const shown = apps.slice(0, 3).join(", ");
  return apps.length > 3 ? `${shown} and ${apps.length - 3} more` : shown;
};

/**
 * Which apps the grant reaches, chosen from the person's connections. A chosen connection missing
 * from the list, such as one revoked since, stays chosen and says so; the server refuses it.
 */
export function McpConsentAccess({
  connections,
  value,
  onChange,
  onNewConnection,
  disabled,
}: {
  readonly connections: readonly ConsentConnection[];
  readonly value: GrantAccessChoice;
  readonly onChange: (value: GrantAccessChoice) => void;
  /** Opens the connection editor; the page decides where. */
  readonly onNewConnection: () => void;
  readonly disabled?: boolean | undefined;
}) {
  const missing =
    value.kind === "connection" && !connections.some((item) => item.id === value.id)
      ? value.id
      : undefined;
  return (
    <McpConsentRow label="Access" htmlFor="mcp-consent-access">
      <McpConsentSelect
        id="mcp-consent-access"
        value={value.kind === "all" ? everyApp : value.id}
        disabled={disabled}
        options={[
          {
            value: everyApp,
            label: "All apps",
            detail: "Every app you can use, including apps you add later.",
          },
          ...connections.map((item) => ({
            value: item.id,
            label: item.name,
            detail: appsLabel(item.apps),
          })),
          ...(missing === undefined
            ? []
            : [
                {
                  value: missing,
                  label: "Unavailable connection",
                  detail: "This connection no longer exists. Choose another.",
                },
              ]),
        ]}
        onChange={(chosen) => {
          if (chosen === newConnection) onNewConnection();
          else if (chosen === everyApp) onChange({ kind: "all" });
          else {
            const found = connections.find((item) => item.id === chosen);
            if (found !== undefined) onChange({ kind: "connection", id: found.id });
          }
        }}
      >
        <SelectSeparator />
        {/* It opens the connection editor elsewhere; the arrow says so before it is chosen. */}
        <SelectItem value={newConnection}>
          <span className="flex items-center gap-1.5">
            New connection
            <HugeiconsIcon
              icon={ArrowUpRight01Icon}
              strokeWidth={2}
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground"
            />
          </span>
        </SelectItem>
      </McpConsentSelect>
    </McpConsentRow>
  );
}

/**
 * What approving grants, one row each, then one line of guidance. `children` are the rows: the
 * organization where there is one, then access and approvals.
 */
export function McpConsentSummary({
  note,
  children,
}: {
  readonly note?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3.5">
      <dl className={list}>{children}</dl>
      {note !== undefined && (
        <p className="mcp-consent-note m-0 text-[14px] text-pretty text-muted-foreground">{note}</p>
      )}
    </div>
  );
}

/** Where approving sends access, for the summary's note. */
export function McpConsentDestination({ origin }: { readonly origin: string }) {
  return (
    <span className="mcp-consent-destination">
      Access is sent to{" "}
      <span className="mcp-consent-destination-origin break-all font-medium text-foreground">
        {origin}
      </span>
      . Only continue if you recognize it.
    </span>
  );
}

const declineDecision = "decline",
  connectDecision = "connect";

/**
 * The decision: two equal buttons, declining first. They submit one form rather than handle
 * clicks, so a decision made before the page hydrates is held by the document's early-submission
 * guard and replayed with the same button once React owns the form, instead of being dropped.
 *
 * Only the button pressed decides, and one page sends at most one decision: a replayed submission
 * from a button that is now disabled is ignored (the replay submits it regardless), and so is any
 * submission while a decision is being sent or after one succeeded. A decision that fails can be
 * made again. Each callback resolves `true` once its decision was delivered.
 */
export function McpConsentActions({
  decline = "Cancel",
  onDecline,
  onConnect,
  waiting,
  connectDisabled = false,
}: {
  readonly decline?: string;
  readonly onDecline: () => Promise<boolean>;
  /** Omitted when there is nothing the person could connect. */
  readonly onConnect?: (() => Promise<boolean>) | undefined;
  readonly waiting: boolean;
  readonly connectDisabled?: boolean;
}) {
  const deciding = useRef(false);
  return (
    <form
      className="mcp-consent-actions grid grid-cols-2 gap-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        const submitter =
          event.nativeEvent instanceof SubmitEvent ? event.nativeEvent.submitter : null;
        if (!(submitter instanceof HTMLButtonElement) || submitter.disabled || deciding.current)
          return;
        const decide =
          submitter.value === connectDecision
            ? onConnect
            : submitter.value === declineDecision
              ? onDecline
              : undefined;
        if (decide === undefined) return;
        deciding.current = true;
        void decide().then(
          (delivered) => {
            if (!delivered) deciding.current = false;
          },
          () => {
            deciding.current = false;
          },
        );
      }}
    >
      <Button
        type="submit"
        name="decision"
        value={declineDecision}
        variant="outline"
        disabled={waiting}
      >
        {decline}
      </Button>
      {onConnect !== undefined && (
        <Button
          type="submit"
          name="decision"
          value={connectDecision}
          disabled={connectDisabled || waiting}
          loading={waiting}
        >
          Connect
        </Button>
      )}
    </form>
  );
}
