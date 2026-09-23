/** Shared schedule views consume typed atoms; products retain transport and permission choices. */
import type { AppSchedule, ScheduleSettings, ScheduledRun, AppId } from "@executor-js/sdk";
import type { Atom } from "effect/unstable/reactivity";
import type { Query } from "./dashboard.ts";

/** Each installed schedule gets its own mutation atoms, so sibling edits cannot cancel one another. */
export interface ScheduleControls<E> {
  readonly configure: Atom.AtomResultFn<
    { readonly enabled: boolean; readonly approvalMode: "automatic" | "browser" },
    ScheduleSettings,
    E
  >;
  readonly runNow: Atom.AtomResultFn<void, ScheduleSettings, E>;
}
/** Saved controls stay usable when live definition discovery fails. */
export interface ScheduleBindings<E> {
  readonly settings: Query<readonly ScheduleSettings[], E>;
  readonly definitions: Query<readonly AppSchedule[], E>;
  readonly controls?: (name: string) => ScheduleControls<E>;
}
/** Approval lists need only safe run metadata and product-supplied app names/links. */
export interface ApprovalListItem {
  readonly run: ScheduledRun;
  readonly app: { readonly id: AppId; readonly name: string };
}
