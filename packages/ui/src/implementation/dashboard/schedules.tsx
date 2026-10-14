import { LocalTime } from "../components/local-time.tsx";
import { EmptyState } from "./empty-state.tsx";
import { Skeleton } from "../components/skeleton.tsx";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Cause, Exit, Option, Schema } from "effect";
import { AsyncResult } from "effect/reactivity";
import {
  AccountRequired,
  ScheduleApprovalMode,
  type AccountScope,
  type AppSchedule,
  type App,
  type ScheduleSettings,
} from "@executor-js/sdk";
import { useState, type ComponentType, type ReactNode } from "react";
import type { FailureProps } from "../../contracts/dashboard.ts";
import {
  type ScheduleBindings,
  type ScheduleControls,
  type ScheduleCopyControls,
} from "../../contracts/schedules.ts";
import { QueryView, useDashboard, useQuery } from "./context.tsx";
import { Alert } from "../components/alert.tsx";
import { DisabledTooltip } from "../components/disabled-tooltip.tsx";
import { Button } from "../components/button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select.tsx";

type Declaration = {
  readonly name: string;
  /** `app`: one schedule, run without a caller with the app's accounts, that its editors control. */
  readonly scope: AccountScope;
  readonly timing: AppSchedule["timing"];
  readonly declared: boolean;
  /**
   * The signed-in member's own copy, or the app schedule; without one the declaration is paused
   * for them, or for the app.
   */
  readonly copy: ScheduleSettings | undefined;
};
type ApprovalMode = ScheduleSettings["approvalMode"];
const timingText = (timing: Declaration["timing"]) => {
  if (timing.kind === "cron") return `${timing.calendar.expression} · ${timing.calendar.timezone}`;
  const [amount, unit] =
    timing.milliseconds % 3_600_000 === 0
      ? [timing.milliseconds / 3_600_000, "hour"]
      : timing.milliseconds % 60_000 === 0
        ? [timing.milliseconds / 60_000, "minute"]
        : [timing.milliseconds / 1000, "second"];
  return `Every ${amount} ${unit}${amount === 1 ? "" : "s"}`;
};
/** Compact shared controls. No organization model or role checks enter this view. */
export function AppSchedules<E>({
  app,
  canEdit,
  ...props
}: {
  readonly app: App;
  readonly canEdit: boolean;
  /** Whose copy the tab shows: the signed-in member's. Undefined when the host has one member. */
  readonly actor: string | undefined;
  readonly bindings: ScheduleBindings<E>;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
}) {
  const { AppLink } = useDashboard();
  if (app.activeDeployment === null)
    return (
      <SchedulesLayout>
        <EmptyState
          title="No deployment yet"
          action={
            <Button
              asChild
              disabledReason={
                canEdit
                  ? undefined
                  : "You need permission to edit this app’s source to deploy schedules."
              }
            >
              <AppLink app={app.id} view="source">
                Open source
              </AppLink>
            </Button>
          }
        >
          {canEdit
            ? "Deploy this app to load its schedules."
            : "The app owner needs to deploy this app before its schedules are available."}
        </EmptyState>
      </SchedulesLayout>
    );
  return <LiveSchedules {...props} app={app} canEdit={canEdit} />;
}
type ListProps<E> = {
  readonly app: App;
  readonly canEdit: boolean;
  readonly actor: string | undefined;
  readonly bindings: ScheduleBindings<E>;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
};
function LiveSchedules<E>(props: ListProps<E>) {
  const { bindings, Failure } = props;
  const discovery = useQuery(bindings.definitions);
  return (
    <SchedulesLayout>
      <QueryView query={bindings.settings} Failure={Failure} pending={<SchedulesPending />}>
        {(saved) => <ScheduleList {...props} saved={saved} discovery={discovery} />}
      </QueryView>
    </SchedulesLayout>
  );
}

/** Metadata and schedule reads share one frame and a neutral loading state. */
export function AppSchedulesLoading() {
  return (
    <SchedulesLayout>
      <SchedulesPending />
    </SchedulesLayout>
  );
}

