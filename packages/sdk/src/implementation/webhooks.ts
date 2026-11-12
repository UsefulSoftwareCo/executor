import { ProviderError } from "apps/contracts";
import { appProviderFailure } from "./provider-error.ts";
import { AppProviderFailed, mayHaveWritten } from "../contracts/tools.ts";
import { CurrentActor, type ResourceLifecycle } from "../contracts/executor.ts";
import type { WorkflowHostControls } from "apps/contracts";
import { CompleteWebhookSetup, WebhookSetupView } from "../contracts/webhook-setup.ts";
/** Persist intent before upstream work. Explicit reconciliation uses a bounded, compare-and-swap lease. */
import { Clock, type Crypto, Effect, Exit, Redacted, Result, Schema } from "effect";
import {
  ManualWebhookDescriptor,
  HostedWebhook,
  WebhookResponseData,
  type WebhookCommand,
} from "apps/contracts";
import {
  defaultWebhookLifecycleLimits,
  CreateWebhook,
  WebhookTarget,
  DeliverWebhook,
  WebhookSubscription,
  WebhookSubscriptionFields,
  WebhookApp,
  WebhookDefinitionsInput,
  WebhookNotFound,
  WebhookConflict,
  WebhookFailed,
} from "../contracts/webhooks.ts";
import {
  AppId,
  WebhookId,
  StorageError,
  RequestInvalid,
  type AccountId,
} from "../contracts/shared.ts";
import { SelectedAccounts } from "../contracts/apps.ts";
import type { Credentials } from "../contracts/storage.ts";
import type { Runtime } from "../contracts/runtime.ts";
import type { ExecutorDatabase } from "./storage.ts";
import type { makeOAuth } from "./oauth.ts";
import { database, query, transaction } from "./database.ts";
import { snapshot, resolve, resolveRemoval, type InvocationSnapshot } from "./tools.ts";
import { storedAccount } from "./accounts.ts";
import { lockApp, storedApp, storedVersion } from "./apps.ts";
import { backgroundAccounts } from "./background-accounts.ts";
import { setupCompleted } from "./webhook-sources.ts";
import { accountAuthority } from "./selection.ts";
import type { Declarations } from "./declarations.ts";
import { ownsDatabase } from "../contracts/apps.ts";
import { declarationLimits } from "../contracts/declarations.ts";

const StoredWebhook = Schema.Struct({
  ...WebhookSubscriptionFields.fields,
  registeredActor: Schema.NullOr(Schema.NonEmptyString),
  registeredAccounts: Schema.NullOr(SelectedAccounts),
  encrypted: Schema.RedactedFromValue(Schema.Uint8Array),
  revision: Schema.String,
  leaseUntil: Schema.Date,
})
  // Storage keeps the columns' former names.
  .pipe(Schema.encodeKeys({ version: "deployment" }));
/**
 * The actor and accounts an upstream registration ran as, saved before it reached the provider.
 * An app-account webhook's registration ran without an actor.
 */
interface Registration {
  readonly actor: string | null;
  readonly accounts: SelectedAccounts;
}
/** A subscription's registration, if one started; both columns are saved together. */
const registrationOf = (row: {
  readonly registeredActor: string | null;
  readonly registeredAccounts: SelectedAccounts | null;
}) =>
  row.registeredAccounts === null
    ? row.registeredActor === null
      ? Effect.succeed(undefined)
      : Effect.fail(new StorageError())
    : Effect.succeed<Registration | undefined>({
        actor: row.registeredActor,
        accounts: row.registeredAccounts,
      });
/** A source's managed subscription; one of an app-account source has no actor. */
const ManagedWebhook = Schema.Struct({
  ...CreateWebhook.fields,
  actor: Schema.NullOr(Schema.NonEmptyString),
});

const refusedRemoval =
  "Executor could not remove this registration: it is no longer allowed to use the accounts it was registered with. Remove the webhook for this callback URL at the provider, then confirm.";
const selectedIds = (selected: SelectedAccounts) =>
  Object.values(selected).flatMap((value) => (typeof value === "string" ? [value] : value));
/**
 * Accounts a subscription depends on: its source and the accounts its registration ran with,
 * which removing it needs. Deletion guards read them.
 */
const dependencies = (source: AccountId, registered: SelectedAccounts | null) =>
  [...new Set([source, ...(registered === null ? [] : selectedIds(registered))])].sort();
const PrivateState = Schema.Struct({
  config: Schema.Json,
  secret: Schema.String,
  state: Schema.Json,
  setup: Schema.optional(ManualWebhookDescriptor),
});
type Json = typeof Schema.Json.Type;
const isList = (value: Json): value is ReadonlyArray<Json> => Array.isArray(value);
/**
 * Where a compared value sits in a JSON Schema, which decides how it is put in one order. `schema`
 * is a schema; `schemas` a list of schemas; `schemaMap` an object of schemas; `items` a schema, or
 * before 2020-12 a list of them; `names` a list of property names; `dependencies` an object of
 * schemas or lists of names (Draft 7); `namesMap` an object of lists of names. `data` is compared
 * as written.
 */
type Position =
  | "data"
  | "schema"
  | "schemas"
  | "schemaMap"
  | "items"
  | "names"
  | "dependencies"
  | "namesMap";
/**
 * Every JSON Schema keyword whose value holds a schema or a list of property names, from Draft 7
 * to 2020-12. Other keywords hold data, such as `enum`, `const` and `default`.
 */
