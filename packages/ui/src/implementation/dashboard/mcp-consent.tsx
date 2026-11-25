import { useRef, useState, type ReactNode } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  AiChat02Icon,
  ArrowUpRight01Icon,
  BrowserIcon,
  FlashIcon,
  LaptopIcon,
} from "@hugeicons/core-free-icons";
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

const row =
  "grid min-h-12 grid-cols-[7.5rem_1fr] items-center gap-x-4 py-1 max-[740px]:min-h-13 max-[740px]:py-0.5";
const list = "mcp-consent-summary m-0 divide-y divide-foreground/10 border-y border-foreground/10";

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

function LineLoading({ className }: { readonly className: string }) {
  return (
    <span className="flex h-lh items-center">
      <Skeleton className={`h-4 ${className}`} />
    </span>
  );
}

const rowWidths = ["w-20", "w-16", "w-32", "w-24"];

export function McpConsentLoading({
  rows = 3,
  noteLines = 2,
}: {
  readonly rows?: number;
  readonly noteLines?: number;
}) {
  return (
    <McpConsentLayout description={<LineLoading className="w-3/4" />}>
      <div
        role="status"
        aria-label="Loading connection"
        className="mcp-consent-loading flex flex-col gap-7 max-[480px]:gap-5.5"
      >
        <span className="sr-only">Loading connection…</span>
        <div className="flex flex-col gap-3.5">
          <div className={list}>
            {rowWidths.slice(0, rows).map((width) => (
              <div key={width} className={row}>
                <Skeleton className="h-4 w-20" />
                <Skeleton className={`h-4 justify-self-end ${width}`} />
              </div>
            ))}
          </div>
          {noteLines > 0 && (
            <div className="mcp-consent-note text-[14px]">
              {Array.from({ length: noteLines }, (_, line) => (
                <LineLoading key={line} className={line === noteLines - 1 ? "w-1/3" : "w-full"} />
              ))}
            </div>
          )}
        </div>
        <div className="mcp-consent-actions grid grid-cols-2 gap-2.5">
          <Skeleton className="h-9 w-full max-[740px]:h-11" />
          <Skeleton className="h-9 w-full max-[740px]:h-11" />
        </div>
      </div>
    </McpConsentLayout>
  );
}

export const consentDestination = (redirectUri: string | null): string | undefined => {
  if (redirectUri === null || redirectUri.length === 0) return undefined;
  const target = URL.parse(redirectUri);
  if (target === null) return undefined;
  return target.origin === "null" ? `${target.protocol}//` : target.origin;
};

export function McpConsentRow({
  label,
  htmlFor,
  children,
}: {
  readonly label: string;
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
  readonly icon?: IconSvgElement | undefined;
}

const OptionIcon = ({ icon, className }: { icon: IconSvgElement; className?: string }) => (
  <HugeiconsIcon
    icon={icon}
    size={16}
    strokeWidth={1.75}
    aria-hidden
    className={`shrink-0 text-muted-foreground ${className ?? ""}`}
  />
);

const entry =
  "flex items-start rounded-sm py-2 pr-8 pl-2 text-sm max-[740px]:min-h-11 max-[740px]:py-2.5";
const entryLines = "flex flex-col gap-0.5";

export function McpConsentSelect({
  id,
  value,
  options,
  onChange,
  disabled = false,
  busy = false,
  children,
}: {
  readonly id: string;
  readonly value: string;
  readonly options: readonly ConsentOption[];
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean | undefined;
  readonly busy?: boolean | undefined;
  readonly children?: ReactNode;
}) {
  const shown = options.find((option) => option.value === value);
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger
        id={id}
        aria-busy={busy || undefined}
        className="-mr-2 h-8 gap-1.5 border-0 bg-transparent px-2 text-[14px] font-normal shadow-none hover:bg-muted data-[state=open]:bg-muted max-[740px]:text-[14px] dark:bg-transparent"
      >
        <SelectValue>
          {shown?.icon === undefined ? (
            shown?.label
          ) : (
            <span className="flex items-center gap-1.5">
              <OptionIcon icon={shown.icon} />
              {shown.label}
            </span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="end" className="min-w-64">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} className="items-start py-2">
            <span className="flex items-start gap-2.5">
              {option.icon !== undefined && <OptionIcon icon={option.icon} className="mt-0.5" />}
              <span className={`${entryLines} text-left`}>
                <span className="font-medium">{option.label}</span>
                {option.detail !== undefined && (
                  <span className="text-[13px] text-muted-foreground">{option.detail}</span>
                )}
              </span>
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
    value: "automatic",
    label: "Automatic",
    detail: "Executor does not ask. Your agent's own permission prompts decide.",
    icon: FlashIcon,
  },
  {
    value: "model",
    label: "Through your agent",
    detail: "Your agent shows you the request and resumes the call.",
    icon: AiChat02Icon,
  },
  {
    value: "browser",
    label: "In your browser",
    detail: "You review the call on an Executor page.",
    icon: BrowserIcon,
  },
  {
    value: "native",
    label: "In your client",
    detail: "Your client prompts you, if it supports MCP prompts.",
    icon: LaptopIcon,
  },
];

export const preselectedApprovalMode = (named: ApprovalMode): ApprovalMode =>
  named === "model" ? "automatic" : named;

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

export function McpConsentTargetRows({
  target,
  mode,
  onMode,
  disabled,
}: {
  readonly target: GrantTarget;
  readonly mode?: ApprovalMode | undefined;
  readonly onMode?: ((mode: ApprovalMode) => void) | undefined;
  readonly disabled?: boolean | undefined;
}) {
  return (
    <>
      <McpConsentRow label="Access">
        {target.kind === "api"
          ? "Executor API"
          : target.connection === undefined
            ? "All apps"
            : "One of your connections"}
      </McpConsentRow>
      {target.kind === "mcp" && (
        <McpConsentApprovals mode={mode ?? target.mode} onMode={onMode} disabled={disabled} />
      )}
    </>
  );
}

const everyApp = "*";
const newConnection = "+";
const retryList = "!";
const appsLabel = (apps: readonly string[]) => {
  const shown = apps.slice(0, 3).join(", ");
  return apps.length > 3 ? `${shown} and ${apps.length - 3} more` : shown;
};

export type ConsentConnectionList =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly retry: () => void }
  | { readonly kind: "loaded"; readonly connections: readonly ConsentConnection[] };

