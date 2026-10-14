/**
 * The v1 import (`notes/v1-import.md`): preview, start, one item per request, finish. Every
 * request checks that the caller is the v1 workspace's single active member, by verified email.
 * Preview and start also check that the workspace is on a free plan; once an import has started,
 * its items and its finish rely on that check instead of asking Autumn again. The import copies:
 * v1 keeps working, and the moved flag (`moved-flag.ts`) is not used. Nothing is written to v1
 * except, when an import finishes, where the workspace went on its WorkOS organization
 * (`moved-notice.ts`).
 */
import { organizationOwner } from "@executor-js/hosted-server";
import { AppId, OAuthGrantImport } from "@executor-js/sdk/core";
import { DateTime, Effect, Predicate } from "effect";
import { HttpClient } from "effect/http";
import {
  V1Import,
  V1ImportDependencyPending,
  V1ImportItemNotFound,
  V1ImportNotEligible,
  V1ImportNotStarted,
  V1ImportTargetForbidden,
  V1ImportUnavailable,
  type V1ImportItem,
  type V1ImportPreview,
  type V1ImportRequest,
  type V1ItemKey,
  type V1ItemResult,
  type V1OrganizationId,
} from "../../contracts/v1-import.ts";
import {
  ItemFailed,
  artifactMapping,
  importAccount,
  importArtifact,
  importIntegration,
  importToolkit,
  linkConnectionAccount,
  mapLookup,
  type ItemContext,
} from "./items.ts";
import { makeV1MovedNotice } from "./moved-notice.ts";
import { decodeToolkit, firstPartyClientPrefix, matchPattern } from "./formats.ts";
import { connectionPlan, previewItems, type FirstPartyClients } from "./plan.ts";
import { makeV1Source, type V1SourceSettings, type V1Snapshot } from "./source.ts";
import { makeImportStore, sourceHash, type MapResult, type MapRow } from "./store.ts";

/** The note on an imported policy that matches none of the tools v1 last listed. */
export const noToolMatches = "It matches no tool v1 last listed for its integration.";

/** The v2 kind of an app imported as source without a deployment, which needs repair. */
const undeployedApp = "undeployed_app";

/** The operator's OAuth clients this request's executor offers, by v1's first-party name. */
const firstPartyClients =
  (request: V1ImportRequest): FirstPartyClients =>
  (name) =>
    request.executor[OAuthGrantImport].firstPartyClient(name);

/** Storage and transport failures retry the request; anything else v2 refuses fails the item. */
const transient = (error: unknown) =>
  Predicate.isTagged(error, "StorageError") ||
  Predicate.isTagged(error, "AuthenticationUnavailable") ||
  Predicate.isTagged(error, "CredentialsError") ||
  Predicate.isTagged(error, "V1ImportUnavailable");