const keywords = new Map<string, Position>([
  ["additionalItems", "schema"],
  ["additionalProperties", "schema"],
  ["allOf", "schemas"],
  ["anyOf", "schemas"],
  ["contains", "schema"],
  ["contentSchema", "schema"],
  ["definitions", "schemaMap"],
  ["dependencies", "dependencies"],
  ["dependentRequired", "namesMap"],
  ["dependentSchemas", "schemaMap"],
  ["else", "schema"],
  ["if", "schema"],
  ["items", "items"],
  ["not", "schema"],
  ["oneOf", "schemas"],
  ["patternProperties", "schemaMap"],
  ["prefixItems", "schemas"],
  ["properties", "schemaMap"],
  ["propertyNames", "schema"],
  ["required", "names"],
  ["then", "schema"],
  ["unevaluatedItems", "schema"],
  ["unevaluatedProperties", "schema"],
  ["$defs", "schemaMap"],
]);
/** Where a member of an object at `position` sits. */
const memberOf = (position: Position, key: string, member: Json): Position => {
  switch (position) {
    case "schema":
      return keywords.get(key) ?? "data";
    case "schemaMap":
      return "schema";
    case "dependencies":
      return isList(member) ? "names" : "schema";
    case "namesMap":
      return "names";
    default:
      return "data";
  }
};
/**
 * How many objects and lists deep a compared value may nest, as deep as the apps package walks an
 * imported schema document (`documentKeys`).
 */
const comparedLevels = 64;
/**
 * How long a setup's compared text may be, in characters: the largest evaluated declaration a
 * Cloud isolate keeps (`declarationLimits.entryBytes`, which counts two bytes per character). The
 * webhooks declaration holds the state schema and the configuration's defaults.
 */
const comparedLength = declarationLimits.entryBytes / 2;
/** A list or an object being written, and the index of its next element or member. */
type Frame = (
  | { readonly elements: ReadonlyArray<Json> }
  | {
      readonly members: { readonly [name: string]: Json };
      /** The members' names in the order they are written. */
      readonly names: ReadonlyArray<string>;
    }
) & { readonly position: Position; readonly depth: number; next: number };
/**
 * The JSON text of `fields`, with every object's members in name order and every list of property
 * names at a schema position sorted, so values that differ only in those orders give the same
 * text. A reference such as `#/$defs/choice/anyOf/0` names a branch by its position, so every other
 * list keeps its order; a list of names holds no schema, so no valid reference resolves into it.
 *
 * `undefined` when a value nests deeper than `comparedLevels` or the text would be longer than
 * `comparedLength`. `length` is never more than the whole text's length: it counts what is written
 * and, for every open list or object, its brackets, separators and member names and one character
 * for each value it has not written yet. A list or object reserves all of that before it is opened
 * and before its names are sorted, and a string is checked before it is stringified. So the walk
 * visits at most `comparedLength` values and holds one frame per level, whatever the input. Listing
 * the keys of an object, which is already in memory, is the only step taken before its check.
 */
const comparedText = (
  fields: ReadonlyArray<readonly [name: string, value: Json, position: Position]>,
) => {
  const parts: Array<string> = [];
  let length = 0;
  const reserve = (characters: number) => (length += characters) <= comparedLength;
  const frames: Array<Frame> = [];
  // Writes a scalar, or opens a list or object, whose first character is already reserved.
  const start = (value: Json, position: Position, depth: number) => {
    if (typeof value !== "object" || value === null) {
      // A string's text is its quotes and at least its characters.
      if (typeof value === "string" && length + value.length + 1 > comparedLength) return false;
      const text = JSON.stringify(value);
      parts.push(text);
      return reserve(text.length - 1);
    }
    if (depth === comparedLevels) return false;
    const at = position === "items" ? (isList(value) ? "schemas" : "schema") : position;
    if (isList(value)) {
      // Brackets, and each element's first character and separator.
      if (!reserve(value.length === 0 ? 1 : 2 * value.length)) return false;
      let elements = value;
      if (at === "names" && value.every((name) => typeof name === "string")) {
        let names = length;
        for (const name of value) if ((names += name.length + 1) > comparedLength) return false;
        elements = value.toSorted();
      }
      const position = at === "schemas" ? "schema" : "data";
      frames.push({ elements, position, depth, next: 0 });
      parts.push("[");
      return true;
    }
    const names = Object.keys(value);
    // Brackets, and each member's quoted name, colon, first character of its value and separator.
    if (!reserve(names.length === 0 ? 1 : 5 * names.length)) return false;
    for (const name of names) if (!reserve(name.length)) return false;
    frames.push({ members: value, names: names.toSorted(), position: at, depth, next: 0 });
    parts.push("{");
    return true;
  };
  for (const [index, [name, value, position]] of fields.entries()) {
    const label = `${index === 0 ? "{" : ","}${JSON.stringify(name)}:`;
    parts.push(label);
    if (!reserve(label.length + 1) || !start(value, position, 0)) return undefined;
    for (let frame = frames.at(-1); frame !== undefined; frame = frames.at(-1)) {
      const next = frame.next++;
      const count = "names" in frame ? frame.names.length : frame.elements.length;
      if (next === count) {
        parts.push("names" in frame ? "}" : "]");
        frames.pop();
        continue;
      }
      if (next > 0) parts.push(",");
      if ("names" in frame) {
        const key = frame.names[next] ?? "";
        const member = frame.members[key] ?? null;
        const text = JSON.stringify(key);
        parts.push(text, ":");
        if (
          !reserve(text.length - key.length - 2) ||
          !start(member, memberOf(frame.position, key, member), frame.depth + 1)
        )
          return undefined;
      } else if (!start(frame.elements[next] ?? null, frame.position, frame.depth + 1))
        return undefined;
    }
  }
  parts.push("}");
  return reserve(1) ? parts.join("") : undefined;
};
/** A manual subscription's setup at the provider, and the configuration it serves. */
type Setup = {
  readonly setup: typeof ManualWebhookDescriptor.Type;
  readonly config: Json;
};
/**
 * Whether a person's setup at the provider still serves a version's manual declaration: the
 * provider holds the callback URL and the secret from the same source, the fields they entered fit
 * a state schema that accepts the same values, and the configuration is the same. Instructions may
 * change; they only guide a new setup.
 *
 * Every value it compares is in `text`, so each goes through `comparedText`'s bounds. A setup too
 * deep or too long to compare counts as changed, so the version gets a new setup, as every version
 * did before setups were carried.
 */
