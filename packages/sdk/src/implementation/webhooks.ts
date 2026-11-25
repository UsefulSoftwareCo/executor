import { ProviderError } from "apps/contracts";
import { appProviderFailure } from "./provider-error.ts";
import { AppProviderFailed, mayHaveWritten } from "../contracts/tools.ts";
import { CurrentActor, type ResourceLifecycle } from "../contracts/executor.ts";
import type { WorkflowHostControls } from "apps/contracts";
import { CompleteWebhookSetup, WebhookSetupView } from "../contracts/webhook-setup.ts";
import { Clock, Effect, Exit, Redacted, Result, Schema } from "effect";
import type { HostCrypto } from "./host-crypto.ts";
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
  type UnremovableWebhooks,
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
import { RuntimeProtocolFailed, type Runtime } from "../contracts/runtime.ts";
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

const deliveryRefusals = {
  RequestInvalid: "request-invalid",
  WebhookNotFound: "not-found",
  StorageError: "storage",
  AppNotFound: "app-not-found",
  AppNotDeployed: "app-not-deployed",
  VersionNotFound: "version-not-found",
  AccountNotFound: "account-not-found",
  AccountRequired: "account-required",
  AccountSelectionInvalid: "account-selection-invalid",
  CredentialsError: "credentials",
  OAuthReconnectRequired: "oauth-reconnect-required",
  OAuthRenewalFailed: "oauth-renewal-failed",
  AppProviderFailed: undefined,
} as const;
const handlerErrors = {
  OpenapiResponseError: true,
  WorkflowFailure: true,
  ProviderError: true,
  McpError: true,
  SkillLoadFailed: true,
  HostRequestInvalid: true,
  HostDeclarationInvalid: true,
  HostAccountsInvalid: true,
  HostEvaluationFailed: true,
  HostToolNotFound: true,
  HostOperationNotFound: true,
  HostKindMismatch: true,
  HostOperationFailed: true,
  DatabaseLimitExceeded: true,
  HostInputInvalid: true,
  HostOutputInvalid: true,
  HostToolBlocked: true,
  HostToolApprovalRequired: true,
  HostToolPolicyFailed: true,
  ElicitationFailed: true,
  RuntimeBuildUnavailable: true,
  RuntimeProtocolFailed: true,
  RuntimeProtocolUnsupported: true,
} as const;
const handlerError = (tag: keyof typeof handlerErrors) => tag;
const refused = (refusal: string, attributes: Record<string, string> = {}) =>
  Effect.annotateCurrentSpan({ "executor.webhook.refusal": refusal, ...attributes });

const StoredWebhook = Schema.Struct({
  ...WebhookSubscriptionFields.fields,
  registeredActor: Schema.NullOr(Schema.NonEmptyString),
  registeredAccounts: Schema.NullOr(SelectedAccounts),
  encrypted: Schema.RedactedFromValue(Schema.Uint8Array),
  revision: Schema.String,
  leaseUntil: Schema.Date,
}).pipe(Schema.encodeKeys({ version: "deployment" }));
interface Registration {
  readonly actor: string | null;
  readonly accounts: SelectedAccounts;
}
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
const ManagedWebhook = Schema.Struct({
  ...CreateWebhook.fields,
  actor: Schema.NullOr(Schema.NonEmptyString),
});

const refusedRemoval =
  "Executor could not remove this registration: it is no longer allowed to use the accounts it was registered with. Remove the webhook for this callback URL at the provider, then confirm.";
