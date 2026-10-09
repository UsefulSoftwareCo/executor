/**
 * Host protocols: what a host and a retained app bundle may say to each other.
 *
 * Every released protocol is frozen in `packages/apps/src/contracts/protocols/<N>.ts` and recorded in
 * `packages/apps/protocols/<N>.json`. The protocol the framework speaks is `protocols/current.ts`,
 * recorded under `frameworkProtocol`. This check keeps three promises:
 *
 * 1. A released protocol never changes: each frozen module still records as its snapshot says.
 * 2. The live protocol is recorded: `current.ts` records as its snapshot says, so every boundary
 *    change is a reviewed diff. `--write` re-records it, and refuses when the new record breaks
 *    promise 3 against the committed one.
 * 3. The live protocol keeps every released protocol's bundles running. For a message a bundle
 *    sends, the live schema accepts everything the released schema accepts. For a message the
 *    host sends, the released schema accepts everything the live schema sends, except additions
 *    that `packages/apps/protocols/gates.json` says the host gates on something the bundle
 *    declared, and messages an adapter in `packages/sdk/src/implementation/app-protocols.ts`
 *    converts.
 *
 * A snapshot records Effect's schema representation of each message's JSON form, without
 * documentation, type-only and derived annotations. It records only the messages that differ from
 * the previous protocol, including differences inside the named schemas they reach, and lists the
 * rest in `unchanged`. A subtree equal to another message is written as `{"$message": name}`, and
 * a large subtree that repeats as `{"$shared": hash}`.
 *
 * `--write` records a missing snapshot and re-records the live protocol's. `--base <dir>` also
 * checks the live protocol against the snapshot a base checkout recorded for the same number, so a
 * pull request cannot narrow what the same protocol number accepted before it. `--directory <dir>`
 * reads and records another directory, for trying a change to this script.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { Array as Arr, Schema, SchemaRepresentation } from "effect";
import { frameworkProtocol } from "../packages/apps/src/contracts/protocol-version.ts";
import { current, messageDirections } from "../packages/apps/src/contracts/protocols/current.ts";
import { releasedProtocols } from "../packages/apps/src/contracts/protocols/released.ts";
import { supportedProtocols } from "../packages/sdk/src/implementation/app-protocols.ts";

const args = process.argv.slice(2);
const write = args.includes("--write");
const option = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const fromCwd = (path: string) =>
  new URL(`${path.replace(/\/?$/, "/")}`, `file://${process.cwd()}/`);
const chosen = option("--directory");
const directory =
  chosen === undefined ? new URL("../packages/apps/protocols/", import.meta.url) : fromCwd(chosen);
const base = option("--base");

type Json = null | boolean | number | string | Json[] | { readonly [key: string]: Json };
type Node = { readonly [key: string]: Json };
interface Protocol {
  readonly version: number;
  readonly schemas: Readonly<Record<string, Schema.Top>>;
}
const isNode = (value: Json): value is Node =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const canonical = (value: Json): string =>
  JSON.stringify(value, (_key, entry: Json) =>
    isNode(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry,
  );
const hash = (value: Json) =>
  createHash("sha256").update(canonical(value)).digest("hex").slice(0, 16);
const mapNode = (value: Json, f: (entry: Json) => Json): Json =>
  Array.isArray(value)
    ? value.map(f)
    : isNode(value)
      ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, f(entry)]))
      : value;

// ---------------------------------------------------------------------------------------------
// Representing a protocol
// ---------------------------------------------------------------------------------------------

/** Documentation and Effect's generated failure text do not change what a message accepts. */
const documentation = new Set([
  "description",
  "title",
  "examples",
  "markdownDescription",
  "expected",
]);
/** Derived from a check's own representation; it changes no accepted value. */
const derived = new Set(["~structural", "arbitraryConstraint"]);
/** Type-level mutability and a filter's abort flag change no accepted value. */
const dropped = new Set(["isMutable", "aborted"]);
/** Empty lists say nothing. */
const lists = new Set(["checks", "indexSignatures", "elements", "rest", "typeParameters"]);

/**
 * The representation as plain JSON. Functions are compiler hooks; a built-in check's hooks follow
 * from its recorded representation. Any other value that JSON cannot hold fails the check.
 */