const sameSetup = (declared: Setup) => {
  const text = ({ setup, config }: Setup) =>
    comparedText([
      ["config", config, "data"],
      ["signingSecret", setup.signingSecret, "data"],
      ["stateSchema", setup.stateSchema, "schema"],
    ]);
  const expected = text(declared);
  return (saved: Setup) => expected !== undefined && text(saved) === expected;
};

/**
 * The host owns origin and authority. Each subscription pins its code and source account; every
 * callback resolves the actor's current accounts for the app's other requirements.
 */
export const makeWebhooks = (
  storage: ExecutorDatabase,
  runtime: Runtime,
  resolveAccount: ReturnType<typeof makeOAuth>["resolveSelected"],
  credentials: Credentials,
  crypto: Crypto.Crypto,
  origin: string | undefined,
  declarations: Declarations,
  workflows?: (state: InvocationSnapshot) => WorkflowHostControls,
  lifecycle?: ResourceLifecycle,
) => {
  const db = database(storage);
  const next = crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()));
  const metadata = (row: typeof StoredWebhook.Type) =>
    Schema.decodeUnknownEffect(WebhookSubscription)(row).pipe(
      Effect.mapError(() => new StorageError()),
    );
  const read = (input: { app: AppId; subscription: WebhookId }) =>
    Effect.gen(function* () {
      const row = yield* query(() =>
        db.findFirst("webhooks", {
          where: (b) => b.and(b("id", "=", input.subscription), b("app", "=", input.app)),
        }),
      );
      if (row === null) return yield* new WebhookNotFound();
      return yield* Schema.decodeUnknownEffect(StoredWebhook)(row).pipe(
        Effect.mapError(() => new StorageError()),
      );
    });
  const decrypt = (row: typeof StoredWebhook.Type) =>
    credentials.decrypt(row.id, row.encrypted).pipe(
      Effect.flatMap((value) => Schema.decodeUnknownEffect(PrivateState)(Redacted.value(value))),
      Effect.mapError(() => new StorageError()),
    );
  /** The subscription's pinned version and source, with the actor's accounts for the rest. */
  const subscriptionState = (row: typeof StoredWebhook.Type) =>
    Effect.gen(function* () {
      const accounts = yield* backgroundAccounts(db, lifecycle, {
        app: row.app,
        version: row.version,
        actor: row.actor ?? undefined,
        source: row.sourceAccount,
      });
      return yield* snapshot(db, { app: row.app, version: row.version, accounts });
    }).pipe(Effect.provideService(CurrentActor, row.actor ?? undefined));
  /**
   * The registration's pinned version and the accounts it ran with, as the actor it ran as.
   * Removing it uses only them: the subscription may have moved to another actor since, and the
   * actor's current links may no longer resolve every requirement.
   */
  const removalState = (row: typeof StoredWebhook.Type, registration: Registration) =>
    snapshot(db, {
      app: row.app,
      version: row.version,
      // Only an app-account webhook's registration runs without an actor, and without a caller.
      captured: {
        accounts: registration.accounts,
        scope: registration.actor === null ? "app" : "user",
      },
    }).pipe(Effect.provideService(CurrentActor, registration.actor ?? undefined));
  /**
   * Whether the product still lets the registration remove what it registered with every account
   * it ran with (`ResourceLifecycle.removalResolving`): the user accounts by the registration's
   * actor's use, and each app requirement's account by the app's authority over it, which outlives
   * its app link. A refusal is lasting until access changes, so removal waits for a person rather
   * than retrying.
   */
  const registrationUsable = (state: InvocationSnapshot, registration: Registration) =>
    Effect.gen(function* () {
      const { user, app: appUses } = accountAuthority(state.selections);
      if (lifecycle === undefined || (user.length === 0 && appUses.length === 0)) return true;
      const allowed = yield* lifecycle
        .removalResolving({ id: state.app.id, owner: state.app.owner }, user, appUses)
        .pipe(Effect.provideService(CurrentActor, registration.actor ?? undefined));
      return [...user, ...appUses.map(({ account }) => account)].every((account) =>
        allowed.has(account.id),
      );
    });
  /**
   * Save the actor and accounts a registration runs with before it reaches the provider, with
   * the accounts' dependency rows, under this attempt's claim.
   */
  const recordRegistration = (
    row: typeof StoredWebhook.Type,
    claim: string,
    accounts: SelectedAccounts,
  ) =>
    transaction(db, () =>
      Effect.gen(function* () {
        yield* query(() =>
          db.updateMany("webhooks", {
            where: (b) => b.and(b("id", "=", row.id), b("revision", "=", claim)),
            set: { registeredActor: row.actor, registeredAccounts: accounts },
          }),
        );
        const current = yield* read({ app: row.app, subscription: row.id });
        if (current.revision !== claim) return yield* new WebhookConflict();
        const existing = new Set(
          (yield* query(() =>
            db.findMany("webhookAccounts", {
              select: ["account"],
              where: (b) => b("subscription", "=", row.id),
            }),
          )).map((dependency) => String(dependency.account)),
        );
        for (const account of dependencies(row.sourceAccount, accounts))
          if (!existing.has(account)) {
            yield* storedAccount(db, account);
            yield* query(() =>
              db.create("webhookAccounts", {
                id: `${row.id}/${account}`,
                account,
                subscription: row.id,
              }),
            );
          }
      }),
    );
  const invoke = (
    row: typeof StoredWebhook.Type,
    command: WebhookCommand,
    known?: InvocationSnapshot,
  ) =>
    Effect.gen(function* () {
      const state = known ?? (yield* subscriptionState(row));
      const context = yield* resolve(state, resolveAccount).pipe(
        Effect.provideService(CurrentActor, state.actor),
      );
      return yield* call(row, command, state, context);
    });
  /** Run one webhook command of the app's code with resolved credentials. */
  const call = (
    row: typeof StoredWebhook.Type,
    command: WebhookCommand,
    state: InvocationSnapshot,
    context: Effect.Success<ReturnType<typeof resolve>>,
  ) =>
    runtime
      .webhook({
        app: row.app,
        build: state.version.build,
        hostApi: declarations.hostApi(state.version),
        database: ownsDatabase(state.version.requirements),
        ...context,
        ...(workflows === undefined ? {} : { workflowControls: workflows(state) }),
        command,
      })
      .pipe(
        Effect.mapError((error) =>
          Schema.is(ProviderError)(error)
            ? // Registering, completing, removing and handling a webhook may change the service.
              mayHaveWritten(AppProviderFailed, appProviderFailure(state, error))
            : new WebhookFailed({
                reason: command.operation === "webhook-handle" ? "delivery" : "definition",
              }),
        ),
      );
  /** Dashboard reads may reuse a recent evaluation; `live` evaluates the current build now. */
  const definitions = (state: InvocationSnapshot, live = false) =>
    Effect.gen(function* () {
      const failed = (error: unknown) =>
        Schema.is(ProviderError)(error)
          ? appProviderFailure(state, error)
          : new WebhookFailed({ reason: "definition" });
      const value = yield* declarations.read(
        "webhooks",
        state,
        (context) =>
          runtime
            .webhook({
              app: state.app.id,
              build: state.version.build,
              hostApi: declarations.hostApi(state.version),
              database: ownsDatabase(state.version.requirements),
              ...context,
              command: { operation: "webhooks" },
            })
            .pipe(Effect.mapError(failed)),
        { live },
      );
      return yield* Schema.decodeUnknownEffect(Schema.Array(HostedWebhook))(value).pipe(
        Effect.mapError(failed),
      );
    });
  /**
   * A source's live manual subscription to a definition, from any version, of the same source scope,
   * whose setup at the provider and configuration the active version's declaration still serves
   * (`sameSetup`). `replaced` reports live ones of the same source scope whose setup no longer fits,
   * which the new subscription replaces.
   */
  const carryable = (input: {
    readonly app: AppId;
    readonly actor: string | null;
    readonly name: string;
    readonly sourceAccount: AccountId;
    readonly config: typeof Schema.Json.Type;
    readonly setup: typeof ManualWebhookDescriptor.Type;
  }) =>
    Effect.gen(function* () {
      const serves = sameSetup({ setup: input.setup, config: input.config });
      const rows = yield* query(() =>
        db.findMany("webhooks", {
          where: (b) =>
            b.and(
              b("app", "=", input.app),
              b("sourceAccount", "=", input.sourceAccount),
              b("name", "=", input.name),
              b("status", "in", ["active", "setup-required"]),
            ),
        }),
      );
      let replaced = false;
      let carried: { row: typeof StoredWebhook.Type; saved: typeof PrivateState.Type } | undefined;
      for (const value of rows) {
        const row = yield* Schema.decodeUnknownEffect(StoredWebhook)(value).pipe(
          Effect.mapError(() => new StorageError()),
        );
        // Only a source's own subscriptions, of the definition's scope: an app-account webhook's
        // has no actor, and a user-account webhook's follows its source's actor.
        if (!row.key.startsWith("setup-") || (row.actor === null) !== (input.actor === null))
          continue;
        const saved = yield* decrypt(row);
        if (saved.setup === undefined || !serves({ setup: saved.setup, config: saved.config })) {
          replaced = true;
          continue;
        }
        // The completed setup is the one the provider delivers to; otherwise the newest.
        if (
          carried === undefined ||
          (row.status === "active" && carried.row.status !== "active") ||
          (row.status === carried.row.status && row.createdAt > carried.row.createdAt)
        )
          carried = { row, saved };
      }
      if (carried === undefined) return { carried, replaced };
      // The saved setup follows the version's, whose instructions may have changed.
      const encrypted = yield* credentials.encrypt(
        carried.row.id,
        Redacted.make({ ...carried.saved, setup: input.setup }),
      );
      return { carried: { row: carried.row, encrypted }, replaced };
    });
  const outsideTransaction = storage.reactivity.inTransaction.pipe(
    Effect.flatMap((inside) => (inside ? Effect.fail(new RequestInvalid()) : Effect.void)),
  );
  /**
   * Register or remove a subscription. `activation` binds a source's cleanup to the activation its
   * reconciliation claimed (see `create`): once another supersedes it, nothing is removed.
   */
  const reconcile = (input: typeof WebhookTarget.Type, remove = false, activation?: number) =>
    Effect.gen(function* () {
      yield* outsideTransaction;
      const parsed = yield* Schema.decodeUnknownEffect(WebhookTarget)(input).pipe(
        Effect.mapError(() => new RequestInvalid()),
      );
      const claim = yield* next;
      return yield* Effect.acquireUseRelease(
        transaction(db, () =>
          Effect.gen(function* () {
            // The app's lock orders this against activation, which takes it too.
            if (
              activation !== undefined &&
              (yield* lockApp(db, { app: parsed.app })).activatedSequence !== activation
            )
              return yield* new WebhookConflict();
            const row = yield* read(parsed);
            if (
              row.status === "stopped" ||
              (!remove && ["active", "setup-required", "disabled"].includes(row.status))
            )
              return row;
            // A disabled subscription waits for a person to confirm its removal at the provider.
            const manual =
              remove && (row.status === "disabled" || (yield* decrypt(row)).setup !== undefined);
            const now = yield* Clock.currentTimeMillis;
            if (row.leaseUntil.getTime() > now) return yield* new WebhookConflict();
            yield* query(() =>
              db.updateMany("webhooks", {
                where: (b) => b.and(b("id", "=", row.id), b("revision", "=", row.revision)),
                set: {
                  revision: claim,
                  leaseUntil: new Date(manual ? 0 : now + defaultWebhookLifecycleLimits.leaseMs),
                  ...(remove ? { status: manual ? "disabled" : "stopping" } : {}),
                },
              }),
            );
            const claimed = yield* read(parsed);
            if (claimed.revision !== claim) return yield* new WebhookConflict();
            return claimed;
          }),
        ),
        (row) =>
          Effect.gen(function* () {
            if (row.revision !== claim || row.status === "disabled") return yield* metadata(row);
            const stopping = row.status === "stopping";
            // The intent/lease commits before network I/O. A lost response leaves recoverable state.
            // Removal the registration's actor can no longer perform disables the subscription.
            let refused = false;
            const work = Effect.gen(function* () {
              const saved = yield* decrypt(row);
              const common = {
                name: row.name,
                config: saved.config,
                secret: saved.secret,
                callbackUrl: row.callbackUrl,
                subscriptionId: row.id,
                sourceAccount: row.sourceAccount,
              };
              let value: Effect.Success<ReturnType<typeof invoke>> | null = null;
              if (stopping) {
                // A registration that never started reached no provider: nothing to remove.
                const registration = yield* registrationOf(row);
                if (registration !== undefined) {
                  const state = yield* removalState(row, registration);
                  // The product can refuse before resolving or once a renewal settles; either is
                  // lasting, unlike a storage failure, which the next attempt retries.
                  const context = (yield* registrationUsable(state, registration))
                    ? yield* resolveRemoval(state, resolveAccount).pipe(
                        // The registration's actor, not the subscription's.
                        Effect.provideService(CurrentActor, state.actor),
                        Effect.catchTag("AccountUseRefused", () => Effect.succeed(undefined)),
                      )
                    : undefined;
                  if (context === undefined) refused = true;
                  else
                    value = yield* call(
                      row,
                      { operation: "webhook-unregister", ...common, state: saved.state },
                      state,
                      context,
                    );
                }
              } else {
                const state = yield* subscriptionState(row);
                yield* recordRegistration(row, claim, state.accounts);
                value = yield* invoke(row, { operation: "webhook-register", ...common }, state);
              }
              return yield* credentials.encrypt(
                row.id,
                Redacted.make({
                  config: saved.config,
                  secret: saved.secret,
                  state: stopping ? null : value,
                }),
              );
            }).pipe(
              Effect.timeout(defaultWebhookLifecycleLimits.lifecycleTimeoutMs),
              Effect.result,
            );
            const result = yield* work;
            yield* transaction(db, () =>
              Effect.gen(function* () {
                yield* query(() =>
                  db.updateMany("webhooks", {
                    where: (b) => b.and(b("id", "=", row.id), b("revision", "=", claim)),
                    set: {
                      leaseUntil: new Date(0),
                      failure: Result.isFailure(result)
                        ? stopping
                          ? "unregister"
                          : "register"
                        : null,
                      ...(Result.isSuccess(result)
                        ? refused
                          ? { status: "disabled", failure: null }
                          : { status: stopping ? "stopped" : "active", encrypted: result.success }
                        : {}),
                    },
                  }),
                );
                const current = yield* read(parsed);
                if (current.revision === claim && current.status === "stopped")
                  yield* query(() =>
                    db.deleteMany("webhookAccounts", {
                      where: (b) => b("subscription", "=", row.id),
                    }),
                  );
              }),
            );
            return yield* read(parsed).pipe(Effect.flatMap(metadata));
          }),
        (row, exit) =>
          row.revision !== claim || Exit.isSuccess(exit)
            ? Effect.void
            : transaction(db, () =>
                query(() =>
                  db.updateMany("webhooks", {
                    where: (b) => b.and(b("id", "=", row.id), b("revision", "=", claim)),
                    // Preserve registration/removal intent while releasing only
                    // this attempt's lease, including on interruption or defects.
                    set: { leaseUntil: new Date(0) },
                  }),
                ),
              ).pipe(Effect.orDie),
      );
    }).pipe(Effect.withSpan("sdk.webhooks.reconcile"));
  /**
   * Save a subscription and attempt its registration. A caller's repeated key returns its saved
   * subscription, and a stopped key stays stopped. A source's managed keys are derived from what it
   * registers, so once its subscription for a key stopped, registering that key again starts a new
   * one; the stopped subscription stays as history. One that is disabled or stopping still holds its
   * key and is returned as it is, never enabled again.
   *
   * A source's subscription is created for `activation`, the app's `activatedSequence` when its
   * reconciliation claimed the source. Every activation advances it, also one back to the same
   * version, so a reconciliation that another activation superseded writes nothing more, even when
   * the version it claimed is active again: its definitions and keys are of an earlier activation.
   */
  const create = (input: typeof ManagedWebhook.Type, activation?: number) =>
    Effect.gen(function* () {
      yield* outsideTransaction;
      const managed = activation !== undefined;
      // Only a source's managed subscription may have no actor: an app-account webhook.
      const parsed = yield* Schema.decodeUnknownEffect(managed ? ManagedWebhook : CreateWebhook)(
        input,
      ).pipe(Effect.mapError(() => new RequestInvalid()));
      const actor = parsed.actor ?? undefined;
      if (origin === undefined) return yield* new WebhookFailed({ reason: "unavailable" });
      const base = yield* Effect.try(() => new URL(origin)).pipe(
        Effect.mapError(() => new WebhookFailed({ reason: "unavailable" })),
      );
      if (
        !["https:", "http:"].includes(base.protocol) ||
        base.username ||
        base.password ||
        base.pathname !== "/" ||
        base.search ||
        base.hash
      )
        return yield* new WebhookFailed({ reason: "unavailable" });
      const app = yield* storedApp(db, parsed);
      if (managed && app.activatedSequence !== activation) return yield* new WebhookConflict();
      const version = yield* storedVersion(db, app);
      const sourceAccount = parsed.sourceAccount;
      const state = yield* backgroundAccounts(db, lifecycle, {
        app: app.id,
        version: version.id,
        actor,
        source: sourceAccount,
      }).pipe(
        Effect.flatMap((accounts) => snapshot(db, { app: app.id, version: version.id, accounts })),
        Effect.provideService(CurrentActor, actor),
      );
      const context = yield* resolve(state, resolveAccount).pipe(
        Effect.provideService(CurrentActor, actor),
      );
      const catalog = yield* runtime
        .webhook({
          app: parsed.app,
          build: state.version.build,
          hostApi: declarations.hostApi(state.version),
          database: ownsDatabase(state.version.requirements),
          ...context,
          command: { operation: "webhooks" },
        })
        .pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(HostedWebhook))),
          Effect.mapError((error) =>
            Schema.is(ProviderError)(error)
              ? appProviderFailure(state, error)
              : new WebhookFailed({ reason: "definition" }),
          ),
        );
      const hook = catalog.find((hook) => hook.name === parsed.name);
      if (hook === undefined) return yield* new WebhookFailed({ reason: "definition" });
      // An app-account webhook runs without an actor; a user-account webhook, as its actor.
      const required = Object.hasOwn(state.version.requirements.accounts, hook.account)
        ? state.version.requirements.accounts[hook.account]
        : undefined;
      if (required === undefined) return yield* new WebhookFailed({ reason: "definition" });
      if ((required.scope === "app") !== (actor === undefined))
        // A caller names an actor, so only the app's link of an account creates an app-account
        // webhook's subscription.
        return yield* new WebhookFailed(
          actor === undefined ? { reason: "input" } : { reason: "input", mismatch: "app-account" },
        );
      // The source must serve the definition's requirement.
      const selected = Object.hasOwn(state.accounts, hook.account)
        ? state.accounts[hook.account]
        : undefined;
      if (
        !(typeof selected === "string"
          ? selected === sourceAccount
          : selected?.includes(sourceAccount))
      )
        return yield* new WebhookFailed({ reason: "input", mismatch: "source" });
      const id = WebhookId.make(`whk_${yield* next}`);
      const callbackUrl = new URL(`/api/webhooks/${parsed.app}/${id}`, base).href;
      const secret = `${yield* next}${yield* next}`;
      const config = yield* runtime
        .webhook({
          app: parsed.app,
          build: state.version.build,
          hostApi: declarations.hostApi(state.version),
          database: ownsDatabase(state.version.requirements),
          ...context,
          command: {
            operation: "webhook-validate",
            name: parsed.name,
            config: parsed.config,
            secret,
            callbackUrl,
            subscriptionId: id,
            sourceAccount,
          },
        })
        .pipe(Effect.mapError(() => new WebhookFailed({ reason: "input", mismatch: "config" })));
      // A source's manual subscription keeps its callback URL, secret and entered fields on a new
      // version whose setup still serves them: a person copied those into the provider, which keeps
      // delivering to them. A changed setup needs a new one, and the old one is removed after.
      const manual =
        managed && hook.setup !== undefined
          ? yield* carryable({
              app: app.id,
              actor: actor ?? null,
              name: parsed.name,
              sourceAccount,
              config,
              setup: hook.setup,
            })
          : undefined;
      const carried = manual?.carried;
      if (manual !== undefined)
        yield* Effect.annotateCurrentSpan({
          "executor.webhooks.carried": carried !== undefined,
          "executor.webhooks.setup_changed": carried === undefined && manual.replaced,
        });
      const encrypted = yield* credentials.encrypt(
        id,
        Redacted.make({
          config,
          secret,
          state: null,
          ...(hook.setup === undefined ? {} : { setup: hook.setup }),
        }),
      );
      const revision = yield* next;
      const createdAt = new Date(yield* Clock.currentTimeMillis);
      const target = yield* transaction(db, () =>
        Effect.gen(function* () {
          // Serializes creation with app deletion and activation without holding a lock across
          // provider I/O.
          yield* query(() =>
            db.updateMany("apps", {
              where: (b) => b("id", "=", state.app.id),
              set: { createdAt: state.app.createdAt },
            }),
          );
          const current = yield* storedApp(db, { app: state.app.id });
          // A source's subscription needs the activation it claimed to be current; a caller's,
          // the version it was evaluated on to be active.
          if (
            managed
              ? current.activatedSequence !== activation
              : current.activeVersion !== version.id
          )
            return yield* new WebhookConflict();
          if (carried !== undefined) {
            if (carried.row.version === state.version.id) return carried.row.id;
            // Pinned to this version from now on, unless it changed since it was read. The
            // revision stays, so a setup page opened before the deploy can still complete it.
            yield* query(() =>
              db.updateMany("webhooks", {
                where: (b) =>
                  b.and(b("id", "=", carried.row.id), b("revision", "=", carried.row.revision)),
                set: { deployment: state.version.id, encrypted: carried.encrypted },
              }),
            );
            const saved = yield* read({ app: parsed.app, subscription: carried.row.id });
            if (saved.revision !== carried.row.revision || saved.version !== state.version.id)
              return yield* new WebhookConflict();
            return carried.row.id;
          }
          const keyed = yield* query(() =>
            db.findMany("webhooks", {
              where: (b) =>
                b.and(
                  b("app", "=", parsed.app),
                  b("key", "=", parsed.key),
                  actor === undefined ? b("actor", "is", null) : b("actor", "=", actor),
                ),
            }),
          );
          // At most one subscription per key is not stopped; stopped ones are history.
          const existing =
            keyed.find((row) => row.status !== "stopped") ?? (managed ? undefined : keyed[0]);
          if (existing !== undefined) {
            const row = yield* read({ app: parsed.app, subscription: existing.id });
            const saved = yield* decrypt(row);
            if (
              row.name !== parsed.name ||
              row.sourceAccount !== sourceAccount ||
              !Schema.toEquivalence(Schema.Json)(saved.config, config)
            )
              return yield* new WebhookConflict();
            return row.id;
          }
          const accountIds = dependencies(sourceAccount, null);
          for (const account of accountIds) {
            const currentAccount = yield* storedAccount(db, account);
            yield* query(() =>
              db.updateMany("accounts", {
                where: (b) => b("id", "=", account),
                set: { createdAt: currentAccount.createdAt },
              }),
            );
            yield* storedAccount(db, account);
          }
          yield* query(() =>
            db.create("webhooks", {
              id,
              app: parsed.app,
              owner: state.app.owner,
              actor: actor ?? null,
              key: parsed.key,
              deployment: state.version.id,
              name: parsed.name,
              sourceAccount,
              callbackUrl,
              accounts: {},
              status: hook.setup === undefined ? "pending" : "setup-required",
              revision,
              leaseUntil: new Date(0),
              failure: null,
              encrypted,
              createdAt,
            }),
          );
          for (const account of accountIds)
            yield* query(() =>
              db.create("webhookAccounts", { id: `${id}/${account}`, account, subscription: id }),
            );
          return id;
        }),
      );
      return yield* reconcile({ app: parsed.app, subscription: target });
    }).pipe(Effect.withSpan("sdk.webhooks.create"));
  const webhooks = {
    get: (input: typeof WebhookTarget.Type) => read(input).pipe(Effect.flatMap(metadata)),
    confirmRemoval: (input: typeof WebhookTarget.Type) =>
      transaction(db, () =>
        Effect.gen(function* () {
          const row = yield* read(input);
          if (row.status === "stopped") return yield* metadata(row);
          if (row.status !== "disabled") return yield* new WebhookConflict();
          const revision = yield* next;
          yield* query(() =>
            db.updateMany("webhooks", {
              where: (b) => b.and(b("id", "=", row.id), b("revision", "=", row.revision)),
              set: { status: "stopped", revision },
            }),
          );
          const current = yield* read(input);
          if (current.revision !== revision) return yield* new WebhookConflict();
          yield* query(() =>
            db.deleteMany("webhookAccounts", { where: (b) => b("subscription", "=", row.id) }),
          );
          return yield* metadata(current);
        }),
      ),
    definitions: (input: typeof WebhookDefinitionsInput.Type) =>
      snapshot(db, input).pipe(Effect.flatMap((state) => definitions(state))),
    list: (input: typeof WebhookApp.Type) =>
      Effect.gen(function* () {
        yield* storedApp(db, input);
        const rows = yield* query(() =>
          db.findMany("webhooks", {
            where: (b) => b("app", "=", input.app),
            orderBy: ["id", "asc"],
          }),
        );
        return yield* Schema.decodeUnknownEffect(Schema.Array(WebhookSubscription))(rows).pipe(
          Effect.mapError(() => new StorageError()),
        );
      }),
    create: (input: typeof CreateWebhook.Type) => create(input),
    reconcile: (input: typeof WebhookTarget.Type) => reconcile(input),
    remove: (input: typeof WebhookTarget.Type) => reconcile(input, true),
    deliver: (input: typeof DeliverWebhook.Type) =>
      Effect.gen(function* () {
        yield* outsideTransaction;
        const parsed = yield* Schema.decodeUnknownEffect(DeliverWebhook)(input).pipe(
          Effect.mapError(() => new RequestInvalid()),
        );
        const row = yield* read(parsed);
        if (row.status === "stopping" || row.status === "disabled" || row.status === "stopped")
          return yield* new WebhookFailed({ reason: "inactive" });
        const saved = yield* decrypt(row);
        const url = new URL(row.callbackUrl);
        url.search = new URL(parsed.request.url).search;
        const value = yield* invoke(row, {
          operation: "webhook-handle",
          name: row.name,
          subscriptionId: row.id,
          sourceAccount: row.sourceAccount,
          config: saved.config,
          state: saved.state,
          secret: saved.secret,
          callbackUrl: row.callbackUrl,
          request: { ...parsed.request, url: url.href },
        });
        return yield* Schema.decodeUnknownEffect(WebhookResponseData)(value).pipe(
          Effect.mapError(() => new WebhookFailed({ reason: "delivery" })),
        );
      }).pipe(
        Effect.timeout(defaultWebhookLifecycleLimits.deliveryTimeoutMs),
        Effect.catchTag("TimeoutError", () => new WebhookFailed({ reason: "delivery" })),
        Effect.withSpan("sdk.webhooks.deliver"),
      ),
  };
  return {
    webhooks,
    /** Reconciliation creates and removes upstream registrations from the current definitions. */
    liveDefinitions: (state: InvocationSnapshot) => definitions(state, true),
    /** Create a source's managed subscription for the activation it claimed; see `create`. */
    createManaged: (input: typeof ManagedWebhook.Type, activation: number) =>
      create(input, activation),
    /** Remove a source's managed subscription while the activation it claimed is current. */
    removeManaged: (input: typeof WebhookTarget.Type, activation: number) =>
      reconcile(input, true, activation),
    /**
     * Point a subscription at its source's current actor. Callbacks resolve accounts at each
     * delivery, so the upstream registration is unchanged.
     */
    retarget: (subscription: WebhookId, actor: string | null) =>
      transaction(db, () =>
        Effect.gen(function* () {
          const row = yield* query(() =>
            db.findFirst("webhooks", { where: (b) => b("id", "=", subscription) }),
          );
          if (row === null) return yield* new WebhookNotFound();
          const current = yield* read({ app: row.app, subscription });
          if (current.actor === actor) return;
          yield* query(() =>
            db.updateMany("webhooks", {
              where: (b) => b("id", "=", subscription),
              set: { actor, accounts: {} },
            }),
          );
          if (current.status === "stopped") return;
          yield* query(() =>
            db.deleteMany("webhookAccounts", {
              where: (b) => b("subscription", "=", subscription),
            }),
          );
          for (const account of dependencies(current.sourceAccount, current.registeredAccounts))
            yield* query(() =>
              db.create("webhookAccounts", {
                id: `${subscription}/${account}`,
                account,
                subscription,
              }),
            );
        }),
      ),
    webhookSetup: {
      read: (input: typeof WebhookTarget.Type) =>
        Effect.gen(function* () {
          const row = yield* read(input);
          const saved = yield* decrypt(row);
          const subscription = yield* metadata(row);
          // A managed registration Executor could not remove waits for removal at the provider.
          if (saved.setup === undefined && row.status !== "disabled")
            return yield* new WebhookFailed({ reason: "input" });
          return yield* Schema.decodeUnknownEffect(Schema.toType(WebhookSetupView))(
            saved.setup === undefined
              ? { step: "remove", subscription, instructions: refusedRemoval }
              : row.status === "setup-required"
                ? {
                    step: "configure",
                    subscription,
                    revision: row.revision,
                    instructions: saved.setup.instructions,
                    stateSchema: saved.setup.stateSchema,
                    signingSecret:
                      saved.setup.signingSecret === "executor"
                        ? { source: "executor", value: Redacted.make(saved.secret) }
                        : { source: "provider" },
                  }
                : row.status === "disabled"
                  ? { step: "remove", subscription, instructions: saved.setup.instructions }
                  : { step: "done", subscription },
          ).pipe(Effect.mapError(() => new StorageError()));
        }),
      complete: (input: typeof CompleteWebhookSetup.Type) =>
        Effect.gen(function* () {
          yield* outsideTransaction;
          const parsed = yield* Schema.decodeUnknownEffect(Schema.toType(CompleteWebhookSetup))(
            input,
          ).pipe(Effect.mapError(() => new RequestInvalid()));
          const row = yield* read(parsed);
          const saved = yield* decrypt(row);
          if (saved.setup === undefined) return yield* new WebhookFailed({ reason: "input" });
          if (row.status === "active") return yield* metadata(row);
          if (row.status !== "setup-required" || row.revision !== parsed.revision)
            return yield* new WebhookConflict();
          if (saved.setup.signingSecret === "provider" && parsed.secret === undefined)
            return yield* new WebhookFailed({ reason: "input" });
          if (saved.setup.signingSecret === "executor" && parsed.secret !== undefined)
            return yield* new WebhookFailed({ reason: "input" });
          const secret = parsed.secret === undefined ? saved.secret : Redacted.value(parsed.secret);
          const state = yield* invoke(row, {
            operation: "webhook-complete",
            name: row.name,
            config: saved.config,
            subscriptionId: row.id,
            sourceAccount: row.sourceAccount,
            callbackUrl: row.callbackUrl,
            secret,
            state: Redacted.value(parsed.state),
          });
          const encrypted = yield* credentials.encrypt(
            row.id,
            Redacted.make({ config: saved.config, secret, state, setup: saved.setup }),
          );
          const revision = yield* next;
          return yield* transaction(db, () =>
            Effect.gen(function* () {
              // The app's lock comes first, as in reconciliation, which also changes subscriptions.
              yield* lockApp(db, { app: row.app });
              yield* query(() =>
                db.updateMany("webhooks", {
                  where: (b) =>
                    b.and(
                      b("id", "=", row.id),
                      b("revision", "=", row.revision),
                      b("status", "=", "setup-required"),
                    ),
                  set: { status: "active", encrypted, revision },
                }),
              );
              const current = yield* read(parsed);
              if (current.revision !== revision) return yield* new WebhookConflict();
              // A managed subscription belongs to its account's webhook source, which may be
              // waiting for this setup.
              if (current.key.startsWith("setup-"))
                yield* setupCompleted(db, { app: current.app, account: current.sourceAccount });
              return yield* metadata(current);
            }),
          );
        }),
    },
  };
};
