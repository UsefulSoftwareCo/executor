/**
 * Read agent inboxes through the Cloudflare API. The namespace comes from the agent mail stack's
 * shared Alchemy output; the caller supplies the same Cloudflare credentials used to deploy it.
 */
import { layer } from "alchemy/Alchemist/Runtime";
import { store } from "alchemy/Alchemist/routes/state";
import { Clock, Config, Effect, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import {
  AgentMailLocalPart,
  AgentMailMessage,
  agentMailDomain,
  agentMailPrefix,
  agentMailStack,
  agentMailStage,
} from "../src/contracts/agent-mail.ts";

export class AgentMailUnavailable extends Schema.TaggedError<AgentMailUnavailable>()(
  "AgentMailUnavailable",
  { reason: Schema.String },
) {}

const StackOutput = Schema.Struct({
  namespaceId: Schema.NonEmptyString,
  accountId: Schema.NonEmptyString,
});
const KeyList = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Array(Schema.Struct({ name: Schema.String })),
});

/** A full inbox address for a synthetic agent, such as `alice@agents.executor.engineering`. */
export const agentAddress = (local: string) =>
  Schema.decodeUnknownEffect(AgentMailLocalPart)(local).pipe(
    Effect.map((valid) => `${valid}@${agentMailDomain}`),
    Effect.mapError(
      () => new AgentMailUnavailable({ reason: "Use a lowercase agent name, such as alice-1" }),
    ),
  );

/** Resolve the deployed namespace and return a reader bound to it. */
export const agentMailbox = Effect.gen(function* () {
  const output = yield* store({ backend: "cloudflare" }).pipe(
    Effect.flatMap((state) => state.getOutput({ stack: agentMailStack, stage: agentMailStage })),
    Effect.flatMap(Schema.decodeUnknownEffect(StackOutput)),
    Effect.mapError(
      () =>
        new AgentMailUnavailable({
          reason: "The agent mail stack is not deployed; run bun run agent-mail:deploy",
        }),
    ),
  );
  const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
  const http = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
    HttpClient.filterStatusOk,
  );
  const base = `https://api.cloudflare.com/client/v4/accounts/${output.accountId}/storage/kv/namespaces/${output.namespaceId}`;

  /** Messages for one address, oldest first, optionally only those received after a time. */
  const list = (address: string, after?: string) =>
    Effect.gen(function* () {
      const keys = yield* http
        .get(`${base}/keys`, { urlParams: { prefix: agentMailPrefix(address), limit: 1000 } })
        .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(KeyList)));
      const names = keys.result
        .map((key) => key.name)
        .filter((name) => after === undefined || name.slice(address.length + 1) > after)
        .sort();
      return yield* Effect.forEach(
        names,
        (name) =>
          http
            .get(`${base}/values/${encodeURIComponent(name)}`)
            .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(AgentMailMessage))),
        { concurrency: 5 },
      );
    }).pipe(
      Effect.mapError(() => new AgentMailUnavailable({ reason: "Could not read the mailbox" })),
    );

  /** Wait for the first message after `after` whose subject matches. */
  const waitFor = (address: string, after: string, subject: RegExp, timeoutSeconds = 90) =>
    list(address, after).pipe(
      Effect.map((messages) => messages.find((message) => subject.test(message.subject))),
      Effect.filterOrFail(
        (message) => message !== undefined,
        () => new AgentMailUnavailable({ reason: `No matching mail for ${address} yet` }),
      ),
      Effect.retry(Schedule.spaced("2 seconds")),
      Effect.timeoutOrElse({
        duration: `${timeoutSeconds} seconds`,
        orElse: () =>
          Effect.fail(
            new AgentMailUnavailable({ reason: `No matching mail for ${address} arrived` }),
          ),
      }),
    );

  return {
    list,
    waitFor,
    now: Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms).toISOString())),
  };
}).pipe(Effect.provide(layer()), Effect.scoped);
