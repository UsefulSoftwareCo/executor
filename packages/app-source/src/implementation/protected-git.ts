/** Protect retained source refs even when ordinary app branches are force-pushed or deleted. */
import { Effect } from "effect";
import { SourceError, type RepositoryBackend } from "@executor-js/sdk/core";

/** One ref update a push requests. */
interface PushCommand {
  readonly old: string;
  readonly new: string;
  readonly ref: string;
}

/**
 * The update requests at the start of a receive-pack body (Git's pack protocol):
 *
 *     *PKT-LINE("shallow" SP oid LF)
 *     PKT-LINE(old SP new SP ref NUL capabilities LF) *PKT-LINE(old SP new SP ref LF)
 *     flush-pkt
 *
 * Push options, when negotiated, and the pack follow the flush and are forwarded unread. A body
 * that is only the flush is the probe Git sends before a pack larger than `http.postBuffer`.
 * `length` counts the bytes up to and including the flush.
 */
type CommandList =
  | { readonly status: "incomplete" }
  | { readonly status: "invalid" }
  | {
      readonly status: "complete";
      readonly commands: ReadonlyArray<PushCommand>;
      readonly capabilities: ReadonlyArray<string>;
      readonly length: number;
    };

/** Git caps a pkt-line, its 4-byte length included, at 65520 bytes. */
const maximumPacket = 65520;
/**
 * The command list is held in Worker memory (about 128 MB) until every command is checked; only
 * the pack after it streams. At about 100 bytes a ref, this is tens of thousands of refs.
 */
const maximumCommandList = 4 * 1024 * 1024;
const command = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/[^\s\0]+)(?:\0([^\n]*))?\n?$/u;

/**
 * Parse the command list incrementally as bytes arrive. Each pkt-line is decoded once; `next`
 * is called with everything read so far and resumes after the last whole line.
 */
const commandListParser = () => {
  const text = new TextDecoder("utf-8", { fatal: true });
  const commands: PushCommand[] = [];
  let capabilities: ReadonlyArray<string> = [];
  let shallow = false;
  let offset = 0;
  return (bytes: Uint8Array): CommandList => {
    for (;;) {
      if (bytes.length < offset + 4) return { status: "incomplete" };
      const prefix = String.fromCharCode(...bytes.subarray(offset, offset + 4));
      if (!/^[0-9a-fA-F]{4}$/u.test(prefix)) return { status: "invalid" };
      const length = Number.parseInt(prefix, 16);
      if (length === 0)
        return commands.length === 0 && shallow
          ? { status: "invalid" }
          : { status: "complete", commands, capabilities, length: offset + 4 };
      // 0001-0004 are delimiters or empty packets, which a version 0 push never sends.
      if (length <= 4 || length > maximumPacket) return { status: "invalid" };
      if (bytes.length < offset + length) return { status: "incomplete" };
      let line: string;
      try {
        line = text.decode(bytes.subarray(offset + 4, offset + length));
      } catch {
        return { status: "invalid" };
      }
      offset += length;
      if (line.startsWith("shallow ")) {
        if (commands.length > 0 || !/^shallow [0-9a-f]{40}\n?$/u.test(line))
          return { status: "invalid" };
        shallow = true;
        continue;
      }
      // A signed push (`push-cert`) is not a plain command and is refused with other formats.
      const match = command.exec(line);
      if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined)
        return { status: "invalid" };
      // Only the first command carries capabilities.
      if (match[4] !== undefined) {
        if (commands.length > 0) return { status: "invalid" };
        capabilities = match[4].split(" ").filter(Boolean);
      }
      commands.push({ old: match[1], new: match[2], ref: match[3] });
    }
  };
};

/** Why a command may not reach the repository, or undefined when it may. */
const refusal = (update: PushCommand) =>
  update.ref.startsWith("refs/heads/__executor/")
    ? "This ref is kept for retained versions"
    : update.ref === "refs/heads/main" && update.new === "0".repeat(40)
      ? "the app's main branch cannot be deleted"
      : undefined;

const packet = (payload: Uint8Array) => {
  const result = new Uint8Array(payload.length + 4);
  result.set(new TextEncoder().encode((payload.length + 4).toString(16).padStart(4, "0")));
  result.set(payload, 4);
  return result;
};
const concat = (parts: ReadonlyArray<Uint8Array>) => {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};
const flush = new TextEncoder().encode("0000");

/**
 * Refuse a push the way Git reports it: every ref is rejected with its reason, so the client
 * prints `! [remote rejected] main -> main (reason)` and the message on a `remote:` line.
 */
