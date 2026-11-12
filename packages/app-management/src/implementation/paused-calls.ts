import { homedir } from "node:os";
/**
 * The MCP session of each call paused for browser approval. A browser approval belongs to the MCP
 * session that made the call, and every tool command opens its own, so `executor resume` continues
 * the paused call's session. The record holds identifiers only: the session ID and its protocol
 * version, which route a request but carry no authority. It is removed once the request is no
 * longer pending.
 */
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { Hex } from "effect/encoding";
import { McpSession } from "./tools-client.ts";

/** A result that waits for an answer given on its approval page. */
const BrowserPause = Schema.Struct({
  status: Schema.Literals(["approval-required", "input-required"]),
  requestId: Schema.String,
  approvalUrl: Schema.String,
});

const recordFile = (host: string, requestId: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const digest = Hex.encode(
      new Uint8Array(
        yield* Effect.promise(() =>
          crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${host}\n${requestId}`)),
        ),
      ),
    );
    const directory = path.join(homedir(), ".local", "state", "executor", "paused");
    return { directory, file: path.join(directory, `${digest}.json`) };
  });

/** The session the paused request `requestId` on `host` was made in, if this CLI made it. */
export const pausedSession = (host: string, requestId: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { file } = yield* recordFile(host, requestId);
    if (!(yield* fs.exists(file))) return Option.none<McpSession>();
    return Schema.decodeUnknownOption(Schema.fromJsonString(McpSession))(
      yield* fs.readFileString(file),
    );
  });

/**
 * After a tool command on `host`: remember the session of a call that now waits for its approval
 * page, and forget the record of `resumed` once it no longer does.
 */
export const recordPause = (
  host: string,
  result: unknown,
  session: Option.Option<McpSession>,
  resumed?: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pause = Schema.decodeUnknownOption(BrowserPause)(result);
    if (Option.isSome(pause) && Option.isSome(session)) {
      const { directory, file } = yield* recordFile(host, pause.value.requestId);
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      yield* fs.writeFileString(temporary, JSON.stringify(session.value), { mode: 0o600 });
      yield* fs.rename(temporary, file);
    }
    if (resumed !== undefined && !(Option.isSome(pause) && pause.value.requestId === resumed))
      yield* fs.remove((yield* recordFile(host, resumed)).file, { force: true });
  });
