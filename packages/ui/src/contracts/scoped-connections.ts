import type { AccountId, AppId, ProfileId } from "@executor-js/sdk";
import type {
  ConnectionApp as StoredConnectionApp,
  ConnectionId,
  ConnectionInput,
  ConnectionTargetInput,
  ConnectionView,
} from "@executor-js/mcp-auth/connections";
import type { Atom } from "effect/reactivity";
import type { Query } from "./dashboard.ts";

/**
 * A connection's tool scope. Rules (all, read-only) include tools added later; selected names
 * never expand automatically.
 */
export type ConnectionTools = StoredConnectionApp["tools"];

/**
 * A connection's event scope. Omitted or `all` includes events the app adds later; selected names
 * never expand, and none selected means no events.
 */
export type ConnectionEvents = NonNullable<StoredConnectionApp["events"]>;

/** Accounts and saved profiles remain distinct selections, even when they use the same account. */
export type ConnectionTarget =
  | { readonly kind: "app" }
  | { readonly kind: "account"; readonly id: AccountId; readonly label: string }
  | { readonly kind: "profile"; readonly id: ProfileId; readonly label: string };

/** Stable UI identity never conflates an account with a profile or its app. */
export const connectionTargetKey = (target: ConnectionTarget): string =>
  target.kind === "app" ? "app" : `${target.kind}:${target.id}`;

/** Human-readable target names for summaries and saved connection details. */
export const connectionTargetLabel = (target: ConnectionTarget): string =>
  target.kind === "app" ? "No account needed" : target.label;

/** One app appears once per connection; its tool scope applies to every selected account. */
export interface ConnectionApp {
  readonly id: AppId;
  readonly name: string;
  readonly targets: readonly ConnectionTarget[];
  readonly tools: ConnectionTools;
  /** Omitted: every event the app declares, now or later. */
  readonly events?: ConnectionEvents;
}

/** Short summary used in rows, details, and the connection list. */
export const connectionToolsLabel = (tools: ConnectionTools): string =>
  tools.kind === "all"
    ? "All tools"
    : tools.kind === "readOnly"
      ? "Read-only tools"
      : `${tools.names.length.toLocaleString("en-US")} ${tools.names.length === 1 ? "tool" : "tools"}`;

/** Short summary of an event scope, for an app that declares events. */
export const connectionEventsLabel = (events: ConnectionEvents | undefined): string =>
  events === undefined || events.kind === "all"
    ? "All events"
    : events.names.length === 0
      ? "No events"
      : `${events.names.length.toLocaleString("en-US")} ${events.names.length === 1 ? "event" : "events"}`;

/** An editor draft. Its ID is chosen once so a retried create returns the same connection. */
export interface ConnectionDraft {
  readonly id: ConnectionId;
  readonly name: string;
  readonly apps: readonly ConnectionApp[];
}

const targetInput = (target: ConnectionTarget): ConnectionTargetInput =>
  target.kind === "app"
    ? target
    : target.kind === "profile"
      ? { kind: "profile", id: target.id }
      : { kind: "account", id: target.id };

/** The request for a complete draft. Undefined while any included app has no way to run. */
export const connectionInput = (draft: ConnectionDraft): ConnectionInput | undefined => {
  const apps: ConnectionInput["apps"][number][] = [];
  for (const app of draft.apps) {
    const [first, ...rest] = app.targets.map(targetInput);
    if (first === undefined) return undefined;
    apps.push({
      app: app.id,
      runsAs: [first, ...rest],
      tools: app.tools,
      ...(app.events === undefined ? {} : { events: app.events }),
    });
  }
  return { id: draft.id, name: draft.name.trim(), apps };
};

/** Create a new connection or replace an existing one's name and access. */
export interface ConnectionSave {
  readonly existing: boolean;
  readonly input: ConnectionInput;
}

/** Product bindings for the shared connections page. One renderer handles every failure. */
export interface ScopedConnectionBindings<EL, ES, ER> {
  readonly connections: Query<readonly ConnectionView[], EL>;
  readonly save: Atom.AtomResultFn<ConnectionSave, ConnectionView, ES>;
  readonly revoke: Atom.AtomResultFn<ConnectionId, void, ER>;
}