function SchedulesLayout({ children }: { readonly children: ReactNode }) {
  return (
    <section className="w-full">
      <div className="space-y-4 p-7 max-[740px]:p-4">
        <p className="text-sm text-muted-foreground">
          Your schedules run as you, with the accounts you linked to this app. Change them in the
          app’s Accounts tab.
        </p>
        {children}
      </div>
    </section>
  );
}

function SchedulesPending() {
  return (
    <div role="status" aria-label="Loading schedules" className="divide-y rounded-lg border">
      {Array.from({ length: 3 }, (_, i) => (
        <div aria-hidden key={i} className="flex flex-wrap items-center justify-between gap-4 p-4">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-36" />
              <Skeleton className="h-6 w-14" />
            </div>
            <Skeleton className="h-4 w-48" />
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-8 w-20" />
          </div>
        </div>
      ))}
      <span className="sr-only">Loading schedules…</span>
    </div>
  );
}

function ScheduleList<E>({
  app,
  canEdit,
  actor,
  saved,
  discovery,
  bindings,
  Failure,
}: ListProps<E> & {
  readonly saved: readonly ScheduleSettings[];
  readonly discovery: ReturnType<typeof useQuery<readonly AppSchedule[], E>>;
}) {
  const { AppLink } = useDashboard();
  const declarations = new Map<string, Declaration>();
  for (const setting of saved) {
    // The app schedule has no actor; other members' copies are theirs.
    if (setting.actor !== null && actor !== undefined && setting.actor !== actor) continue;
    declarations.set(setting.name, {
      name: setting.name,
      scope: setting.actor === null ? "app" : "user",
      timing: setting.timing,
      declared: false,
      copy: setting,
    });
  }
  if (Option.isSome(discovery.data))
    for (const definition of discovery.data.value) {
      const scope = definition.scope ?? "user";
      const saved = declarations.get(definition.name);
      declarations.set(definition.name, {
        name: definition.name,
        scope,
        timing: definition.timing,
        declared: true,
        // A copy saved in the other scope is not this declaration's.
        copy: saved?.scope === scope ? saved.copy : undefined,
      });
    }
  const appSchedules = [...declarations.values()].some((item) => item.scope === "app");
  const discoveryView = AsyncResult.match(discovery.result, {
    onInitial: () => ({
      error: null,
      empty: <SchedulesPending />,
    }),
    onSuccess: () => ({
      error: null,
      empty: (
        <EmptyState
          title="No schedules yet"
          action={
            <Button
              asChild
              variant="outline"
              disabledReason={
                canEdit
                  ? undefined
                  : "You need permission to edit this app’s source to add schedules."
              }
            >
              <AppLink app={app.id} view="source">
                Open source
              </AppLink>
            </Button>
          }
        >
          {canEdit
            ? "Add a schedule to this app’s source to run tasks automatically."
            : "The app owner can add schedules to run tasks automatically."}
        </EmptyState>
      ),
    }),
    onFailure: (failure) => ({
      error: (
        <DiscoveryFailure
          app={app}
          cause={failure.cause}
          retry={discovery.refresh}
          Failure={Failure}
        />
      ),
      empty: null,
    }),
  });
  return (
    <div className="space-y-4">
      {appSchedules && (
        <p className="text-sm text-muted-foreground">
          App schedules run as the app, with the accounts linked for everyone.
        </p>
      )}
      {discoveryView.error}
      {declarations.size === 0 ? (
        discoveryView.empty
      ) : (
        <div className="divide-y rounded-lg border">
          {[...declarations.values()]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((declaration) => (
              <DeclarationRow
                key={declaration.name}
                app={app}
                declaration={declaration}
                bindings={bindings}
                Failure={Failure}
              />
            ))}
        </div>
      )}
    </div>
  );
}

const noControls = "You need permission to use this app to change schedules.";
const noAppControls = "Only people who can edit this app can change its app schedules.";

/** The state a member's copy is in; a member without a copy has the declaration paused. */
const copyState = (copy: ScheduleSettings | undefined) =>
  copy === undefined
    ? "Paused"
    : copy.activeRun
      ? "Run active"
      : copy.accountRequired !== undefined
        ? "Account required"
        : copy.reconnectAccount !== undefined
          ? "Waiting for reconnect"
          : copy.enabled
            ? "Enabled"
            : "Paused";