const selectedIds = (selected: SelectedAccounts) =>
  Object.values(selected).flatMap((value) => (typeof value === "string" ? [value] : value));
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
type Position =
  | "data"
  | "schema"
  | "schemas"
  | "schemaMap"
  | "items"
  | "names"
  | "dependencies"
  | "namesMap";
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
const comparedLevels = 64;
const comparedLength = declarationLimits.entryBytes / 2;
type Frame = (
  | { readonly elements: ReadonlyArray<Json> }
  | {
      readonly members: { readonly [name: string]: Json };
      readonly names: ReadonlyArray<string>;
    }
) & { readonly position: Position; readonly depth: number; next: number };
const comparedText = (
  fields: ReadonlyArray<readonly [name: string, value: Json, position: Position]>,
) => {
  const parts: Array<string> = [];
  let length = 0;
  const reserve = (characters: number) => (length += characters) <= comparedLength;
  const frames: Array<Frame> = [];
  const start = (value: Json, position: Position, depth: number) => {
    if (typeof value !== "object" || value === null) {
      if (typeof value === "string" && length + value.length + 1 > comparedLength) return false;
      const text = JSON.stringify(value);
      parts.push(text);
      return reserve(text.length - 1);
    }
    if (depth === comparedLevels) return false;
    const at = position === "items" ? (isList(value) ? "schemas" : "schema") : position;
    if (isList(value)) {
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
type Setup = {
  readonly setup: typeof ManualWebhookDescriptor.Type;
  readonly config: Json;
};
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

export const makeWebhooks = (
  storage: ExecutorDatabase,
  runtime: Runtime,
  resolveAccount: ReturnType<typeof makeOAuth>["resolveSelected"],
  credentials: Credentials,
  crypto: HostCrypto,
  origin: string | undefined,
  declarations: Declarations,
  workflows?: (state: InvocationSnapshot) => WorkflowHostControls,
  lifecycle?: ResourceLifecycle,
) => {
  const db = database(storage);
  const next = crypto.random.uuidV4();
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
  const removalState = (row: typeof StoredWebhook.Type, registration: Registration) =>
    snapshot(db, {
      app: row.app,
      version: row.version,
      captured: {
        accounts: registration.accounts,
        scope: registration.actor === null ? "app" : "user",
      },
    }).pipe(Effect.provideService(CurrentActor, registration.actor ?? undefined));
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
        Effect.tapError((error) =>
          command.operation === "webhook-handle"
            ? refused(Schema.is(ProviderError)(error) ? "provider" : "handler", {
                "executor.webhook.handler_error": handlerError(error._tag),
                ...(Schema.is(RuntimeProtocolFailed)(error)
                  ? { "executor.webhook.runtime_failure": error.reason ?? "unreported" }
                  : {}),
              })
            : Effect.void,
        ),
        Effect.mapError((error) =>
          Schema.is(ProviderError)(error)
            ? mayHaveWritten(AppProviderFailed, appProviderFailure(state, error))
            : new WebhookFailed({
                reason: command.operation === "webhook-handle" ? "delivery" : "definition",
              }),
        ),
      );
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
        if (!row.key.startsWith("setup-") || (row.actor === null) !== (input.actor === null))
          continue;
        const saved = yield* decrypt(row);
        if (saved.setup === undefined || !serves({ setup: saved.setup, config: saved.config })) {
          replaced = true;
          continue;
        }
        if (
          carried === undefined ||
          (row.status === "active" && carried.row.status !== "active") ||
          (row.status === carried.row.status && row.createdAt > carried.row.createdAt)
        )
          carried = { row, saved };
      }
      if (carried === undefined) return { carried, replaced };
      const encrypted = yield* credentials.encrypt(
        carried.row.id,
        Redacted.make({ ...carried.saved, setup: input.setup }),
      );
      return { carried: { row: carried.row, encrypted }, replaced };
    });
  const outsideTransaction = storage.reactivity.inTransaction.pipe(
    Effect.flatMap((inside) => (inside ? Effect.fail(new RequestInvalid()) : Effect.void)),
  );
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
                const registration = yield* registrationOf(row);
                if (registration !== undefined) {
                  const state = yield* removalState(row, registration);
                  const context = (yield* registrationUsable(state, registration))
                    ? yield* resolveRemoval(state, resolveAccount).pipe(
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
                if (!selectedIds(state.accounts).includes(row.sourceAccount))
                  return yield* new WebhookFailed({ reason: "input", mismatch: "source" });
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
                    set: { leaseUntil: new Date(0) },
                  }),
                ),
              ).pipe(Effect.orDie),
      );
    }).pipe(Effect.withSpan("sdk.webhooks.reconcile"));
  const create = (input: typeof ManagedWebhook.Type, activation?: number) =>
    Effect.gen(function* () {
      yield* outsideTransaction;
      const managed = activation !== undefined;
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
      const required = Object.hasOwn(state.version.requirements.accounts, hook.account)
        ? state.version.requirements.accounts[hook.account]
        : undefined;
      if (required === undefined) return yield* new WebhookFailed({ reason: "definition" });
      if ((required.scope === "app") !== (actor === undefined))
        return yield* new WebhookFailed(
          actor === undefined ? { reason: "input" } : { reason: "input", mismatch: "app-account" },
        );
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
          yield* query(() =>
            db.updateMany("apps", {
              where: (b) => b("id", "=", state.app.id),
              set: { createdAt: state.app.createdAt },
            }),
          );
          const current = yield* storedApp(db, { app: state.app.id });
          if (
            managed
              ? current.activatedSequence !== activation
              : current.activeVersion !== version.id
          )
            return yield* new WebhookConflict();
          if (carried !== undefined) {
            if (carried.row.version === state.version.id) return carried.row.id;
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
        if (row.status === "stopping" || row.status === "disabled" || row.status === "stopped") {
          yield* refused("inactive");
          return yield* new WebhookFailed({ reason: "inactive" });
        }
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
        const response = yield* Schema.decodeUnknownEffect(WebhookResponseData)(value).pipe(
          Effect.tapError(() => refused("invalid-response")),
          Effect.mapError(() => new WebhookFailed({ reason: "delivery" })),
        );
        yield* Effect.annotateCurrentSpan("executor.webhook.response_status", response.status);
        return response;
      }).pipe(
        Effect.timeout(defaultWebhookLifecycleLimits.deliveryTimeoutMs),
        Effect.catchTag("TimeoutError", () =>
          refused("timeout").pipe(Effect.andThen(new WebhookFailed({ reason: "delivery" }))),
        ),
        Effect.tapError((error) => {
          if (error._tag !== "WebhookFailed") {
            const refusal = deliveryRefusals[error._tag];
            return refusal === undefined ? Effect.void : refused(refusal);
          }
          return error.reason === "inactive" || error.reason === "delivery"
            ? Effect.void
            : refused(`webhook-${error.reason}`);
        }),
        Effect.withSpan("sdk.webhooks.deliver"),
      ),
  };
  const lacksSource = (row: typeof StoredWebhook.Type) =>
    row.registeredAccounts !== null &&
    !selectedIds(row.registeredAccounts).includes(row.sourceAccount);
  const unremovable: UnremovableWebhooks = {
    list: query(() =>
      db.findMany("webhooks", {
        where: (b) =>
          b.and(
            b("status", "in", ["pending", "stopping"]),
            b("registeredAccounts", "is not", null),
          ),
        orderBy: ["id", "asc"],
      }),
    ).pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          Schema.decodeUnknownEffect(StoredWebhook)(row).pipe(
            Effect.mapError(() => new StorageError()),
          ),
        ),
      ),
      Effect.map((rows) =>
        rows.filter(lacksSource).map((row) => ({ id: row.id, owner: row.owner })),
      ),
    ),
    disable: (subscription, apply) =>
      transaction(db, () =>
        Effect.gen(function* () {
          const found = yield* query(() =>
            db.findFirst("webhooks", { where: (b) => b("id", "=", subscription) }),
          );
          if (found === null) return "absent" as const;
          const row = yield* Schema.decodeUnknownEffect(StoredWebhook)(found).pipe(
            Effect.mapError(() => new StorageError()),
          );
          if (!lacksSource(row)) return "unchanged" as const;
          if (row.status === "pending") return "registering" as const;
          if (row.status !== "stopping") return "unchanged" as const;
          if (row.leaseUntil.getTime() > (yield* Clock.currentTimeMillis)) return "busy" as const;
          if (!apply) return "would_disable" as const;
          const revision = yield* next;
          yield* query(() =>
            db.updateMany("webhooks", {
              where: (b) =>
                b.and(
                  b("id", "=", row.id),
                  b("revision", "=", row.revision),
                  b("status", "=", "stopping"),
                ),
              set: { status: "disabled", failure: null, revision, leaseUntil: new Date(0) },
            }),
          );
          return yield* read({ app: row.app, subscription: row.id }).pipe(
            Effect.map((current) =>
              current.revision === revision ? ("disabled" as const) : ("conflict" as const),
            ),
            Effect.catchTag("WebhookNotFound", () => Effect.succeed("absent" as const)),
          );
        }),
      ),
  };
  return {
    webhooks,
    unremovable,
    liveDefinitions: (state: InvocationSnapshot) => definitions(state, true),
    createManaged: (input: typeof ManagedWebhook.Type, activation: number) =>
      create(input, activation),
    removeManaged: (input: typeof WebhookTarget.Type, activation: number) =>
      reconcile(input, true, activation),
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
              if (current.key.startsWith("setup-"))
                yield* setupCompleted(db, { app: current.app, account: current.sourceAccount });
              return yield* metadata(current);
            }),
          );
        }),
    },
  };
};
