/** Runtime Alchemy reconciliation. Only DNS records belong to this stack; credentials never enter its state. */
import { Record as DnsRecord, RecordProvider } from "alchemy/Cloudflare/DNS";
import { Providers, CloudflareEnvironment } from "alchemy/CloudflareRuntimeServices";
import { Credentials, type ApiTokenCredentials } from "@distilled.cloud/cloudflare/Credentials";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { apply } from "alchemy/Apply";
import { make as plan } from "alchemy/Plan";
import { collection } from "alchemy/Provider";
import { StackContext } from "alchemy/StackContext";
import type { StackSpec } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import { State, type StateService } from "alchemy/State/State";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

/** DNS follows current team names; immutable team IDs remain authorization identities and ownership metadata. */
export interface TeamDomain {
  readonly id: string;
  readonly slug: string;
}

/** Plan and apply the complete desired set. A failed database read must never be supplied as an empty set. */
export const reconcileAppDomainStack = (input: {
  readonly stage: string;
  readonly accountId: string;
  readonly zoneId: string;
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
        Layer.provide(RecordProvider()),
      );
      yield* Effect.gen(function* () {
        yield* Effect.forEach(input.teams, (team) =>
          DnsRecord(`team-${team.slug}`, {
            zoneId: input.zoneId,
            name: `*.${team.slug}.${input.suffix}`,
            type: "AAAA",
            content: "100::",
            proxied: true,
            ttl: 1,
            comment: "Executor app domain",
            ownershipComment: true,
          }),
        );
        const desired = yield* plan({ ...stack, output: {} });
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
        Effect.provide(FetchHttpClient.layer),
      );
    }),
  );