/** One declaration with the signed-in member's own copy of it. */
function DeclarationRow<E>({
  app,
  declaration,
  bindings,
  Failure,
}: {
  readonly app: App;
  readonly declaration: Declaration;
  readonly bindings: ScheduleBindings<E>;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
}) {
  const { AppLink } = useDashboard();
  const { name, copy, declared, scope } = declaration;
  const controls = scope === "app" && bindings.manageApp !== true ? undefined : bindings.controls;
  const reason = scope === "app" ? noAppControls : noControls;
  const requiredBy =
    copy?.accountRequired === undefined
      ? undefined
      : app.requirements.accounts[copy.accountRequired];
  const required =
    copy?.accountRequired === undefined
      ? undefined
      : (requiredBy?.definition.name ?? copy.accountRequired);
  const accountsLink = (
    <AppLink
      app={app.id}
      view="accounts"
      className="underline underline-offset-2 hover:text-foreground"
    >
      View accounts
    </AppLink>
  );
  return (
    <div
      aria-label={name}
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 p-4"
    >
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium break-words">{name}</h3>
          <span className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground">
            {copyState(copy)}
          </span>
          <span className="text-xs text-muted-foreground">
            {scope === "app" ? "App schedule" : "Your schedule"}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{timingText(declaration.timing)}</p>
        {!declared && copy !== undefined && (
          <p className="text-xs text-muted-foreground">
            The current deployment does not declare this schedule.
          </p>
        )}
        {required !== undefined ? (
          <p className="text-xs text-muted-foreground">
            {requiredBy?.scope === "app"
              ? `Runs are skipped until a ${required} account is linked to this app for everyone.`
              : `Runs are skipped until you link a ${required} account to this app.`}{" "}
            {accountsLink}
          </p>
        ) : copy?.reconnectAccount !== undefined ? (
          <p className="text-xs text-muted-foreground">
            Runs are skipped until the account reconnects. {accountsLink}
          </p>
        ) : (
          copy?.enabled === true &&
          copy.nextAt && (
            <p className="text-xs text-muted-foreground">
              Next: <LocalTime value={copy.nextAt} />
            </p>
          )
        )}
      </div>
      {controls ? (
        <ScheduleActions
          name={name}
          copy={copy}
          declared={declared}
          approvals={scope === "user"}
          configure={controls.declaration(name, scope)}
          actions={copy === undefined ? undefined : controls.copy(name, copy.id)}
          Failure={Failure}
        />
      ) : (
        <div className="flex max-w-full flex-wrap items-center gap-2">
          {scope === "user" && (
            <DisabledTooltip reason={reason}>
              <Select value={copy?.approvalMode ?? "automatic"} disabled>
                <SelectTrigger aria-label={`Approvals for ${name}`} className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="automatic">Skip approvals</SelectItem>
                  <SelectItem value="browser">Browser approvals</SelectItem>
                </SelectContent>
              </Select>
            </DisabledTooltip>
          )}
          <Button size="sm" variant="outline" disabledReason={reason}>
            {copy?.enabled === true ? "Pause" : "Enable"}
          </Button>
        </div>
      )}
    </div>
  );
}

function DiscoveryFailure<E>({
  app,
  cause,
  retry,
  Failure,
}: FailureProps<E> & {
  readonly app: App;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
}) {
  const { AppLink } = useDashboard();
  const error = Cause.findErrorOption(cause);
  if (Option.isSome(error) && Schema.is(AccountRequired)(error.value)) {
    // An app requirement is filled by the accounts linked for everyone, not by the caller's links.
    const forEveryone = app.requirements.accounts[error.value.slot]?.scope === "app";
    return (
      <Alert className="flex flex-wrap items-center justify-between gap-4 p-6">
        <div>
          <h3 className="text-sm font-medium">Link an account to load schedules</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {forEveryone
              ? "This app needs an account linked for everyone before its schedules can load."
              : "This app needs a linked account before its schedules can load."}
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <AppLink app={error.value.app} view="accounts">
            View accounts
          </AppLink>
        </Button>
      </Alert>
    );
  }
  return <Failure cause={cause} {...(retry ? { retry } : {})} />;
}