function EntriesLoading() {
  return ["w-28", "w-20"].map((width) => (
    <div key={width} className={entry}>
      <span className={entryLines}>
        <span className="flex h-lh items-center">
          <Skeleton className={`h-3.5 ${width}`} />
        </span>
        <span className="flex h-lh items-center text-[13px]">
          <Skeleton className="h-3 w-40" />
        </span>
      </span>
    </div>
  ));
}

function ConnectionsLoading() {
  return (
    <div role="status" aria-label="Loading connections" className="flex flex-col">
      <EntriesLoading />
    </div>
  );
}

function ConnectionsFailed() {
  return (
    <div className="grid">
      <div aria-hidden className="invisible col-start-1 row-start-1 flex flex-col">
        <EntriesLoading />
      </div>
      <div className="col-start-1 row-start-1 flex flex-col justify-center">
        <p role="alert" className="m-0 px-2 py-1.5 text-[13px] text-destructive">
          Could not load your connections.
        </p>
        <SelectItem value={retryList}>Retry</SelectItem>
      </div>
    </div>
  );
}

export function McpConsentAccess({
  list,
  value,
  onChange,
  onNewConnection,
  disabled,
}: {
  readonly list: ConsentConnectionList;
  readonly value: GrantAccessChoice;
  readonly onChange: (value: GrantAccessChoice) => void;
  readonly onNewConnection: (connections: readonly ConsentConnection[]) => void;
  readonly disabled?: boolean | undefined;
}) {
  const connections = list.kind === "loaded" ? list.connections : [];
  const chosen =
    value.kind === "connection" && !connections.some((item) => item.id === value.id)
      ? value.id
      : undefined;
  return (
    <McpConsentRow label="Access" htmlFor="mcp-consent-access">
      <McpConsentSelect
        id="mcp-consent-access"
        value={value.kind === "all" ? everyApp : value.id}
        disabled={disabled}
        busy={list.kind === "loading"}
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
          ...(chosen === undefined
            ? []
            : list.kind === "loaded"
              ? [
                  {
                    value: chosen,
                    label: "Unavailable connection",
                    detail: "This connection no longer exists. Choose another.",
                  },
                ]
              : [{ value: chosen, label: "One of your connections" }]),
        ]}
        onChange={(next) => {
          if (next === newConnection) {
            if (list.kind === "loaded") onNewConnection(list.connections);
          } else if (next === retryList) {
            if (list.kind === "failed") list.retry();
          } else if (next === everyApp) onChange({ kind: "all" });
          else {
            const found = connections.find((item) => item.id === next);
            if (found !== undefined) onChange({ kind: "connection", id: found.id });
          }
        }}
      >
        {list.kind === "loading" && <ConnectionsLoading />}
        {list.kind === "failed" && <ConnectionsFailed />}
        <SelectSeparator />
        <SelectItem value={newConnection} disabled={list.kind !== "loaded"}>
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

export function McpConsentActions({
  decline = "Cancel",
  onDecline,
  onConnect,
  waiting,
  connectDisabled = false,
}: {
  readonly decline?: string;
  readonly onDecline: () => Promise<boolean>;
  readonly onConnect?: (() => Promise<boolean>) | undefined;
  readonly waiting: boolean;
  readonly connectDisabled?: boolean;
}) {
  const deciding = useRef(false);
  const [delivered, setDelivered] = useState<string>();
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
          (sent) => {
            if (sent) setDelivered(submitter.value);
            else deciding.current = false;
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
        disabled={waiting || delivered !== undefined}
        loading={delivered === declineDecision}
      >
        {decline}
      </Button>
      {onConnect !== undefined && (
        <Button
          type="submit"
          name="decision"
          value={connectDecision}
          disabled={connectDisabled || waiting || delivered !== undefined}
          loading={waiting || delivered === connectDecision}
        >
          Connect
        </Button>
      )}
    </form>
  );
}
