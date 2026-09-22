/** Destroy a stage's dynamic Alchemy stack before removing the Worker and its durable journal. */
import { Resource } from "alchemy";
import { Action } from "alchemy/Action";
import { State } from "alchemy/State/State";
import { StackContext } from "alchemy/StackContext";
import { Stage } from "alchemy/Stage";
import type { Worker } from "alchemy/Cloudflare";
import * as Provider from "alchemy/Provider";
import { Effect, Redacted, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { appDomainControlSecretId } from "./app-domain-control.ts";

interface DomainLifecycleProps {
  readonly origin: string;
  readonly workerName: string;
  /** The worker name is available during precreate; its hash waits for the completed upload. */
  readonly deployment: Worker<never>["Attributes"]["hash"];
}

interface DomainControl {
  readonly origin: string;
  readonly secret: Redacted.Redacted<string>;
}

/** Authenticated deployment control failed. No credential-bearing HTTP error is exposed. */
export class AppDomainLifecycleFailed extends Schema.TaggedError<AppDomainLifecycleFailed>()(
  "AppDomainLifecycleFailed",
  { operation: Schema.Literals(["resume", "drain"]), status: Schema.optionalKey(Schema.Number) },
) {
  get message() {
    return `Could not ${this.operation} app domains: ${this.status === undefined ? "request failed" : `HTTP ${this.status}`}`;
  }
}

/** This resource depends on the API Worker, so Alchemy drains team DNS before deleting that Worker. */
export type AppDomainLifecycle = Resource<
  "Executor.AppDomainLifecycle",
  DomainLifecycleProps,
  { readonly origin: string }
>;
/** A deployment-owned lifecycle barrier for runtime-created Alchemy resources. */
export const AppDomainLifecycle = Resource<AppDomainLifecycle>("Executor.AppDomainLifecycle");

const control = (props: DomainControl, operation: "resume" | "drain") =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post(`${props.origin}/api/internal/app-domains/${operation}`, {
        headers: { authorization: `Bearer ${Redacted.value(props.secret)}` },
      }),
    );
    yield* response.text;
    if (response.status !== 204)
      return yield* new AppDomainLifecycleFailed({ operation, status: response.status });
  }).pipe(
    Effect.mapError((error) =>
      Schema.is(AppDomainLifecycleFailed)(error)
        ? error
        : new AppDomainLifecycleFailed({ operation }),
    ),
    Effect.retry({ times: 10, schedule: Schedule.spaced("3 seconds") }),
  );

/** Persist the teardown relationship before the separate resume action runs. */
export const AppDomainLifecycleProvider = () =>
  Provider.succeed(AppDomainLifecycle, {
    // This is a lifecycle relationship, not a separate physical resource. Keep
    // its cleanup discoverable even when the first resume call was interrupted.
    read: ({ output, olds }) =>
      Effect.succeed(output ?? (olds === undefined ? undefined : { origin: olds.origin })),
    reconcile: ({ news }) => Effect.succeed({ origin: news.origin }),
    delete: ({ olds }) =>
      Effect.gen(function* () {
        const state = yield* yield* State;
        const stack = yield* StackContext;
        const stage = yield* Stage;
        const saved = yield* state.get({ stack: stack.name, stage, fqn: appDomainControlSecretId });
        const key = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            resourceType: Schema.Literal("Alchemy.Random"),
            attr: Schema.Struct({ text: Schema.Redacted(Schema.String) }),
          }),
        )(saved);
        yield* control({ origin: olds.origin, secret: key.attr.text }, "drain");
      }),
  });

/** Resume only after the lifecycle barrier and Worker are committed, so failures cannot lose teardown credentials. */
export const ResumeAppDomains = Action(
  "ResumeAppDomains",
  (input: DomainControl & { readonly deployment: Worker<never>["Attributes"]["hash"] }) =>
    control(input, "resume"),
);
