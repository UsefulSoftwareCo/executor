/**
 * Keeps a session object's record of the requests it issued in the object's own storage, so a
 * resume after the object restarted learns what became of its request: answered, expired, ended
 * with its program, or lost with the program when the object restarted while it waited.
 * Programs stay in memory and cannot continue after a restart; only the reason survives.
 *
 * A record holds the caller the request was issued to (the object's own key and the elicitation
 * mode, or the browser session), its deadline and how it ended. It grants nothing: a resume is
 * authenticated and its bearer names this object before the record is read, and a record for
 * another caller reads as unknown. It never holds the request's call, arguments or answer.
 *
 * Each call reads and writes in one synchronous step on the object's synchronous key-value
 * storage, as `mcp-session-store.ts` does. A storage call that throws never fails the program or
 * the resume. A failed issue leaves the request unknown, as it was before this store; a failed end
 * leaves the issue recorded without its end. So a record with no end does not show that the
 * request went unanswered: Executor reads it as `lost`, which claims only what the record holds.
 *
 * A record past its retention reads as unknown. Deletion is lazy, so an idle object is not woken to
 * clean up: issuing a request prunes every record past retention and beyond `kept`, and reading one
 * past retention deletes it. An object holds at most `kept` records between issues.
 */
import type { InteractionEnd, InteractionRecords } from "@executor-js/mcp";
import type * as Cloudflare from "alchemy/Cloudflare";
import { Duration, Schema } from "effect";

const prefix = "mcp-request:";
/** How long after its deadline a request is remembered; a later resume reads as unknown. */
const retention = Duration.toMillis(Duration.days(1));
/** Requests kept per object; the earliest deadlines go first. */
const kept = 256;

const IssuedRecord = Schema.Struct({
  caller: Schema.String,
  expiresAt: Schema.Number,
  end: Schema.optionalKey(Schema.Literals(["answered", "expired", "ended"])),
});
const decodeRecord = Schema.decodeUnknownOption(IssuedRecord);

export const mcpInteractionStore = (
  kv: Cloudflare.DurableObjectStorage["kv"],
  now: () => number,
): InteractionRecords => {
  const key = (id: string) => `${prefix}${id}`;
  const read = (id: string) => {
    const record = decodeRecord(kv.get(key(id)));
    if (record._tag === "None") return undefined;
    if (now() - record.value.expiresAt <= retention) return record.value;
    kv.delete(key(id));
    return undefined;
  };
  // Records past their retention, then beyond `kept` by deadline.
  const prune = () => {
    const at = now();
    const deadlines = Array.from(kv.list({ prefix }), ([name, value]) => {
      const record = decodeRecord(value);
      return { name, expiresAt: record._tag === "Some" ? record.value.expiresAt : 0 };
    }).sort((a, b) => b.expiresAt - a.expiresAt);
    for (const [index, { name, expiresAt }] of deadlines.entries()) {
      if (index >= kept || at - expiresAt > retention) kv.delete(name);
    }
  };
  const step = (work: () => void) => {
    try {
      work();
    } catch {
      // Unknown, or an issue without its end. A later commit failure restarts the object instead.
    }
  };
  return {
    issued: (id, caller, expiresAt) =>
      step(() => {
        kv.put(key(id), { caller, expiresAt });
        prune();
      }),
    ended: (id, end: InteractionEnd) =>
      step(() => {
        const record = read(id);
        // Only the first end is kept, as in memory.
        if (record !== undefined && record.end === undefined) kv.put(key(id), { ...record, end });
      }),
    read: (id) => {
      try {
        return read(id);
      } catch {
        return undefined;
      }
    },
  };
};
