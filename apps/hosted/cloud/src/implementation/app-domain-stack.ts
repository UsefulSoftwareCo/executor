/** Runtime Alchemy reconciliation. Only DNS records belong to this stack; credentials never enter its state. */
import { Record as DnsRecord, RecordProvider } from "alchemy/Cloudflare/DNS";
import { Providers, CloudflareEnvironment } from "alchemy/CloudflareRuntimeServices";
import { Credentials, type ApiTokenCredentials } from "@distilled.cloud/cloudflare/Credentials";
import { batchRecord, type listRecords } from "@distilled.cloud/cloudflare/dns";
import { appDomainDnsRecords } from "./app-domain-inventory.ts";
import { appDomainHttpClient } from "./app-domain-http.ts";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { apply } from "alchemy/Apply";
import { make as plan } from "alchemy/Plan";
import { collection, effect as providerEffect } from "alchemy/Provider";
import { StackContext } from "alchemy/StackContext";
import type { StackSpec } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import { InstanceId } from "alchemy/InstanceId";
import { State, type StateService } from "alchemy/State/State";
import { Effect, Exit, Layer, Option, Request, RequestResolver, Schema } from "effect";
import { HttpClient } from "effect/unstable/http";

/** DNS follows current team names; immutable team IDs remain authorization identities and ownership metadata. */
export interface TeamDomain {
  readonly id: string;
  readonly slug: string;
}

const ObservedRecord = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.String,
  type: Schema.Literal("AAAA"),
  content: Schema.String,
  ttl: Schema.Number,
  proxied: Schema.Boolean,
  createdOn: Schema.optional(Schema.NullOr(Schema.String)),
  modifiedOn: Schema.optional(Schema.NullOr(Schema.String)),
});

/** A live inventory scan batches absence checks for new team domains and detects drift.
 * Existing names still use Alchemy's ownership and interrupted-create recovery.
 * Updates use the original provider; creation and deletion batches read a fresh inventory.
 */
const planningRecords = (zoneId: string, suffix: string) =>
  providerEffect(
    DnsRecord,
    Effect.gen(function* () {
      const provider = yield* DnsRecord.Provider;
      const read = provider.read;
      if (!read) return yield* Effect.die(new Error("DNS provider must support ownership reads"));
      const records = yield* appDomainDnsRecords(zoneId, suffix).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ObservedRecord))),
      );
      const byId = new Map(records.map((record) => [record.id, record]));
      const names = new Set(records.map((record) => record.name));
      return DnsRecord.Provider.of({
        ...provider,
        diff: Effect.fn(function* (input) {
          const change = provider.diff ? yield* provider.diff(input) : undefined;
          if (change) return change;
          const observed = input.output && byId.get(input.output.recordId);
          if (
            input.output &&
            (!observed ||
              observed.content !== input.olds.content ||
              observed.proxied !== input.olds.proxied ||
              observed.ttl !== input.olds.ttl)
          )
            return { action: "update" as const };
        }),
        read: (input) => {
          const observed = input.output && byId.get(input.output.recordId);
          if (!observed) {
            // Absence is known from this complete live scan. Existing names still
            // go through the provider's ownership checks before any adoption.
            if (!input.output && !names.has(input.olds.name)) return Effect.succeed(undefined);
            return read(input);
          }
          return Effect.succeed({
            recordId: observed.id,
            zoneId,
            name: observed.name,
            type: observed.type,
            content: observed.content,
            ttl: observed.ttl,
            proxied: observed.proxied,
            createdOn: observed.createdOn === null ? undefined : observed.createdOn,
            modifiedOn: observed.modifiedOn === null ? undefined : observed.modifiedOn,
          });
        },
      });
    }).pipe(Effect.orDie),
  ).pipe(Layer.provide(batchingRecords(zoneId, suffix)));

class DomainDnsBatchFailed extends Schema.TaggedError<DomainDnsBatchFailed>()(
  "DomainDnsBatchFailed",
  { reason: Schema.Literals(["changed", "acknowledgement"]) },
) {}

