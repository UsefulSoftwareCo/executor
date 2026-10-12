import { useId, type ReactNode } from "react";
import type { AccountId, App, Profile } from "@executor-js/sdk";
import { providerDisplayUrl, selectedIds, type AccountSummary } from "../../contracts/dashboard.ts";
import {
  connectionTargetKey,
  connectionTargetLabel,
  connectionEventsLabel,
  type ConnectionApp,
  type ConnectionEvents,
  type ConnectionTarget,
  type ConnectionTools,
} from "../../contracts/scoped-connections.ts";
import { Checkbox } from "../components/checkbox.tsx";
import { Button } from "../components/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select.tsx";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { ProviderIcon } from "./common.tsx";
import { accountContexts } from "./account-group.tsx";
import type { ConnectionToolPickerProps } from "./scoped-connections.tsx";

/** One way an app can run: a saved profile, or an account with the app's default setup. */
export interface Choice {
  readonly target: ConnectionTarget;
  readonly description: string;
  /** Underlying accounts, used to apply one account across many apps at once. */
  readonly accounts: readonly AccountId[];
}

/** Everything an app offers a connection, computed once per inventory rather than per render. */
export interface AppChoices {
  readonly app: App;
  /** Profiles first, then accounts that no single-account profile already covers. */
  readonly options: readonly Choice[];
  readonly needsAccount: boolean;
  readonly catalogProfiles: readonly Profile[];
}

export function appChoices(
  app: App,
  profiles: readonly Profile[],
  accounts: readonly AccountSummary[],
): AppChoices {
  const contexts = accountContexts(app, profiles);
  const requirements = Object.values(app.requirements.accounts);
  const accountLabel = (id: AccountId) => {
    const account = accounts.find((account) => account.id === id);
    return account === undefined ? "Account unavailable" : account.label || "Unnamed account";
  };
  const profileChoices: readonly Choice[] = contexts.flatMap((context) => {
    if (context.profile === undefined) return [];
    const ids = selectedIds(context.accounts);
    const names = ids.map(accountLabel).join(", ") || "No accounts";
    return [
      {
        target: { kind: "profile", id: context.profile.id, label: `${context.label} · ${names}` },
        description: "Saved profile",
        accounts: ids,
      },
    ];
  });
  // A profile that uses exactly one account already stands for that account.
  const covered = new Set(
    profileChoices.flatMap((choice) => (choice.accounts.length === 1 ? choice.accounts : [])),
  );
  const accountChoices: readonly Choice[] = accounts
    .filter(
      (account) =>
        !covered.has(account.id) &&
        requirements.some((requirement) => requirement.provider === account.provider),
    )
    .map((account) => ({
      target: { kind: "account", id: account.id, label: account.label || "Unnamed account" },
      description: "Default setup",
      accounts: [account.id],
    }));
  return {
    app,
    options: [...profileChoices, ...accountChoices],
    needsAccount: requirements.length > 0,
    catalogProfiles: contexts.flatMap((context) =>
      context.profile === undefined ? [] : [context.profile],
    ),
  };
}

/** The events an app's active deployment declares, by name. */
export const declaredEventNames = (app: App | undefined): readonly string[] =>
  Object.keys(app?.requirements.events ?? {}).toSorted();

/** Whether an app declares any event a connection could include. */
export const declaresEvents = (app: App | undefined) => declaredEventNames(app).length > 0;

/** A newly included app is ready immediately when there is exactly one way to run it. */
export function initialSelection(choices: AppChoices): ConnectionApp {
  const only = choices.options.length === 1 ? choices.options[0] : undefined;
  return {
    id: choices.app.id,
    name: choices.app.name,
    targets: !choices.needsAccount ? [{ kind: "app" }] : only === undefined ? [] : [only.target],
    tools: { kind: "all" },
  };
}

/** The way to run an app as one account alone; a saved profile wins over the default setup. */
export const accountOption = (choices: AppChoices, account: AccountId): Choice | undefined =>
  choices.options.find((choice) => choice.accounts.length === 1 && choice.accounts[0] === account);

/** The first unresolved problem, if any, that blocks saving this app. */
export function selectionIssue(choices: AppChoices, selection: ConnectionApp): string | undefined {
  const available = new Set(choices.options.map((choice) => connectionTargetKey(choice.target)));
  if (!choices.needsAccount) {
    return selection.tools.kind === "selected" && selection.tools.names.length === 0
      ? "Choose at least one tool"
      : undefined;
  }
  if (selection.targets.length === 0)
    return available.size === 0 ? "Connect an account first" : "Choose how it runs";
  if (selection.targets.some((target) => !available.has(connectionTargetKey(target))))
    return "An account is no longer available";
  if (selection.tools.kind === "selected" && selection.tools.names.length === 0)
    return "Choose at least one tool";
  return undefined;
}