/**
 * The member's controls for their copy, or an editor's for the app schedule. Enabling configures
 * the copy, adding it when there is none; pausing, running, changing approvals and removing act on
 * the existing copy. App schedules run only mutations without approval, so they have no approval
 * choice.
 */
function ScheduleActions<E>({
  name,
  copy,
  declared,
  approvals,
  configure,
  actions,
  Failure,
}: {
  readonly name: string;
  readonly copy: ScheduleSettings | undefined;
  readonly declared: boolean;
  readonly approvals: boolean;
  readonly configure: ScheduleControls<E>;
  readonly actions: ScheduleCopyControls<E> | undefined;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
}) {
  const enable = useAtomSet(configure.configure, { mode: "promiseExit" });
  const enabling = useAtomValue(configure.configure).waiting;
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>(copy?.approvalMode ?? "automatic");
  const [error, setError] = useState<Cause.Cause<E>>();
  const act = async (result: Promise<Exit.Exit<unknown, E>>) => {
    setError(undefined);
    const exit = await result;
    if (Exit.isFailure(exit)) setError(exit.cause);
  };
  const failure = error && (
    <div className="w-full">
      <Failure cause={error} />
    </div>
  );
  if (copy === undefined || actions === undefined)
    return (
      <div className="flex max-w-full flex-wrap items-center gap-2">
        {approvals && (
          <ApprovalSelect
            name={name}
            value={approvalMode}
            disabled={enabling}
            onChange={setApprovalMode}
          />
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={enabling || !declared}
          onClick={() => {
            void act(enable({ enabled: true, approvalMode }));
          }}
        >
          Enable
        </Button>
        {failure}
      </div>
    );
  return (
    <CopyActions
      name={name}
      copy={copy}
      declared={declared}
      approvals={approvals}
      enable={() => act(enable({ enabled: true, approvalMode: copy.approvalMode }))}
      enabling={enabling}
      actions={actions}
      act={act}
    >
      {failure}
    </CopyActions>
  );
}

function CopyActions<E>({
  name,
  copy,
  declared,
  approvals,
  enable,
  enabling,
  actions,
  act,
  children,
}: {
  readonly name: string;
  readonly copy: ScheduleSettings;
  readonly declared: boolean;
  readonly approvals: boolean;
  readonly enable: () => Promise<void>;
  readonly enabling: boolean;
  readonly actions: ScheduleCopyControls<E>;
  readonly act: (result: Promise<Exit.Exit<unknown, E>>) => Promise<void>;
  readonly children: ReactNode;
}) {
  const update = useAtomSet(actions.update, { mode: "promiseExit" });
  const run = useAtomSet(actions.runNow, { mode: "promiseExit" });
  const remove = useAtomSet(actions.remove, { mode: "promiseExit" });
  const updating = useAtomValue(actions.update).waiting,
    starting = useAtomValue(actions.runNow).waiting,
    removing = useAtomValue(actions.remove).waiting;
  const busy = enabling || updating || starting || removing;
  return (
    <div className="flex max-w-full flex-wrap items-center gap-2">
      {approvals && (
        <ApprovalSelect
          name={name}
          value={copy.approvalMode}
          disabled={busy}
          onChange={(value) => void act(update({ enabled: copy.enabled, approvalMode: value }))}
        />
      )}
      {copy.enabled ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            void act(update({ enabled: false, approvalMode: copy.approvalMode }));
          }}
        >
          Pause
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !declared}
          onClick={() => {
            void enable();
          }}
        >
          Enable
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        disabled={busy || !copy.enabled || copy.activeRun !== null || !declared}
        onClick={() => {
          void act(run());
        }}
      >
        Run now
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => {
          void act(remove());
        }}
      >
        Remove
      </Button>
      {children}
    </div>
  );
}

function ApprovalSelect({
  name,
  value,
  disabled,
  onChange,
}: {
  readonly name: string;
  readonly value: ApprovalMode;
  readonly disabled: boolean;
  readonly onChange: (value: ApprovalMode) => void;
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (Schema.is(ScheduleApprovalMode)(next)) onChange(next);
      }}
    >
      <SelectTrigger aria-label={`Approvals for ${name}`} className="w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="automatic">Skip approvals</SelectItem>
        <SelectItem value="browser">Browser approvals</SelectItem>
      </SelectContent>
    </Select>
  );
}