/** Batch Alchemy's new records and deletions while retaining per-record ownership and recovery. */
const batchingRecords = (zoneId: string, suffix: string) =>
  providerEffect(
    DnsRecord,
    Effect.gen(function* () {
      const native = yield* DnsRecord.Provider;
      const services = yield* Effect.context<Credentials | HttpClient.HttpClient>();
      interface CreateRecord extends Request.Request<
        Effect.Success<ReturnType<typeof native.reconcile>>,
        | Effect.Error<ReturnType<typeof batchRecord> | ReturnType<typeof listRecords>>
        | DomainDnsBatchFailed
      > {
        readonly name: string;
        readonly comment: string;
      }
      const CreateRecord = Request.of<CreateRecord>();
      const creations = RequestResolver.make<CreateRecord>((entries) =>
        Effect.gen(function* () {
          const live = yield* appDomainDnsRecords(zoneId, suffix);
          const names = new Set(live.map((record) => record.name));
          // A record appeared after planning. Let the next native ownership read
          // recover our interrupted create or reject the other owner's record.
          if (entries.some(({ request }) => names.has(request.name)))
            return yield* new DomainDnsBatchFailed({ reason: "changed" });
          const response = yield* batchRecord({
            zoneId,
            posts: entries.map(({ request }) => ({
              name: request.name,
              comment: request.comment,
              type: "AAAA",
              content: "100::",
              proxied: true,
              ttl: 1,
            })),
          });
          const decoded = Schema.decodeUnknownOption(
            Schema.Array(
              Schema.Struct({
                ...ObservedRecord.fields,
                comment: Schema.String,
              }),
            ),
          )(response.posts);
          if (Option.isNone(decoded) || decoded.value.length !== entries.length)
            return yield* new DomainDnsBatchFailed({ reason: "acknowledgement" });
          const byName = new Map(decoded.value.map((record) => [record.name, record]));
          if (
            byName.size !== entries.length ||
            new Set(decoded.value.map((record) => record.id)).size !== entries.length ||
            entries.some(({ request }) => {
              const record = byName.get(request.name);
              return (
                record === undefined ||
                record.comment !== request.comment ||
                record.content !== "100::" ||
                !record.proxied ||
                record.ttl !== 1
              );
            })
          )
            return yield* new DomainDnsBatchFailed({ reason: "acknowledgement" });
          for (const entry of entries) {
            const record = byName.get(entry.request.name);
            if (!record) return yield* Effect.die(new Error("Verified DNS record is missing"));
            entry.completeUnsafe(
              Exit.succeed({
                recordId: record.id,
                zoneId,
                name: record.name,
                type: record.type,
                content: record.content,
                ttl: record.ttl,
                proxied: record.proxied,
                createdOn: record.createdOn ?? undefined,
                modifiedOn: record.modifiedOn ?? undefined,
              }),
            );
          }
        }).pipe(Effect.provideContext(services)),
      ).pipe(RequestResolver.batchN(100));
      interface DeleteRecord extends Request.Request<
        void,
        Effect.Error<ReturnType<typeof batchRecord> | ReturnType<typeof listRecords>>
      > {
        readonly id: string;
      }
      const DeleteRecord = Request.of<DeleteRecord>();
      const resolver = RequestResolver.make<DeleteRecord>((entries) =>
        Effect.gen(function* () {
          // A prior interrupted commit or external deletion can leave a missing
          // ID in the journal. Cloudflare rejects the whole batch if any ID is
          // absent, so confirm the live set before sending the owned subset.
          const live = yield* appDomainDnsRecords(zoneId, suffix);
          const ids = new Set(live.map((record) => record.id));
          const deletes = entries.flatMap(({ request }) =>
            ids.has(request.id) ? [{ id: request.id }] : [],
          );
          if (deletes.length > 0) {
            const response = yield* batchRecord({ zoneId, deletes });
            const confirmed = new Set(response.deletes?.map((record) => record.id));
            if (deletes.some((record) => !confirmed.has(record.id)))
              return yield* Effect.die(
                new Error("DNS batch did not confirm every requested deletion"),
              );
          }
          for (const entry of entries) entry.completeUnsafe(Exit.void);
        }).pipe(Effect.provideContext(services)),
      ).pipe(RequestResolver.batchN(100));
      return DnsRecord.Provider.of({
        ...native,
        reconcile: (input) =>
          input.output !== undefined
            ? native.reconcile(input)
            : Effect.gen(function* () {
                const props = yield* Schema.decodeUnknownEffect(
                  Schema.Struct({
                    zoneId: Schema.Literal(zoneId),
                    name: Schema.String,
                    type: Schema.Literal("AAAA"),
                    content: Schema.Literal("100::"),
                    proxied: Schema.Literal(true),
                    ttl: Schema.Literal(1),
                    comment: Schema.String,
                    ownershipComment: Schema.Literal(true),
                  }),
                )(input.news).pipe(Effect.orDie);
                if (!props.name.endsWith(`.${suffix}`))
                  return yield* Effect.die(
                    new Error("DNS creation is outside the stage's domain suffix"),
                  );
                const instance = yield* InstanceId;
                return yield* Effect.request(
                  CreateRecord({
                    name: props.name,
                    comment: `${props.comment} [alchemy:${instance}]`,
                  }),
                  creations,
                );
              }),
        delete: ({ output }) => {
          if (output.zoneId !== zoneId || !output.name.endsWith(`.${suffix}`))
            return Effect.die(new Error("DNS deletion is outside the stage's domain suffix"));
          return Effect.request(DeleteRecord({ id: output.recordId }), resolver);
        },
      });
    }),
  ).pipe(Layer.provide(RecordProvider()));