/** Prefer a selected profile's catalog, then any saved profile, then the app's own catalog. */
function catalogProfile(choices: AppChoices, selection: ConnectionApp): Profile | undefined {
  const selected = selection.targets.flatMap((target) =>
    target.kind === "profile" ? [target.id] : [],
  );
  return (
    choices.catalogProfiles.find((profile) => selected.includes(profile.id)) ??
    choices.catalogProfiles[0]
  );
}

/** One dense row per app. Controls appear only once the app is included. */
export function ConnectionAppRow({
  choices,
  selection,
  expanded,
  onExpandedChange,
  onChange,
  renderTools,
  renderConnectAccount,
}: {
  readonly choices: AppChoices;
  readonly selection: ConnectionApp | undefined;
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly onChange: (selection: ConnectionApp | undefined) => void;
  readonly renderTools: (props: ConnectionToolPickerProps) => ReactNode;
  /** A host link to connect an account, shown when the app has none yet. */
  readonly renderConnectAccount?: (app: App) => ReactNode;
}) {
  const id = useId();
  const { app } = choices;
  const provider = Object.values(app.requirements.accounts)[0]?.definition;
  const issue = selection === undefined ? undefined : selectionIssue(choices, selection);
  const only = choices.options.length === 1 ? choices.options[0] : undefined;
  const setTools = (tools: ConnectionTools) => {
    if (selection !== undefined) onChange({ ...selection, tools });
  };
  const setEvents = (events: ConnectionEvents) => {
    if (selection !== undefined) onChange({ ...selection, events });
  };
  return (
    <div className={selection === undefined ? "" : "bg-muted/20"}>
      <div className="flex min-h-13 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 sm:flex-nowrap">
        <label
          htmlFor={id}
          className="flex min-w-0 flex-1 basis-56 cursor-pointer items-center gap-3"
        >
          <Checkbox
            id={id}
            checked={selection !== undefined}
            onCheckedChange={(checked) => {
              onChange(checked === true ? initialSelection(choices) : undefined);
              if (checked !== true) onExpandedChange(false);
            }}
          />
          <ProviderIcon name={provider?.name ?? app.name} url={providerDisplayUrl(provider)} />
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-medium" title={app.name}>
              {app.name}
            </span>
            <span
              className={`block truncate text-xs ${
                issue === undefined ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400"
              }`}
            >
              {renderConnectAccount !== undefined &&
              choices.needsAccount &&
              choices.options.length === 0
                ? "No connected accounts"
                : (issue ??
                  (!choices.needsAccount
                    ? "No account needed"
                    : choices.options.length === 0
                      ? "No connected accounts"
                      : only !== undefined
                        ? connectionTargetLabel(only.target)
                        : `${choices.options.length} ways to run`))}
            </span>
          </span>
        </label>
        {renderConnectAccount !== undefined &&
          choices.needsAccount &&
          choices.options.length === 0 && (
            // Outside the label so following the link never toggles the app.
            <span className="shrink-0">{renderConnectAccount(app)}</span>
          )}
        {selection !== undefined && (
          <div className="flex w-full min-w-0 items-center gap-2 pl-7 sm:w-auto sm:pl-0">
            {choices.needsAccount && (
              <AccountsPicker
                choices={choices}
                selection={selection}
                onChange={(targets) => onChange({ ...selection, targets })}
              />
            )}
            <Select
              value={selection.tools.kind}
              onValueChange={(value) => {
                if (value === "all") setTools({ kind: "all" });
                if (value === "readOnly") setTools({ kind: "readOnly" });
                if (value === "selected") {
                  setTools({ kind: "selected", names: [] });
                  onExpandedChange(true);
                }
              }}
            >
              <SelectTrigger
                size="sm"
                aria-label={`Tools for ${app.name}`}
                className="min-w-0 flex-1 text-xs sm:w-36 sm:flex-none"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All tools</SelectItem>
                <SelectItem value="readOnly">Read-only tools</SelectItem>
                <SelectItem value="selected">Specific tools</SelectItem>
              </SelectContent>
            </Select>
            {declaresEvents(app) && (
              <EventsPicker
                appName={app.name}
                names={declaredEventNames(app)}
                events={selection.events}
                onChange={setEvents}
              />
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={
                selection.tools.kind === "selected" ? "" : "hidden sm:invisible sm:inline-flex"
              }
              aria-label={expanded ? `Hide tools for ${app.name}` : `Show tools for ${app.name}`}
              aria-expanded={expanded}
              onClick={() => onExpandedChange(!expanded)}
            >
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                size={15}
                className={expanded ? "rotate-180" : ""}
              />
            </Button>
          </div>
        )}
      </div>
      {selection !== undefined && selection.tools.kind === "selected" && !expanded && (
        <button
          type="button"
          onClick={() => onExpandedChange(true)}
          className="-mt-1 mb-2 ml-[72px] text-xs text-muted-foreground hover:text-foreground"
        >
          {selection.tools.names.length.toLocaleString("en-US")} selected · Edit
        </button>
      )}
      {selection !== undefined && selection.tools.kind === "selected" && expanded && (
        <div className="mx-4 mb-3 overflow-hidden rounded-md border bg-background sm:ml-[72px]">
          {app.activeDeployment === null ? (
            <p className="px-4 py-6 text-xs text-muted-foreground">
              Deploy this app to choose individual tools.
            </p>
          ) : (
            renderTools({
              app,
              profile: catalogProfile(choices, selection),
              names: selection.tools.names,
              onChange: (names) => setTools({ kind: "selected", names }),
            })
          )}
        </div>
      )}
    </div>
  );
}

/** All of an app's events, including later ones, or exact names; none selected means none. */
function EventsPicker({
  appName,
  names,
  events,
  onChange,
}: {
  readonly appName: string;
  readonly names: readonly string[];
  readonly events: ConnectionEvents | undefined;
  readonly onChange: (events: ConnectionEvents) => void;
}) {
  const all = events === undefined || events.kind === "all";
  const selected = new Set(all ? names : events.names);
  const toggle = (name: string, checked: boolean) =>
    onChange({
      kind: "selected",
      names: checked
        ? [...selected, name].toSorted()
        : [...selected].filter((item) => item !== name),
    });
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Events for ${appName}`}
          className="min-w-0 flex-1 justify-between text-xs font-normal sm:w-32 sm:flex-none"
        >
          <span className="truncate">{connectionEventsLabel(events)}</span>
          <HugeiconsIcon icon={ArrowDown01Icon} size={14} className="shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-1.5" align="end">
        <h3 className="px-2 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">Events</h3>
        <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/60">
          <Checkbox
            checked={all}
            onCheckedChange={(checked) =>
              onChange(checked === true ? { kind: "all" } : { kind: "selected", names: [...names] })
            }
          />
          <span className="min-w-0">
            <span className="block truncate text-[13px]">All events</span>
            <span className="block truncate text-[11px] text-muted-foreground">
              Including events the app adds later
            </span>
          </span>
        </label>
        <div className="my-1 border-t" />
        {names.map((name) => (
          <label
            key={name}
            className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/60"
          >
            <Checkbox
              checked={selected.has(name)}
              disabled={all}
              onCheckedChange={(checked) => toggle(name, checked === true)}
            />
            <span className="truncate font-mono text-[12px]">{name}</span>
          </label>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function AccountsPicker({
  choices,
  selection,
  onChange,
}: {
  readonly choices: AppChoices;
  readonly selection: ConnectionApp;
  readonly onChange: (targets: readonly ConnectionTarget[]) => void;
}) {
  const selected = new Set(selection.targets.map(connectionTargetKey));
  const only = choices.options.length === 1 ? choices.options[0] : undefined;
  // The row's subtitle already names the only way to run it.
  if (only !== undefined && selected.has(connectionTargetKey(only.target))) return null;
  const label =
    selection.targets.length === 0
      ? "Runs as…"
      : selection.targets.length === 1 && selection.targets[0] !== undefined
        ? connectionTargetLabel(selection.targets[0])
        : `${selection.targets.length} setups`;
  const toggle = (target: ConnectionTarget, checked: boolean) => {
    const key = connectionTargetKey(target);
    onChange(
      checked
        ? [...selection.targets, target]
        : selection.targets.filter((item) => connectionTargetKey(item) !== key),
    );
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={choices.options.length === 0}
          className={`min-w-0 flex-1 justify-between text-xs font-normal sm:w-40 sm:flex-none ${
            selection.targets.length === 0 ? "text-amber-600 dark:text-amber-400" : ""
          }`}
        >
          <span className="truncate">{choices.options.length === 0 ? "No accounts" : label}</span>
          <HugeiconsIcon icon={ArrowDown01Icon} size={14} className="shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-1.5" align="end">
        <h3 className="px-2 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">Runs as</h3>
        {choices.options.map((choice) => {
          const key = connectionTargetKey(choice.target);
          return (
            <label
              key={key}
              className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/60"
            >
              <Checkbox
                checked={selected.has(key)}
                onCheckedChange={(checked) => toggle(choice.target, checked === true)}
              />
              <span className="min-w-0">
                <span className="block truncate text-[13px]">
                  {connectionTargetLabel(choice.target)}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {choice.description}
                </span>
              </span>
            </label>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