export const makeV1Import = (settings: V1SourceSettings) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const notice = makeV1MovedNotice(settings, http);
    const open = (request: V1ImportRequest) =>
      Effect.gen(function* () {
        const source = yield* makeV1Source(settings).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
        );
        return { source, store: makeImportStore(request.sql) };
      });

    /** The caller's WorkOS user when they are the v1 workspace's single member, or why not. */
    const member = (request: V1ImportRequest, organization: V1OrganizationId) =>
      Effect.gen(function* () {
        const { source, store } = yield* open(request);
        const user = yield* store.user(request.user);
        if (user === undefined || !user.emailVerified)
          return yield* new V1ImportNotEligible({ reason: "no_verified_email" });
        const memberships = yield* source.memberships(user.email);
        if (
          memberships.user === undefined ||
          !memberships.organizations.some((candidate) => candidate.id === organization)
        )
          return yield* new V1ImportNotEligible({ reason: "not_member" });
        const members = yield* source.members(organization);
        if (members.length !== 1)
          return yield* new V1ImportNotEligible({ reason: "multiple_members" });
        if (members[0] !== memberships.user)
          return yield* new V1ImportNotEligible({ reason: "not_member" });
        return { source, store, member: memberships.user };
      });

    /**
     * The caller's WorkOS user for this v1 workspace, or why they cannot import it. Starting is
     * the decision to import, so only preview and start ask Autumn for the plan. A started
     * import's items and finish need only `member`.
     */
    const eligible = (request: V1ImportRequest, organization: V1OrganizationId) =>
      Effect.gen(function* () {
        const found = yield* member(request, organization);
        if (yield* found.source.paid(organization))
          return yield* new V1ImportNotEligible({ reason: "paid" });
        return found;
      });

    const resultOf = (
      rows: readonly MapRow[],
      item: Pick<V1ImportItem, "kind" | "id">,
    ): V1ItemResult | null => {
      const row = (kind: string) =>
        rows.find((found) => found.v1_kind === kind && found.v1_id === item.id);
      const asResult = (found: MapRow | undefined): V1ItemResult | null =>
        found === undefined
          ? null
          : found.status === "imported" && found.v2_id !== null
            ? {
                status: "imported",
                v2Id: found.v2_id,
                ...(found.reason === null ? {} : { note: found.reason }),
                ...(found.v2_kind === undeployedApp ? { needsRepair: true as const } : {}),
              }
            : found.status === "skipped"
              ? { status: "skipped", reason: found.reason ?? "There is nothing to import." }
              : { status: "failed", reason: found.reason ?? "It could not be imported." };
      if (item.kind !== "connection") return asResult(row(item.kind));
      // A connection is imported once its account is saved and linked to its app, which its
      // `profile` row records (see `mapLookup`). A row from before profiles were removed names
      // its profile; the account it selected is the connection's result.
      const account = row("connection");
      if (account?.status === "failed") return asResult(account);
      const linked = row("profile");
      if (linked?.status === "imported" && linked.v2_kind === "profile") return asResult(account);
      return asResult(linked) ?? (account === undefined ? null : asResult(account));
    };

    const previewOf = (
      request: V1ImportRequest,
      store: ReturnType<typeof makeImportStore>,
      organization: V1OrganizationId,
      snapshot: V1Snapshot,
    ) =>
      Effect.gen(function* () {
        const rows = yield* store.rows(organization);
        const started = rows.find(
          (row) => row.v1_kind === "organization" && row.status === "imported",
        );
        const target =
          started?.v2_id === undefined || started.v2_id === null
            ? undefined
            : yield* store.target(started.v2_id);
        return {
          organization: { id: organization, name: snapshot.organization.name },
          items: previewItems(snapshot, firstPartyClients(request)).map((item) => ({
            ...item,
            result: resultOf(rows, item),
          })),
          target: target ?? null,
        } satisfies V1ImportPreview;
      });

    const preview: typeof V1Import.Service.preview = (request, organization) =>
      Effect.gen(function* () {
        const { source, store, member } = yield* eligible(request, organization);
        const snapshot = yield* source.snapshot(organization, member);
        return yield* previewOf(request, store, organization, snapshot);
      }).pipe(Effect.withSpan("v1Import.preview"));

    const choices: typeof V1Import.Service.choices = (request) =>
      Effect.gen(function* () {
        const { source, store } = yield* open(request);
        const owned = yield* store.owned(request.user);
        const user = yield* store.user(request.user);
        if (user === undefined || !user.emailVerified) return { organizations: [], owned };
        const memberships = yield* source.memberships(user.email);
        const organizations = yield* Effect.forEach(
          memberships.organizations,
          (organization) =>
            Effect.gen(function* () {
              const members = yield* source.members(organization.id);
              const reason =
                members.length !== 1
                  ? ("multiple_members" as const)
                  : members[0] !== memberships.user
                    ? ("not_member" as const)
                    : (yield* source.paid(organization.id))
                      ? ("paid" as const)
                      : null;
              const started = yield* store.find("organization", organization.id);
              const target =
                started?.status === "imported" && started.v2_id !== null
                  ? yield* store.target(started.v2_id)
                  : undefined;
              return {
                id: organization.id as V1OrganizationId,
                name: organization.name,
                eligible: reason === null,
                reason,
                target: target ?? null,
              };
            }),
          { concurrency: 4 },
        );
        // Only imported workspaces link back, so v1's database is read only for them.
        const dashboards = yield* source.dashboards(
          organizations
            .filter((organization) => organization.target !== null)
            .map((organization) => organization.id),
        );
        return {
          organizations: organizations.map((organization) => ({
            ...organization,
            v1Url: dashboards.get(organization.id) ?? null,
          })),
          owned,
        };
      }).pipe(
        Effect.mapError(() => new V1ImportUnavailable()),
        Effect.withSpan("v1Import.choices"),
      );

    const start: typeof V1Import.Service.start = (request, organization, input) =>
      Effect.gen(function* () {
        const { source, store, member } = yield* eligible(request, organization);
        const snapshot = yield* source.snapshot(organization, member);
        const started = yield* store.find("organization", organization);
        if (started?.status === "imported")
          return yield* previewOf(request, store, organization, snapshot);
        const owned = yield* store.owned(request.user);
        const requested = input.target;
        const chosen =
          requested.kind === "existing"
            ? owned.find((candidate) => candidate.id === requested.organization)
            : undefined;
        if (requested.kind === "existing" && chosen === undefined)
          return yield* new V1ImportTargetForbidden();
        const target =
          chosen ??
          (yield* store.createOrganization(
            request.user,
            snapshot.organization.name,
            snapshot.organization.slug,
          ));
        yield* store.record({
          organization,
          kind: "organization",
          id: organization,
          result: { status: "imported", v2Kind: "organization", v2Id: target.id },
          hash: yield* sourceHash(snapshot.organization),
        });
        return yield* previewOf(request, store, organization, snapshot);
      }).pipe(Effect.withSpan("v1Import.start"));

    const finish: typeof V1Import.Service.finish = (request, organization) =>
      Effect.gen(function* () {
        const { source, store, member: user } = yield* member(request, organization);
        const started = yield* store.find("organization", organization);
        if (started?.status !== "imported" || started.v2_id === null)
          return yield* new V1ImportNotStarted();
        // Telling v1 where the workspace went never fails the import; the next finish retries.
        const target = yield* store.target(started.v2_id);
        if (target !== undefined)
          yield* notice
            .record({
              organization,
              slug: target.slug,
              at: DateTime.formatIso(yield* DateTime.now),
            })
            .pipe(
              Effect.catch(() =>
                Effect.logWarning("v1 import: where the workspace moved was not written to v1"),
              ),
            );
        return yield* previewOf(
          request,
          store,
          organization,
          yield* source.snapshot(organization, user),
        );
      }).pipe(Effect.withSpan("v1Import.finish"));

    const item: typeof V1Import.Service.item = (request, organization, key) =>
      Effect.gen(function* () {
        const { source, store, member: user } = yield* member(request, organization);
        const started = yield* store.find("organization", organization);
        const target =
          started?.status === "imported" && started.v2_id !== null
            ? yield* store.target(started.v2_id)
            : undefined;
        if (target === undefined) return yield* new V1ImportNotStarted();
        const snapshot = yield* source.snapshot(organization, user);
        const firstParty = firstPartyClients(request);
        const planned = previewItems(snapshot, firstParty).find(
          (candidate) => candidate.kind === key.kind && candidate.id === key.id,
        );
        if (planned === undefined) return yield* new V1ImportItemNotFound();
        // A connection's attempt is its `profile` row, which records its link: a public app's
        // connection and one whose account failed record no account row.
        for (const dependency of planned.dependsOn)
          if (
            (yield* store.find(
              dependency.kind === "connection" ? "profile" : dependency.kind,
              dependency.id,
            )) === undefined &&
            (yield* store.find(dependency.kind, dependency.id)) === undefined
          )
            return yield* new V1ImportDependencyPending({ dependency });
        const context: ItemContext = {
          executor: request.executor,
          connections: request.connections,
          store,
          sql: request.sql,
          source,
          snapshot,
          target,
          user: request.user,
          firstParty,
        };
        const record =
          (kind: Parameters<typeof store.record>[0]["kind"], hash: string) => (result: MapResult) =>
            store.record({ organization, kind, id: key.id, result, hash });
        const outcome = (result: MapResult): V1ItemResult =>
          result.status === "imported"
            ? {
                status: "imported",
                v2Id: result.v2Id,
                ...(result.note === undefined ? {} : { note: result.note }),
                ...(result.v2Kind === undeployedApp ? { needsRepair: true as const } : {}),
              }
            : { status: result.status, reason: result.reason };
        const failed =
          (kind: Parameters<typeof store.record>[0]["kind"], hash: string) => (error: unknown) =>
            Effect.gen(function* () {
              if (transient(error)) return yield* new V1ImportUnavailable();
              const reason =
                error instanceof ItemFailed
                  ? error.reason
                  : `Executor v2 refused it (${Predicate.hasProperty(error, "_tag") ? String(error._tag) : "error"}).`;
              const result: MapResult = { status: "failed", reason };
              yield* record(kind, hash)(result);
              return outcome(result);
            });
        if (planned.plan.status !== "will_import") {
          const result: MapResult = {
            status: planned.plan.status === "skipped" ? "skipped" : "failed",
            reason: planned.plan.reason,
          };
          yield* record(key.kind, yield* sourceHash(planned))(result);
          return outcome(result);
        }
        return yield* importItem(context, key, record, outcome, failed);
      }).pipe(Effect.withSpan("v1Import.item", { attributes: { "v1Import.kind": key.kind } }));

    const importItem = (
      context: ItemContext,
      key: V1ItemKey,
      record: (
        kind: Parameters<ItemContext["store"]["record"]>[0]["kind"],
        hash: string,
      ) => (result: MapResult) => Effect.Effect<void, V1ImportUnavailable>,
      outcome: (result: MapResult) => V1ItemResult,
      failed: (
        kind: Parameters<ItemContext["store"]["record"]>[0]["kind"],
        hash: string,
      ) => (error: unknown) => Effect.Effect<V1ItemResult, V1ImportUnavailable>,
    ) =>
      Effect.gen(function* () {
        const { snapshot, store, executor, firstParty } = context;
        const owner = organizationOwner(context.target.id);
        switch (key.kind) {
          case "integration": {
            const row = snapshot.integrations.find((candidate) => candidate.row_id === key.id);
            if (row === undefined) return yield* new V1ImportItemNotFound();
            // Policies, toolkits' policies and connections' sign-in shape the generated source.
            const hash = yield* sourceHash({
              integration: row,
              policies: snapshot.policies,
              toolkits: snapshot.toolkits,
              toolkitRules: snapshot.toolkitRules,
              connections: snapshot.connections
                .filter((connection) => connection.integration === row.slug)
                .map((connection) => [
                  connection.row_id,
                  connection.template,
                  connection.oauth_client,
                  // Whether v2 offers a first-party connection's client decides its method.
                  ...(connection.oauth_client?.startsWith(firstPartyClientPrefix) === true
                    ? [
                        firstParty(connection.oauth_client.slice(firstPartyClientPrefix.length)) !==
                          undefined,
                      ]
                    : []),
                ]),
            });
            const existing = yield* store.find("integration", key.id);
            if (
              existing?.status === "imported" &&
              existing.source_hash === hash &&
              existing.v2_id !== null
            )
              return {
                status: "imported" as const,
                v2Id: existing.v2_id,
                ...(existing.reason === null ? {} : { note: existing.reason }),
              };
            const app =
              existing?.status === "imported" && existing.v2_id !== null
                ? (existing.v2_id as Parameters<typeof importIntegration>[2])
                : undefined;
            return yield* importIntegration(context, row, app).pipe(
              Effect.tap(record("integration", hash)),
              Effect.map(outcome),
              Effect.catch(failed("integration", hash)),
            );
          }
          case "connection": {
            const row = snapshot.connections.find((candidate) => candidate.row_id === key.id);
            if (row === undefined) return yield* new V1ImportItemNotFound();
            const hash = yield* sourceHash(row);
            const plan = connectionPlan(snapshot, firstParty, row);
            const integration = snapshot.integrations.find(
              (candidate) => candidate.slug === row.integration,
            );
            const appRow =
              integration === undefined
                ? undefined
                : yield* store.find("integration", integration.row_id);
            // The `profile` row records the connection's link (see `mapLookup`). One from before
            // profiles were removed names its profile; the account it selected is the result.
            const linkedRow = yield* store.find("profile", key.id);
            if (linkedRow?.status === "imported" && linkedRow.v2_id !== null) {
              const saved = yield* store.find("connection", key.id);
              return {
                status: "imported" as const,
                v2Id:
                  linkedRow.v2_kind === "profile" &&
                  saved?.status === "imported" &&
                  saved.v2_id !== null
                    ? saved.v2_id
                    : linkedRow.v2_id,
              };
            }
            return yield* Effect.gen(function* () {
              if (!plan.ok) return yield* new ItemFailed({ reason: plan.reason });
              if (appRow?.status !== "imported" || appRow.v2_id === null)
                return yield* new ItemFailed({ reason: "Its integration was not imported." });
              const app = yield* executor.apps.get({
                owner,
                app: appRow.v2_id as Parameters<typeof executor.apps.get>[0]["app"],
              });
              // A public app needs no account or link. When the app takes accounts, a
              // connection without credentials gets an account of the app's fixed ones.
              if (
                plan.value.access.kind === "none" &&
                app.requirements.accounts.service === undefined
              ) {
                const result: MapResult = { status: "imported", v2Kind: "app", v2Id: app.id };
                yield* record("profile", hash)(result);
                return outcome(result);
              }
              const accountRow = yield* store.find("connection", key.id);
              const account =
                accountRow?.status === "imported" && accountRow.v2_id !== null
                  ? (accountRow.v2_id as Parameters<typeof linkConnectionAccount>[2])
                  : yield* importAccount(context, plan.value, app, record("connection", hash));
              yield* linkConnectionAccount(context, app, account);
              const result: MapResult = { status: "imported", v2Kind: "account", v2Id: account };
              yield* record("profile", hash)(result);
              return outcome(result);
            }).pipe(Effect.catch(failed("profile", hash)));
          }
          case "tool_policy": {
            const row = snapshot.policies.find((candidate) => candidate.row_id === key.id);
            if (row === undefined) return yield* new V1ImportItemNotFound();
            const hash = yield* sourceHash(row);
            const first = row.pattern.split(".")[0];
            const apps: string[] = [];
            for (const integration of snapshot.integrations)
              if (first === "*" || integration.slug === first) {
                const found = yield* store.find("integration", integration.row_id);
                if (found?.status === "imported" && found.v2_id !== null) apps.push(found.v2_id);
              }
            // The rule is already in each matching app's tools.ts. One that matches none of the
            // tools v1 last listed still moves, for tools the server may list again.
            let matches = false;
            for (const integration of snapshot.integrations)
              if (!matches && (first === "*" || integration.slug === first))
                matches = (yield* context.source.tools(
                  snapshot.tenant,
                  snapshot.member,
                  integration.slug,
                )).some((tool) =>
                  matchPattern(
                    row.pattern,
                    `${integration.slug}.${tool.owner}.${tool.connection}.${tool.name}`,
                  ),
                );
            const result: MapResult =
              apps[0] === undefined
                ? { status: "failed", reason: "Its integration was not imported." }
                : {
                    status: "imported",
                    v2Kind: "app",
                    v2Id: apps[0],
                    ...(matches ? {} : { note: noToolMatches }),
                  };
            yield* record("tool_policy", hash)(result);
            return outcome(result);
          }
          case "toolkit": {
            const row = snapshot.toolkits.find((candidate) => candidate.row_id === key.id);
            if (row === undefined) return yield* new V1ImportItemNotFound();
            const toolkit = decodeToolkit(row, snapshot.toolkitRules);
            const hash = yield* sourceHash({ row, rules: toolkit });
            if (toolkit === undefined) {
              const result: MapResult = {
                status: "failed",
                reason: "Its toolkit could not be read.",
              };
              yield* record("toolkit", hash)(result);
              return outcome(result);
            }
            // The connection follows the apps and accounts imported since; saving it again is safe.
            return yield* importToolkit(context, toolkit).pipe(
              Effect.tap(record("toolkit", hash)),
              Effect.map(outcome),
              Effect.catch(failed("toolkit", hash)),
            );
          }
          case "artifact": {
            const row = snapshot.artifacts.find((candidate) => candidate.row_id === key.id);
            if (row === undefined) return yield* new V1ImportItemNotFound();
            const mapping = yield* artifactMapping(snapshot, mapLookup(store), row);
            // Its source and the mapping written into it.
            const hash = yield* sourceHash({ artifact: row, mapping });
            const existing = yield* store.find("artifact", key.id);
            if (
              existing?.status === "imported" &&
              existing.source_hash === hash &&
              existing.v2_id !== null
            )
              return outcome({
                status: "imported",
                v2Kind: existing.v2_kind ?? undeployedApp,
                v2Id: existing.v2_id,
                ...(existing.reason === null ? {} : { note: existing.reason }),
              });
            const app =
              existing?.status === "imported" && existing.v2_id !== null
                ? AppId.make(existing.v2_id)
                : undefined;
            return yield* importArtifact(context, row, mapping, app).pipe(
              Effect.tap(record("artifact", hash)),
              Effect.map(outcome),
              Effect.catch(failed("artifact", hash)),
            );
          }
        }
      });

    return V1Import.of({ choices, preview, start, item, finish });
  });

/** Where v1's settings are not configured, every request says the import is unavailable. */
export const v1ImportDisabled = V1Import.of({
  choices: () => Effect.fail(new V1ImportUnavailable()),
  preview: () => Effect.fail(new V1ImportUnavailable()),
  start: () => Effect.fail(new V1ImportUnavailable()),
  item: () => Effect.fail(new V1ImportUnavailable()),
  finish: () => Effect.fail(new V1ImportUnavailable()),
});
