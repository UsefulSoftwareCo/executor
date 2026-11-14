/** Store mail for agent inboxes. Everything else routed to this Worker is rejected. */
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Layer, Schema } from "effect";
import PostalMime from "postal-mime";
import {
  AgentMailLocalPart,
  AgentMailMessage,
  agentMailDomain,
  agentMailPrefix,
  agentMailRetentionSeconds,
} from "./contracts/agent-mail.ts";
import { AgentMailReceiver, AgentMailbox } from "./infrastructure/agent-mail.ts";

/** Parsed messages are small; larger ones are rejected rather than truncated. */
const maxMessageBytes = 1024 * 1024;

export default AgentMailReceiver.make(
  Effect.succeed({
    main: import.meta.url,
    workersDev: false,
    compatibility: { date: "2026-09-08", flags: ["nodejs_compat", "no_brotli_content_encoding"] },
  }),
  Effect.gen(function* () {
    const mailbox = yield* Cloudflare.KV.WriteNamespace(AgentMailbox);
    yield* Cloudflare.email().subscribe((message) =>
      Effect.gen(function* () {
        const to = message.to.toLowerCase();
        const [local, domain] = to.split("@");
        if (domain !== agentMailDomain || !Schema.is(AgentMailLocalPart)(local))
          return yield* message.setReject("Unknown agent mailbox");
        if (message.bodySize > maxMessageBytes)
          return yield* message.setReject("Message too large");
        const parsed = yield* Effect.promise(async () => {
          const chunks: Array<Uint8Array> = [];
          for await (const chunk of message.body) chunks.push(chunk);
          return PostalMime.parse(Buffer.concat(chunks));
        });
        const receivedAt = new Date().toISOString();
        const stored = Schema.encodeSync(AgentMailMessage)({
          to,
          from: message.from,
          subject: parsed.subject ?? "",
          text: parsed.text ?? "",
          html: parsed.html ?? "",
          receivedAt,
        });
        yield* mailbox.put(
          `${agentMailPrefix(to)}${receivedAt}/${crypto.randomUUID()}`,
          JSON.stringify(stored),
          { expirationTtl: agentMailRetentionSeconds },
        );
      }),
    );
    return {};
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Cloudflare.EmailEventSourceLive, Cloudflare.KV.WriteNamespaceBinding),
    ),
  ),
);