const plain = (value: unknown, path: string, annotations = false): Json => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry, index) => plain(entry, `${path}[${index}]`));
  if (typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new Error(`${path} is not JSON data: ${String(value)}`);
  const entries: [string, Json][] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "function" || entry === undefined) continue;
    if (annotations ? documentation.has(key) || derived.has(key) : dropped.has(key)) continue;
    const json = plain(entry, `${path}.${key}`, key === "annotations");
    if (key === "annotations" && isNode(json) && Object.keys(json).length === 0) continue;
    if (lists.has(key) && Array.isArray(json) && json.length === 0) continue;
    entries.push([key, json]);
  }
  return Object.fromEntries(entries);
};

/** The plain representation of every message of a protocol, and the named schemas they reach. */
const represent = (protocol: Protocol) => {
  const names = Object.keys(protocol.schemas);
  const asts = names.map((name) => Schema.toCodecJson(protocol.schemas[name]!).ast);
  if (!Arr.isArrayNonEmpty(asts)) throw new Error(`Protocol ${protocol.version} has no messages.`);
  const { representations, references } = SchemaRepresentation.toRepresentations(asts);
  return {
    messages: Object.fromEntries(
      names.map((name, index) => [name, plain(representations[index], name)] as const),
    ) as Record<string, Json>,
    references: Object.fromEntries(
      Object.entries(references).map(([name, ref]) => [name, plain(ref, `reference ${name}`)]),
    ) as Record<string, Json>,
  };
};

/**
 * A tree with every named schema it reaches written in place. A schema that reaches itself keeps a
 * `Reference` at the point of recursion, and `kept` receives that name's definition.
 */
const inline = (
  tree: Json,
  references: Readonly<Record<string, Json>>,
  kept: Record<string, Json>,
  expanding: ReadonlySet<string> = new Set(),
): Json => {
  if (isNode(tree) && tree._tag === "Reference" && typeof tree.$ref === "string") {
    const target = references[tree.$ref];
    if (target === undefined) return tree;
    if (expanding.has(tree.$ref)) {
      kept[tree.$ref] = target;
      return tree;
    }
    return inline(target, references, kept, new Set([...expanding, tree.$ref]));
  }
  return mapNode(tree, (entry) => inline(entry, references, kept, expanding));
};

/** Everything a message accepts, as one tree: the fingerprint that decides whether it changed. */
const resolved = (tree: Json, references: Readonly<Record<string, Json>>) => {
  const kept: Record<string, Json> = {};
  return { tree: inline(tree, references, kept), references: kept };
};

// ---------------------------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------------------------

/** One recorded protocol file. */
interface Snapshot {
  readonly protocol: number;
  readonly previous: number | null;
  readonly messages: Readonly<Record<string, Json>>;
  readonly unchanged: readonly string[];
  readonly references: Readonly<Record<string, Json>>;
  readonly shared: Readonly<Record<string, Json>>;
}
const SnapshotSchema = Schema.Struct({
  protocol: Schema.Int,
  previous: Schema.NullOr(Schema.Int),
  messages: Schema.Record(Schema.String, Schema.Json),
  unchanged: Schema.Array(Schema.String),
  references: Schema.Record(Schema.String, Schema.Json),
  shared: Schema.Record(Schema.String, Schema.Json),
});
const decodeSnapshot = Schema.decodeUnknownSync(Schema.fromJsonString(SnapshotSchema));

/** Subtrees at least this long that repeat within one snapshot are recorded once. */
const sharedThreshold = 1200;

/** Every `$ref` name a tree reaches, through the named schemas it reaches. */
const reached = (roots: readonly Json[], references: Readonly<Record<string, Json>>) => {
  const names = new Set<string>();
  const visit = (value: Json): void => {
    if (isNode(value) && value._tag === "Reference" && typeof value.$ref === "string") {
      if (names.has(value.$ref)) return;
      names.add(value.$ref);
      const target = references[value.$ref];
      if (target !== undefined) visit(target);
      return;
    }
    if (Array.isArray(value)) value.forEach(visit);
    else if (isNode(value)) Object.values(value).forEach(visit);
  };
  roots.forEach(visit);
  return names;
};