const refusePush = (
  commands: ReadonlyArray<PushCommand>,
  capabilities: ReadonlyArray<string>,
  reason: (update: PushCommand) => string,
  message: string,
): Response | undefined => {
  // report-status-v2 reports a refused ref with the same `ng` line.
  if (!capabilities.includes("report-status") && !capabilities.includes("report-status-v2"))
    return undefined;
  const encode = (text: string) => new TextEncoder().encode(text);
  const report = concat([
    packet(encode("unpack ok\n")),
    ...commands.map((update) => packet(encode(`ng ${update.ref} ${reason(update)}\n`))),
    flush,
  ]);
  const band = capabilities.includes("side-band-64k")
    ? 65515
    : capabilities.includes("side-band")
      ? 995
      : undefined;
  const parts: Uint8Array[] = [];
  if (band === undefined) parts.push(report);
  else {
    parts.push(packet(concat([Uint8Array.of(2), encode(`${message}\n`)])));
    for (let offset = 0; offset < report.length; offset += band)
      parts.push(packet(concat([Uint8Array.of(1), report.subarray(offset, offset + band)])));
    parts.push(flush);
  }
  return new Response(concat(parts), {
    status: 200,
    headers: {
      "content-type": "application/x-git-receive-pack-result",
      "cache-control": "no-cache",
    },
  });
};

/** Read until the command list is complete or invalid; later bytes stay in the reader. */
const readCommandList = (reader: ReadableStreamDefaultReader<Uint8Array>) =>
  Effect.gen(function* () {
    const parse = commandListParser();
    let buffered = new Uint8Array(0);
    for (;;) {
      const parsed = parse(buffered);
      if (parsed.status !== "incomplete") return { parsed, buffered };
      if (buffered.length > maximumCommandList) return yield* new SourceError({ reason: "limit" });
      const next = yield* Effect.tryPromise({
        try: () => reader.read(),
        catch: () => new SourceError({ reason: "git" }),
      });
      if (next.done) return { parsed: { status: "invalid" } satisfies CommandList, buffered };
      buffered = concat([buffered, next.value]);
    }
  });

/**
 * Validate a push's commands before forwarding any of it. Only the command list is read here;
 * the pack streams through to the backend, so a push is not bounded by Worker memory.
 */
export const protectGit = (backend: RepositoryBackend): RepositoryBackend => ({
  ...backend,
  request: (id, request) =>
    Effect.gen(function* () {
      if (!new URL(request.url).pathname.endsWith("/git-receive-pack"))
        return yield* backend.request(id, request);
      // Git never compresses a push, and an encoded body cannot be checked without decoding it.
      if (request.headers.has("content-encoding") || request.body === null)
        return yield* new SourceError({ reason: "protected" });
      const reader = request.body.getReader();
      const release = Effect.promise(() => reader.cancel().catch(() => undefined));
      const { parsed, buffered } = yield* readCommandList(reader).pipe(
        Effect.tapError(() => release),
      );
      if (parsed.status !== "complete") {
        yield* release;
        return yield* new SourceError({ reason: "protected" });
      }
      if (parsed.commands.length === 0) {
        // The probe names no ref, so it changes nothing; Git sends the real push only after the
        // probe succeeds. Anything after its flush is not a probe.
        const rest = yield* Effect.tryPromise({
          try: () => reader.read(),
          catch: () => new SourceError({ reason: "git" }),
        });
        if (buffered.length !== parsed.length || !rest.done) {
          yield* release;
          return yield* new SourceError({ reason: "protected" });
        }
      } else if (parsed.commands.some((update) => refusal(update) !== undefined)) {
        yield* release;
        // Nothing was forwarded, so no ref moved.
        const refused = refusePush(
          parsed.commands,
          parsed.capabilities,
          (update) => refusal(update) ?? "another ref in this push is protected",
          "This push was refused. Branches named __executor/... hold retained versions, and main cannot be deleted. No ref was changed.",
        );
        if (refused === undefined) return yield* new SourceError({ reason: "protected" });
        return refused;
      }
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          if (buffered.length > 0) controller.enqueue(buffered);
        },
        pull: async (controller) => {
          const next = await reader.read();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        cancel: (reason) => reader.cancel(reason),
      });
      const init: RequestInit & { readonly duplex: "half" } = {
        method: request.method,
        headers: request.headers,
        body,
        duplex: "half",
      };
      const forwarded = backend.request(id, new Request(request.url, init));
      if (parsed.commands.length === 0) return yield* forwarded;
      // The backend failed before the repository answered, for example when it refused the
      // repository token after the pack had started streaming. Git reports a failed request only
      // as an HTTP status; a report names the refs and tells the person to push again.
      return yield* forwarded.pipe(
        Effect.catchIf(
          (error) => error.reason === "git",
          (error) =>
            Effect.fromNullishOr(
              refusePush(
                parsed.commands,
                parsed.capabilities,
                () => "Could not reach the repository; push again",
                "The app's repository could not be reached, so this push may not have been saved. Push again.",
              ),
            ).pipe(Effect.mapError(() => error)),
        ),
      );
    }),
});
