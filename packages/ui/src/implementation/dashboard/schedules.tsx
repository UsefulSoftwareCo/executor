import { EmptyState } from "./empty-state.tsx";
import { Skeleton } from "../components/skeleton.tsx";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Cause, Exit, Option, Schema } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  AccountRequired,
  ScheduleApprovalMode,
  type AppSchedule,
  type ScheduleSettings,
} from "@executor-js/sdk";
import { useState, type ComponentType, type ReactNode } from "react";
import type { FailureProps } from "../../contracts/dashboard.ts";
import type { ScheduleBindings, ScheduleControls } from "../../contracts/schedules.ts";
import { QueryView, useDashboard, useQuery } from "./context.tsx";
import { Alert } from "../components/alert.tsx";
import { Button } from "../components/button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select.tsx";

type Row = {
  readonly name: string;
  readonly timing: AppSchedule["timing"];
  readonly declared: boolean;
  readonly settings: ScheduleSettings | undefined;
};
const timingText = (timing: Row["timing"]) => {
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
  bindings,
  Failure,
}: {
  readonly bindings: ScheduleBindings<E>;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
}) {
  const discovery = useQuery(bindings.definitions);
  return (
    <SchedulesLayout>
      <QueryView query={bindings.settings} Failure={Failure} pending={<SchedulesPending />}>
        {(saved) => (
          <ScheduleList saved={saved} discovery={discovery} bindings={bindings} Failure={Failure} />
        )}
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
          Schedules run with this app’s selected accounts. New schedules start paused.
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
  saved,
  discovery,
  bindings,
  Failure,
}: {
  readonly saved: readonly ScheduleSettings[];
  readonly discovery: ReturnType<typeof useQuery<readonly AppSchedule[], E>>;
  readonly bindings: ScheduleBindings<E>;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
}) {
  const rows = new Map<string, Row>();
  for (const setting of saved)
    rows.set(setting.name, {
      name: setting.name,
      timing: setting.timing,
      settings: setting,
      declared: false,
    });
  if (Option.isSome(discovery.data))
    for (const definition of discovery.data.value)
      rows.set(definition.name, {
        name: definition.name,
        timing: definition.timing,
        settings: rows.get(definition.name)?.settings,
        declared: true,
      });
  const discoveryView = AsyncResult.match(discovery.result, {
    onInitial: () => ({
      error: null,
      empty: <SchedulesPending />,
    }),
    onSuccess: () => ({
      error: null,
      empty: (
        <EmptyState title="No schedules yet">
          Add a schedule to this app’s source to run tasks automatically.
        </EmptyState>
      ),
    }),
    onFailure: (failure) => ({
      error: <DiscoveryFailure cause={failure.cause} retry={discovery.refresh} Failure={Failure} />,
      empty: null,
    }),
  });
  return (
    <div className="space-y-4">
      {discoveryView.error}
      {rows.size === 0 ? (
        discoveryView.empty
      ) : (
        <div className="divide-y rounded-lg border">
          {[...rows.values()]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((row) => (
              <div key={row.name} className="flex flex-wrap items-center justify-between gap-4 p-4">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-medium break-words">{row.name}</h3>
                    <span className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground">
                      {row.settings?.activeRun
                        ? "Run active"
                        : row.settings?.enabled
                          ? "Enabled"
                          : "Paused"}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">{timingText(row.timing)}</p>
                  {row.settings?.enabled && row.settings.nextAt && (
                    <p className="text-xs text-muted-foreground">
                      Next: {row.settings.nextAt.toLocaleString()}
                    </p>
                  )}
                </div>
                {bindings.controls && (
                  <Controls row={row} actions={bindings.controls(row.name)} Failure={Failure} />
                )}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function DiscoveryFailure<E>({
  cause,
  retry,
  Failure,
}: FailureProps<E> & {
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
}) {
  const { AppLink } = useDashboard();
  const error = Cause.findErrorOption(cause);
  if (Option.isSome(error) && Schema.is(AccountRequired)(error.value)) {
    return (
      <Alert className="flex flex-wrap items-center justify-between gap-4 p-6">
        <div>
          <h3 className="text-sm font-medium">Choose accounts to load schedules</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            This app needs an account selected before its schedules can load.
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

function Controls<E>({
  row,
  actions,
  Failure,
}: {
  readonly row: Row;
  readonly actions: ScheduleControls<E>;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
}) {
  const configure = useAtomSet(actions.configure, { mode: "promiseExit" });
  const run = useAtomSet(actions.runNow, { mode: "promiseExit" });
  const saving = useAtomValue(actions.configure).waiting,
    starting = useAtomValue(actions.runNow).waiting;
  const [error, setError] = useState<Cause.Cause<E>>();
  const enabled = row.settings?.enabled ?? false;
  const approvalMode = row.settings?.approvalMode ?? "automatic";
  const change = async (enabled: boolean, approvalMode: "automatic" | "browser") => {
    setError(undefined);
    const result = await configure({ enabled, approvalMode });
    if (Exit.isFailure(result)) setError(result.cause);
  };
  return (
    <div className="flex max-w-full flex-wrap items-center gap-2">
      <Select
        value={approvalMode}
        disabled={saving || starting || (!row.declared && !row.settings)}
        onValueChange={(value) => {
          if (Schema.is(ScheduleApprovalMode)(value)) void change(enabled, value);
        }}
      >
        <SelectTrigger aria-label={`Approvals for ${row.name}`} className="w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="automatic">Skip approvals</SelectItem>
          <SelectItem value="browser">Browser approvals</SelectItem>
        </SelectContent>
      </Select>
      <Button
        size="sm"
        variant="outline"
        disabled={saving || starting || (!enabled && !row.declared)}
        onClick={() => {
          void change(!enabled, approvalMode);
        }}
      >
        {enabled ? "Pause" : "Enable"}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={
          saving || starting || !enabled || row.settings?.activeRun !== null || !row.declared
        }
        onClick={async () => {
          setError(undefined);
          const result = await run();
          if (Exit.isFailure(result)) setError(result.cause);
        }}
      >
        Run now
      </Button>
      {error && (
        <div className="w-full">
          <Failure cause={error} />
        </div>
      )}
    </div>
  );
}
