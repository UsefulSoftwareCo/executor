/** Shared schedule views consume typed atoms; products retain transport and permission choices. */
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

/**
 * The caller's own copy of one user declaration, or an app declaration's one schedule. Each
 * mutation atom belongs to one declaration.
 */
export interface ScheduleControls<E> {
  /** Configure the caller's copy, adding it when they have none, or the app schedule. */
  readonly configure: Atom.AtomResultFn<
    { readonly enabled: boolean; readonly approvalMode: "automatic" | "browser" },
    ScheduleSettings,
    E
  >;
}
/** Controls of one existing copy, addressed by its ID. */
export interface ScheduleCopyControls<E> {
  readonly update: Atom.AtomResultFn<
    { readonly enabled: boolean; readonly approvalMode: "automatic" | "browser" },
    ScheduleSettings,
    E
  >;
  readonly runNow: Atom.AtomResultFn<void, ScheduleSettings, E>;
  readonly remove: Atom.AtomResultFn<void, ScheduleSettings, E>;
}
/** Saved controls stay usable when live definition discovery fails. */
export interface ScheduleBindings<E> {
  readonly settings: Query<readonly ScheduleSettings[], E>;
  readonly definitions: Query<readonly AppSchedule[], E>;
  readonly controls?: {
    /** `app` configures an app declaration's one schedule; `user` the caller's own copy. */
    readonly declaration: (name: string, scope: AccountScope) => ScheduleControls<E>;
    readonly copy: (name: string, copy: ScheduleId) => ScheduleCopyControls<E>;
  };
  /**
   * Whether the caller controls the app's own schedules, which run without a caller with the
   * accounts linked for everyone. Only people who can edit the app do; the host still authorizes
   * every change.
   */
  readonly manageApp?: boolean;
}
/** Approval lists need only safe run metadata and product-supplied app names/links. */
export interface ApprovalListItem {
  readonly run: ScheduledRun;
  readonly app: { readonly id: AppId; readonly name: string };
}