/**
 * Record a protocol against the previous one. A message that accepts exactly what the previous
 * protocol's did, named schemas included, is listed in `unchanged`; every other message is recorded.
 */
const record = (protocol: Protocol, previous: Protocol | undefined): Snapshot => {
  const full = represent(protocol);
  const before = previous === undefined ? undefined : represent(previous);
  const fingerprint = (rep: typeof full, name: string) =>
    canonical(resolved(rep.messages[name]!, rep.references).tree);
  const names = Object.keys(full.messages);
  const unchanged = names.filter(
    (name) =>
      before !== undefined &&
      name in before.messages &&
      fingerprint(before, name) === fingerprint(full, name),
  );
  const recorded = names.filter((name) => !unchanged.includes(name));
  // A subtree equal to another message is named. Outermost first.
  const byMessage = new Map(names.map((name) => [canonical(full.messages[name]!), name] as const));
  const withMessages = (value: Json, self: string, root: boolean): Json => {
    if (!root && isNode(value)) {
      const other = byMessage.get(canonical(value));
      if (other !== undefined && other !== self) return { $message: other };
    }
    return mapNode(value, (entry) => withMessages(entry, self, false));
  };
  const messages: Record<string, Json> = {};
  for (const name of recorded) messages[name] = withMessages(full.messages[name]!, name, true);
  // A large subtree that repeats is recorded once, under its content hash.
  const counts = new Map<string, number>();
  const count = (value: Json): void => {
    if (isNode(value) && !("$message" in value)) {
      const key = canonical(value);
      if (key.length >= sharedThreshold) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (Array.isArray(value)) value.forEach(count);
    else if (isNode(value) && !("$message" in value)) Object.values(value).forEach(count);
  };
  Object.values(messages).forEach(count);
  const shared: Record<string, Json> = {};
  const withShared = (value: Json): Json => {
    if (isNode(value) && !("$message" in value)) {
      const key = canonical(value);
      if (key.length >= sharedThreshold && (counts.get(key) ?? 0) > 1) {
        const id = hash(value);
        if (!(id in shared)) shared[id] = mapNode(value, withShared);
        return { $shared: id };
      }
    }
    return mapNode(value, withShared);
  };
  for (const name of recorded) messages[name] = withShared(messages[name]!);
  const names2 = reached(
    recorded.map((name) => full.messages[name]!),
    full.references,
  );
  return JSON.parse(
    JSON.stringify({
      protocol: protocol.version,
      previous: previous?.version ?? null,
      messages,
      unchanged,
      references: Object.fromEntries(
        Object.entries(full.references).filter(([name]) => names2.has(name)),
      ),
      shared: Object.fromEntries(Object.entries(shared).sort(([a], [b]) => (a < b ? -1 : 1))),
    }),
  );
};

// ---------------------------------------------------------------------------------------------
// Reading a chain of snapshots back into whole messages
// ---------------------------------------------------------------------------------------------

/** A message as one tree, with the named schemas left at points of recursion. */
interface Whole {
  readonly tree: Json;
  readonly references: Readonly<Record<string, Json>>;
}

/** Read messages of any protocol in a chain of snapshots, through `unchanged`, `$message` and `$shared`. */
const reader = (snapshots: ReadonlyMap<number, Snapshot>) => {
  const owner = (protocol: number, name: string): Snapshot => {
    const snapshot = snapshots.get(protocol);
    if (snapshot === undefined) throw new Error(`Protocol ${protocol} has no snapshot.`);
    if (name in snapshot.messages) return snapshot;
    if (!snapshot.unchanged.includes(name) || snapshot.previous === null)
      throw new Error(`Protocol ${protocol} has no message ${name}.`);
    return owner(snapshot.previous, name);
  };
  const whole = (protocol: number, name: string): Whole => {
    const snapshot = owner(protocol, name);
    const kept: Record<string, Json> = {};
    const expand = (value: Json): Json => {
      if (isNode(value)) {
        if (typeof value.$message === "string") {
          const nested = whole(snapshot.protocol, value.$message);
          for (const [key, ref] of Object.entries(nested.references))
            kept[`${key}@${snapshot.protocol}`] = ref;
          return nested.tree;
        }
        if (typeof value.$shared === "string") {
          const target = snapshot.shared[value.$shared];
          if (target === undefined)
            throw new Error(`Protocol ${snapshot.protocol} lacks shared ${value.$shared}.`);
          return expand(target);
        }
      }
      return mapNode(value, expand);
    };
    const own = resolved(expand(snapshot.messages[name]!), snapshot.references);
    // Names at points of recursion are scoped by the snapshot that defines them.
    const scoped = (value: Json): Json =>
      isNode(value) &&
      value._tag === "Reference" &&
      typeof value.$ref === "string" &&
      value.$ref in own.references
        ? { ...value, $ref: `${value.$ref}@${snapshot.protocol}` }
        : mapNode(value, scoped);
    for (const [key, ref] of Object.entries(own.references))
      kept[`${key}@${snapshot.protocol}`] = scoped(ref);
    return { tree: scoped(own.tree), references: kept };
  };
  const names = (protocol: number): string[] => {
    const snapshot = snapshots.get(protocol);
    if (snapshot === undefined) throw new Error(`Protocol ${protocol} has no snapshot.`);
    return [...Object.keys(snapshot.messages), ...snapshot.unchanged];
  };
  return { whole, names };
};

// ---------------------------------------------------------------------------------------------
// Acceptance: does a reader's schema accept every value a writer's schema produces?
// ---------------------------------------------------------------------------------------------

type Excess = "ignore" | "error";
interface Violation {
  readonly path: string;
  readonly reason: string;
}

/** A union member's label: its discriminating literal, or its position. */
const label = (node: Json, index: number): string => {
  if (isNode(node) && node._tag === "Literal") return `=${String(node.literal)}`;
  if (isNode(node) && Array.isArray(node.propertySignatures))
    for (const preferred of ["operation", "type", "_tag", "ok"])
      for (const signature of node.propertySignatures)
        if (
          isNode(signature) &&
          signature.name === preferred &&
          isNode(signature.type) &&
          signature.type._tag === "Literal"
        )
          return `${preferred}=${String(signature.type.literal)}`;
  return `[${index}]`;
};
const checksOf = (node: Node): Json[] => (Array.isArray(node.checks) ? node.checks : []);
const checkKey = (check: Json) =>
  isNode(check) && check.representation !== undefined ? canonical(check.representation) : undefined;
const describe = (node: Json) => {
  if (!isNode(node)) return JSON.stringify(node);
  if (node._tag === "Literal") return `the literal ${JSON.stringify(node.literal)}`;
  if (node._tag === "Reference") return `a reference to ${String(node.$ref)}`;
  return `a ${String(node._tag)}`;
};
const describeCheck = (check: Json) => {
  if (!isNode(check) || !isNode(check.representation)) return "a custom filter";
  const id = String(check.representation.id).replace(/^effect\/schema\//, "");
  const payload = check.representation.payload;
  return payload === null || payload === undefined ? id : `${id} ${JSON.stringify(payload)}`;
};

/**
 * Violations of "the reader accepts every value the writer produces". `excess` says what the reader
 * does with object properties it does not declare. A pair of recursive references is assumed to hold
 * while it is being checked, so recursion terminates.
 */
const accepts = (
  reader: Whole,
  writer: Whole,
  excess: Excess,
  skip: ReadonlySet<string>,
): Violation[] => {
  const violations: Violation[] = [];
  const assumed = new Set<string>();
  const resolve = (value: Json, side: Whole): Json => {
    let node = value;
    for (let depth = 0; isNode(node) && node._tag === "Reference" && depth < 50; depth++) {
      const target = side.references[String(node.$ref)];
      if (target === undefined) return node;
      node = target;
    }
    return node;
  };
  const fail = (path: string, reason: string) => violations.push({ path, reason });
  const visit = (r: Json, w: Json, path: string): void => {
    if (isNode(r) && r._tag === "Reference" && isNode(w) && w._tag === "Reference") {
      const key = `${String(r.$ref)}|${String(w.$ref)}`;
      if (assumed.has(key)) return;
      assumed.add(key);
    }
    compare(resolve(r, reader), resolve(w, writer), path);
  };
  /** Whether an alternative holds, without recording its violations. */
  const holds = (r: Json, w: Json, path: string): boolean => {
    const saved = violations.length;
    visit(r, w, path);
    const ok = violations.length === saved;
    violations.length = saved;
    return ok;
  };
  const compare = (r: Json, w: Json, path: string): void => {
    if (skip.has(path)) return;
    if (!isNode(r) || !isNode(w)) {
      if (!isDeepStrictEqual(r, w)) fail(path, "the schemas differ");
      return;
    }
    if (r._tag === "Unknown" || r._tag === "Any" || w._tag === "Never") return;
    if (w._tag === "Union" && Array.isArray(w.types)) {
      const members = Array.isArray(r.types) && r._tag === "Union" ? r.types : [r];
      w.types.forEach((member, index) => {
        const resolvedMember = resolve(member, writer);
        const at = `${path}/${label(resolvedMember, index)}`;
        // One reader member with the same discriminator is compared in full, so the violation
        // names the property that differs. Otherwise some member must accept it.
        const twins = members.filter(
          (candidate, i) =>
            label(resolve(candidate, reader), i) === label(resolvedMember, index) &&
            !label(resolvedMember, index).startsWith("["),
        );
        if (twins.length === 1) visit(twins[0]!, member, at);
        else if (!members.some((candidate) => holds(candidate, member, at)))
          fail(at, "no member of the reader's union accepts this member of the writer's");
      });
      return;
    }
    if (r._tag === "Union" && Array.isArray(r.types)) {
      if (!r.types.some((candidate) => holds(candidate, w, path)))
        fail(path, `no member of the reader's union accepts ${describe(w)}`);
      return;
    }
    if (r._tag !== w._tag) {
      fail(path, `the reader is ${describe(r)}, the writer ${describe(w)}`);
      return;
    }
    switch (r._tag) {
      case "Literal":
        if (r.literal !== w.literal)
          fail(
            path,
            `the reader accepts only ${JSON.stringify(r.literal)}, the writer sends ${JSON.stringify(w.literal)}`,
          );
        return;
      case "Objects": {
        const rs = Array.isArray(r.propertySignatures) ? r.propertySignatures.filter(isNode) : [];
        const ws = Array.isArray(w.propertySignatures) ? w.propertySignatures.filter(isNode) : [];
        for (const property of ws) {
          const name = String(property.name);
          const own = rs.find((candidate) => candidate.name === property.name);
          if (own === undefined) {
            if (excess === "error")
              fail(`${path}/${name}`, "the writer sends a property the reader rejects as excess");
            continue;
          }
          if (property.isOptional === true && own.isOptional !== true)
            fail(`${path}/${name}`, "the writer may omit a property the reader requires");
          visit(own.type ?? null, property.type ?? null, `${path}/${name}`);
        }
        for (const own of rs)
          if (own.isOptional !== true && !ws.some((property) => property.name === own.name))
            fail(
              `${path}/${String(own.name)}`,
              "the reader requires a property the writer never sends",
            );
        const ri = Array.isArray(r.indexSignatures) ? r.indexSignatures.filter(isNode) : [];
        const wi = Array.isArray(w.indexSignatures) ? w.indexSignatures.filter(isNode) : [];
        wi.forEach((signature, index) => {
          const at = `${path}/[key${index}]`;
          if (ri.length === 0) {
            if (excess === "error") fail(at, "the writer sends keys the reader rejects as excess");
            return;
          }
          if (
            !ri.some(
              (own) =>
                holds(own.parameter ?? null, signature.parameter ?? null, at) &&
                holds(own.type ?? null, signature.type ?? null, `${at}/value`),
            )
          )
            fail(at, "no index signature of the reader accepts the writer's keys and values");
        });
        checks(r, w, path);
        return;
      }
      case "Arrays": {
        const re = Array.isArray(r.elements) ? r.elements : [];
        const we = Array.isArray(w.elements) ? w.elements : [];
        const rr = Array.isArray(r.rest) ? r.rest : [];
        const wr = Array.isArray(w.rest) ? w.rest : [];
        we.forEach((element, index) => {
          const own = re[index] ?? rr[0];
          if (own === undefined)
            fail(
              `${path}/[${index}]`,
              "the writer sends an element the reader has no position for",
            );
          else visit(own, element, `${path}/[${index}]`);
        });
        if (re.length > we.length && wr.length === 0)
          fail(path, "the reader requires more elements than the writer sends");
        wr.forEach((element, index) => {
          const own = rr[index] ?? rr[0];
          if (own === undefined) fail(`${path}/[]`, "the writer sends elements the reader rejects");
          else visit(own, element, `${path}/[]`);
        });
        checks(r, w, path);
        return;
      }
      case "Declaration":
        if (!isDeepStrictEqual(r.representation, w.representation))
          fail(path, "the declarations differ");
        checks(r, w, path);
        return;
      default:
        checks(r, w, path);
    }
  };
  /** Every check the reader makes must be a check the writer also made. */
  const checks = (r: Node, w: Node, path: string) => {
    const keys = checksOf(w).map(checkKey);
    let opaque = keys.filter((key) => key === undefined).length;
    for (const check of checksOf(r)) {
      const key = checkKey(check);
      if (key === undefined) {
        if (opaque > 0) opaque -= 1;
        else fail(path, "the reader applies a custom filter the writer did not");
      } else if (!keys.includes(key))
        fail(path, `the reader checks ${describeCheck(check)}, which the writer did not`);
    }
  };
  visit(reader.tree, writer.tree, "");
  return violations.map((violation) => ({
    ...violation,
    path: violation.path.replace(/^\//, "") || ".",
  }));
};

// ---------------------------------------------------------------------------------------------
// Gates: additions the host sends only to bundles that declared support, and adapted messages
// ---------------------------------------------------------------------------------------------

const Gates = Schema.Struct({
  /** Messages of released protocols that an adapter converts into the live model. */
  adapted: Schema.Array(
    Schema.Struct({
      message: Schema.String,
      protocols: Schema.Array(Schema.Int),
      adapter: Schema.String,
    }),
  ),
  /** Differences in a message the host sends, sent only when the bundle declared support. */
  additions: Schema.Array(
    Schema.Struct({
      message: Schema.String,
      path: Schema.String,
      /** The first protocol whose bundles accept it; every earlier protocol needs the gate. */
      since: Schema.Int,
      gate: Schema.String,
    }),
  ),
});
type Gates = typeof Gates.Type;
const decodeGates = Schema.decodeUnknownSync(Schema.fromJsonString(Gates));
const gatesFile = new URL("gates.json", directory);
const gates: Gates = existsSync(gatesFile)
  ? decodeGates(readFileSync(gatesFile, "utf8"))
  : { adapted: [], additions: [] };

/**
 * Whether the live protocol, read from `ours`, keeps the promises of each `against` protocol, read
 * from `theirs`. Returns the problems, and records which gates were needed in `used`.
 */
const compatibility = (
  ours: ReadonlyMap<number, Snapshot>,
  liveVersion: number,
  theirs: ReadonlyMap<number, Snapshot>,
  against: readonly number[],
  used: Set<string>,
): string[] => {
  const problems: string[] = [];
  const mine = reader(ours);
  const other = reader(theirs);
  const liveNames = new Set(mine.names(liveVersion));
  for (const version of against) {
    const theirNames = other.names(version);
    for (const name of theirNames) {
      const direction = (messageDirections as Record<string, "host" | "bundle" | undefined>)[name];
      if (direction === undefined) {
        problems.push(
          `Protocol ${version}'s message ${name} has no direction in protocols/current.ts.`,
        );
        continue;
      }
      const released = other.whole(version, name);
      if (!liveNames.has(name)) {
        const adapted = gates.adapted.find(
          (entry) => entry.message === name && entry.protocols.includes(version),
        );
        if (adapted === undefined)
          problems.push(
            `Protocol ${version}'s message ${name} is gone from the live protocol and no adapter in gates.json converts it.`,
          );
        else used.add(`adapted:${adapted.message}:${version}`);
        continue;
      }
      const live = mine.whole(liveVersion, name);
      // The invocation's command is checked as `request`, and its accounts as `accounts` where that message exists.
      const skip = new Set<string>();
      if (name === "invocation") {
        skip.add("/command");
        if (theirNames.includes("accounts")) skip.add("/accounts");
      }
      const violations =
        direction === "bundle"
          ? accepts(live, released, "ignore", skip)
          : accepts(released, live, name === "request" ? "error" : "ignore", skip);
      for (const violation of violations) {
        const gate =
          direction === "host"
            ? gates.additions.find(
                (entry) =>
                  entry.message === name && entry.path === violation.path && version < entry.since,
              )
            : undefined;
        if (gate !== undefined) {
          used.add(`addition:${gate.message}:${gate.path}:${gate.since}`);
          continue;
        }
        problems.push(
          direction === "bundle"
            ? `Protocol ${version}'s bundles may send ${name} ${violation.path} that the live host rejects: ${violation.reason}.`
            : `The live host may send protocol ${version}'s bundles ${name} ${violation.path}, which they reject: ${violation.reason}. Gate it in gates.json or convert it in an adapter.`,
        );
      }
    }
  }
  return problems;
};

// ---------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------

const readSnapshot = (file: URL): Snapshot | undefined =>
  existsSync(file) ? decodeSnapshot(readFileSync(file, "utf8")) : undefined;
const file = (protocol: number, from = directory) => new URL(`${protocol}.json`, from);
const save = (snapshot: Snapshot) =>
  writeFileSync(file(snapshot.protocol), `${JSON.stringify(snapshot, null, 2)}\n`);

/** Messages and named schemas whose record differs. */
const differences = (a: Snapshot, b: Snapshot): string[] => {
  const out: string[] = [];
  for (const name of new Set([
    ...Object.keys(a.messages),
    ...Object.keys(b.messages),
    ...a.unchanged,
    ...b.unchanged,
  ])) {
    const inA =
      name in a.messages ? a.messages[name] : a.unchanged.includes(name) ? "unchanged" : undefined;
    const inB =
      name in b.messages ? b.messages[name] : b.unchanged.includes(name) ? "unchanged" : undefined;
    if (!isDeepStrictEqual(inA, inB)) out.push(name);
  }
  for (const name of Object.keys(a.references))
    if (name in b.references && !isDeepStrictEqual(a.references[name], b.references[name]))
      out.push(`reference ${name}`);
  if (out.length === 0 && !isDeepStrictEqual(a.shared, b.shared)) out.push("shared subtrees");
  if (a.previous !== b.previous) out.push("previous protocol");
  return out;
};

const failures: string[] = [];
const chain: readonly Protocol[] = releasedProtocols;
const live: Protocol = current;
const generated = new Map<number, Snapshot>();
chain.forEach((protocol, index) =>
  generated.set(protocol.version, record(protocol, chain[index - 1])),
);
generated.set(live.version, record(live, chain[chain.length - 1]));
const committed = new Map<number, Snapshot>();
for (const protocol of [...chain, live]) {
  const existing = readSnapshot(file(protocol.version));
  if (existing !== undefined) committed.set(protocol.version, existing);
}
/** Every snapshot as recorded so far, with the live protocol as it is now. */
const ours = () => new Map([...committed, [live.version, generated.get(live.version)!]]);
const releasedVersions = chain.map((protocol) => protocol.version);

// 1. Released protocols are frozen.
for (const protocol of chain) {
  const existing = committed.get(protocol.version);
  const fresh = generated.get(protocol.version)!;
  if (existing === undefined) {
    if (write) {
      save(fresh);
      committed.set(protocol.version, fresh);
      console.log(`Recorded protocol ${protocol.version}.`);
    } else
      failures.push(`Protocol ${protocol.version} has no snapshot. Run with --write to record it.`);
  } else if (!isDeepStrictEqual(existing, fresh))
    failures.push(
      `Released protocol ${protocol.version} changed (${differences(existing, fresh).join(", ") || "its record"}). ` +
        "Released protocols are immutable: restore its module. A boundary change belongs in protocols/current.ts.",
    );
}

// 2. The live protocol is recorded. A new record must keep the committed record's promises.
{
  const existing = committed.get(live.version);
  const fresh = generated.get(live.version)!;
  if (existing === undefined) {
    if (write) {
      save(fresh);
      committed.set(live.version, fresh);
      console.log(`Recorded the live protocol ${live.version}.`);
    } else
      failures.push(
        `The live protocol ${live.version} has no snapshot. Run with --write to record it.`,
      );
  } else if (!isDeepStrictEqual(existing, fresh)) {
    const changed = differences(existing, fresh).join(", ");
    if (!write)
      failures.push(
        `The live protocol ${live.version} differs from its snapshot (${changed}). ` +
          "Run `bun run apps:protocols --write` to record the boundary change, then review the diff.",
      );
    else {
      const problems = compatibility(ours(), live.version, committed, [live.version], new Set());
      if (problems.length === 0) {
        save(fresh);
        committed.set(live.version, fresh);
        console.log(`Re-recorded the live protocol ${live.version} (${changed}).`);
      } else
        failures.push(
          `The live protocol no longer keeps the promises protocol ${live.version} made, so --write left its snapshot alone:`,
          ...problems.map((problem) => `  ${problem}`),
          "Gate the addition in packages/apps/protocols/gates.json, or freeze current.ts as a released protocol and raise frameworkProtocol.",
        );
    }
  }
}

// 3. The live protocol keeps every released protocol's bundles running, and every gate is needed.
if (releasedVersions.every((version) => committed.has(version))) {
  const used = new Set<string>();
  const problems = compatibility(ours(), live.version, committed, releasedVersions, used);
  for (const entry of gates.adapted)
    for (const protocol of entry.protocols)
      if (!used.has(`adapted:${entry.message}:${protocol}`))
        problems.push(
          `gates.json adapts ${entry.message} for protocol ${protocol}, but the live protocol still has it or ${protocol} is not released.`,
        );
  for (const entry of gates.additions)
    if (!used.has(`addition:${entry.message}:${entry.path}:${entry.since}`))
      problems.push(
        `gates.json gates ${entry.message} ${entry.path} since ${entry.since}, but no released protocol needs it.`,
      );
  if (problems.length > 0)
    failures.push(
      "The live protocol does not keep every released protocol's bundles running:",
      ...problems.map((problem) => `  ${problem}`),
    );
  if (base !== undefined) {
    const baseFile = file(live.version, fromCwd(base));
    // A base from before this record format has nothing comparable.
    const baseSnapshot = ((): Snapshot | undefined => {
      try {
        return readSnapshot(baseFile);
      } catch {
        return undefined;
      }
    })();
    if (baseSnapshot === undefined)
      console.log(
        existsSync(baseFile)
          ? `The base records protocol ${live.version} in an older format; there is nothing to compare.`
          : `The base has no snapshot of protocol ${live.version}: the number changed, so there is nothing to compare.`,
      );
    else {
      const theirs = new Map([...committed, [live.version, baseSnapshot]]);
      const problems2 = compatibility(ours(), live.version, theirs, [live.version], new Set());
      if (problems2.length > 0)
        failures.push(
          `The live protocol narrows what protocol ${live.version} accepted at the base:`,
          ...problems2.map((problem) => `  ${problem}`),
        );
      else
        console.log(`The live protocol keeps what protocol ${live.version} accepted at the base.`);
    }
  }
}

// 4. Bookkeeping: every snapshot belongs to a protocol, and hosts support every protocol.
for (const name of readdirSync(directory)) {
  if (!name.endsWith(".json") || name === "gates.json") continue;
  const version = Number(name.replace(/\.json$/, ""));
  if (version !== live.version && !releasedVersions.includes(version))
    failures.push(
      `Snapshot ${name} has no released protocol. Released protocols are never removed.`,
    );
}
if (live.version !== frameworkProtocol)
  failures.push(
    `current.ts speaks protocol ${live.version}, protocol-version.ts says ${frameworkProtocol}.`,
  );
if (!supportedProtocols.includes(live.version))
  failures.push(`Hosts do not support protocol ${live.version}, which the framework speaks.`);
for (const version of releasedVersions)
  if (!supportedProtocols.includes(version))
    failures.push(`Hosts dropped released protocol ${version}; retained builds still speak it.`);
if (releasedVersions.some((version) => version >= live.version))
  failures.push(`A released protocol is numbered at or above the live protocol ${live.version}.`);

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
console.log(
  `Host protocols ${releasedVersions.join(", ")} unchanged; the live protocol ${live.version} is recorded and keeps their bundles running.`,
);
