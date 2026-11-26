import type {
  AccountScope,
  AppSchedule,
  ScheduleId,
  ScheduleSettings,
  ScheduledRun,
  AppId,
} from "@executor-js/sdk";
import type { Atom } from "effect/reactivity";
import type { Query } from "./dashboard.ts";

export interface ScheduleControls<E> {
  readonly configure: Atom.AtomResultFn<
    { readonly enabled: boolean; readonly approvalMode: "automatic" | "browser" },
    ScheduleSettings,
    E
  >;
}
export interface ScheduleCopyControls<E> {
  readonly update: Atom.AtomResultFn<
    { readonly enabled: boolean; readonly approvalMode: "automatic" | "browser" },
    ScheduleSettings,
    E
  >;
  readonly runNow: Atom.AtomResultFn<void, ScheduleSettings, E>;
  readonly remove: Atom.AtomResultFn<void, ScheduleSettings, E>;
}
export interface ScheduleBindings<E> {
  readonly settings: Query<readonly ScheduleSettings[], E>;
  readonly definitions: Query<readonly AppSchedule[], E>;
  readonly controls?: {
    readonly declaration: (name: string, scope: AccountScope) => ScheduleControls<E>;
    readonly copy: (name: string, copy: ScheduleId) => ScheduleCopyControls<E>;
  };
  readonly manageApp?: boolean;
}
export interface ApprovalListItem {
  readonly run: ScheduledRun;
  readonly app: { readonly id: AppId; readonly name: string };
}