/** Plan and apply the complete desired set. A failed database read must never be supplied as an empty set. */
export const reconcileAppDomainStack = (input: {
  readonly stage: string;
  readonly accountId: string;
  readonly zoneId: string;
  readonly zoneName: string;
  readonly suffix: string;
  readonly credentials: ApiTokenCredentials;
  readonly teams: ReadonlyArray<TeamDomain>;
  readonly state: StateService;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const stack: Omit<StackSpec, "output"> = {
        name: "executor-team-domains",
        stage: input.stage,
        resources: {},
        bindings: {},
        actions: {},
      };
      const providers = Layer.effect(Providers, collection([DnsRecord])).pipe(
        Layer.provide(batchingRecords(input.zoneId, input.suffix)),
      );
      yield* Effect.gen(function* () {
        yield* Effect.forEach(input.teams, (team) =>
          DnsRecord(`team-${team.slug}`, {
            zoneId: input.zoneId,
            zoneName: input.zoneName,
            name: `*.${team.slug}.${input.suffix}`,
            type: "AAAA",
            content: "100::",
            proxied: true,
            ttl: 1,
            comment: "Executor app domain",
            ownershipComment: true,
          }),
        );
        const desired = yield* plan({ ...stack, output: {} }).pipe(
          Effect.provide(
            Layer.effect(Providers, collection([DnsRecord])).pipe(
              Layer.provide(planningRecords(input.zoneId, input.suffix)),
            ),
          ),
        );
        yield* apply(desired);
      }).pipe(
        Effect.provide(providers),
        Effect.provideService(StackContext, stack),
        Effect.provideService(Stage, input.stage),
        Effect.provideService(State, Effect.succeed(input.state)),
        Effect.provideService(AlchemyContext, {
          dotAlchemy: "/tmp/alchemy",
          dev: false,
          adopt: false,
        }),
        Effect.provideService(
          CloudflareEnvironment,
          Effect.succeed({
            type: "apiToken",
            apiToken: input.credentials.apiToken,
            accountId: input.accountId,
            source: { type: "env" },
          }),
        ),
        Effect.provideService(Credentials, Effect.succeed(input.credentials)),
        Effect.provide(appDomainHttpClient),
      );
    }),
  );
