import type { InteractionEnd, InteractionRecords } from "@executor-js/mcp";
import type * as Cloudflare from "alchemy/Cloudflare";
import { Duration, Schema } from "effect";

const prefix = "mcp-request:";
const retention = Duration.toMillis(Duration.days(1));
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
    } catch {}
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
