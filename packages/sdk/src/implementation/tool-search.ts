/**
 * Tool search over listings kept as rows: Okapi BM25 over the words of each tool, its routers and
 * its target's labels. A listing's rows keep each shared `$defs` entry once, as the durable
 * listing text does; only a page's tools are put back together with their definitions.
 */
import { Crypto, Effect, JsonPointer, Schema } from "effect";
import { Hex } from "effect/encoding";
import { type Json, JsonObject, StorageError } from "../contracts/shared.ts";
import { invocationEntries, type AppAccounts } from "../contracts/apps.ts";
import {
  type Tool,
  type ToolSearchInput,
  type ToolSearchItem,
  type ToolSearchListing,
  type ToolSearchPage,
} from "../contracts/tools.ts";
import type { ToolListing } from "./listings.ts";
import { restoreTool, shareListing, type StoredTool } from "./listing-json.ts";
import type { InvocationSnapshot } from "./tools.ts";
import { scopedSelection } from "./selection.ts";
import type { SearchToolRow, ToolSearchStore } from "./tool-search-store.ts";

/** Lowercase words, with camelCase and snake_case split and a plural `s` removed. */
export const words = (text: string): Array<string> =>
  text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "")
    .map(stem);

const stem = (word: string) =>
  word.length > 4 && word.endsWith("ies")
    ? `${word.slice(0, -3)}y`
    : word.length > 3 && word.endsWith("s") && !word.endsWith("ss")
      ? word.slice(0, -1)
      : word;

/**
 * The names and descriptions of a tool's top-level input properties, after a top-level reference,
 * read from its listed schema.
 */
const inputText = (tool: Tool): ReadonlyArray<string> => {
  const input: JsonObject = Schema.is(JsonObject)(tool.inputSchema) ? tool.inputSchema : {};
  const ref = typeof input.$ref === "string" ? input.$ref : undefined;
  const reference = ref?.match(/^#\/(?:\$defs|definitions)\/([^/]+)$/)?.[1];
  const definitions = { ...objectOf(input.definitions), ...objectOf(input.$defs) };
  const properties = objectOf(
    ref === undefined
      ? input.properties
      : reference === undefined
        ? undefined
        : objectOf(definitions[JsonPointer.unescapeToken(reference)]).properties,
  );
  return Object.entries(properties).flatMap(([name, property]) => {
    const description = objectOf(property).description;
    return typeof description === "string" ? [name, description] : [name];
  });
};
const objectOf = (value: unknown): JsonObject => (Schema.is(JsonObject)(value) ? value : {});

const encoder = new TextEncoder();

/** The words a tool ranks by, without its target's labels. */
const toolTerms = (listing: ToolListing, tool: Tool) => {
  const root = listing.routers.find((router) => router.path === "");
  const router =
    tool.router === undefined
      ? undefined
      : listing.routers.find((candidate) => candidate.path === tool.router);
  return [
    root?.title ?? "",
    root?.description ?? "",
    tool.name,
    tool.title ?? "",
    tool.description,
    ...inputText(tool),
    router?.title ?? "",
    router?.description ?? "",
  ].flatMap(words);
};

export const makeToolSearch = (options: {
  readonly store: ToolSearchStore;
  readonly crypto: Crypto.Crypto;
}) => {
  const { store } = options;
  const digest = (text: string) =>
    options.crypto.digest("SHA-256", encoder.encode(text)).pipe(
      Effect.map(Hex.encode),
      Effect.mapError(() => new StorageError()),
    );
  /**
   * The target a listing belongs to: a digest of the account set it was evaluated with, each
   * requirement's accounts in ID order. Requirements without accounts name none. Requirement
   * names are unique across scopes; a listing evaluated without a caller is marked as such.
   */
  const target = (accounts: AppAccounts) => {
    const named = invocationEntries(accounts)
      .filter(([, ids]) => ids.length > 0)
      .map(([slot, ids]) => [slot, [...new Set(ids)].sort()] as const)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return digest(JSON.stringify(accounts.user === undefined ? ["app", named] : named));
  };
  /** The target of an invocation state's listing. */
  const stateTarget = (state: InvocationSnapshot) =>
    target(scopedSelection(state.deployment.requirements.accounts, state.accounts, state.scope));
  /**
   * Digests of definitions, and what makes two targets' tools of one name the same result:
   * everything agents read but the name. Kept listings share their tool and definition objects,
   * so a listing written again reuses these.
   */
  const definitionDigests = new WeakMap<object, string>();
  const signatures = new WeakMap<Tool, string>();
  /** The rows of a listing, its definitions once, without encoding any tool's JSON. */
  const rows = (listing: ToolListing) =>
    Effect.gen(function* () {
      const { stored } = shareListing(listing);
      const definitionDigest = Effect.fnUntraced(function* (position: number) {
        const definition: Json | undefined = stored.definitions[position];
        const known =
          typeof definition === "object" && definition !== null
            ? definitionDigests.get(definition)
            : undefined;
        if (known !== undefined) return known;
        const computed = yield* digest(JSON.stringify(definition ?? null));
        if (typeof definition === "object" && definition !== null)
          definitionDigests.set(definition, computed);
        return computed;
      });
      const derived: Array<SearchToolRow> = [];
      for (const [index, tool] of listing.items.entries()) {
        const kept: StoredTool = stored.tools[index] ?? tool;
        const positions = new Set<number>();
        /** A stored schema with its definitions' positions replaced by their digests. */
        const digested = (schema: JsonObject | undefined) =>
          Effect.gen(function* () {
            if (schema === undefined) return null;
            // Entries, not assignment, so a definition named `__proto__` stays an own entry.
            const named: Array<[string, string]> = [];
            for (const [name, at] of Object.entries(objectOf(schema.$defs)))
              if (typeof at === "number") {
                positions.add(at);
                named.push([name, yield* definitionDigest(at)]);
              }
            return { ...schema, $defs: Object.fromEntries(named) };
          });
        const shared = new Set(kept.shared ?? []);
        const input = shared.has("inputSchema") ? yield* digested(kept.inputSchema) : null;
        const output = shared.has("outputSchema") ? yield* digested(kept.outputSchema) : null;
        let signature = signatures.get(tool);
        if (signature === undefined) {
          signature = yield* digest(
            JSON.stringify([
              tool.description,
              tool.router ?? null,
              input ?? kept.inputSchema,
              output ?? kept.outputSchema ?? null,
            ]),
          );
          signatures.set(tool, signature);
        }
        derived.push({
          name: tool.name,
          readOnly: tool.readOnly === true,
          terms: toolTerms(listing, tool),
          signature,
          tool: kept,
          definitions: [...positions].sort((left, right) => left - right),
        });
      }
      return { tools: derived, definitions: stored.definitions };
    });
  return {
    /** The kept rows of the state's listing, if any. */
    listing: (state: InvocationSnapshot, listing: ToolSearchListing) =>
      Effect.flatMap(stateTarget(state), (target) => store.listing(listing, target)),
    revive: store.revive,
    /**
     * Keep a listing's rows. The rows' digest covers what ranking and results read, so a listing
     * evaluated again without changes rewrites none of them. Each tool's JSON is encoded only in
     * the batch that inserts it. A failure leaves the rows that were kept.
     */
    write: (state: InvocationSnapshot, id: ToolSearchListing, listing: ToolListing, at: number) =>
      Effect.gen(function* () {
        const content = yield* rows(listing);
        const digested = yield* digest(
          [
            JSON.stringify(listing.routers),
            ...content.tools.flatMap((row) => [
              row.name,
              row.signature,
              String(row.readOnly),
              row.tool.title ?? "",
              row.terms.join(" "),
            ]),
          ].join("\n"),
        );
        yield* store.write(
          {
            listing: id,
            owner: state.app.owner,
            app: state.app.id,
            deployment: state.deployment.id,
            target: yield* stateTarget(state),
            at,
            digest: digested,
            routers: listing.routers,
          },
          content,
        );
      }).pipe(
        Effect.withSpan("sdk.tools.search.write", {
          attributes: { "executor.app.id": state.app.id, "executor.tools": listing.items.length },
        }),
      ),
    /**
     * One page of ranked tools. A tool several of an app's targets list with the same name and
     * signature is one item at its first target, ranked by its best row; ties keep target and
     * name order, which is also the order of a query without words. Only the page's tools are
     * put back together with the definitions they name.
     */
    page: (input: ToolSearchInput) =>
      Effect.gen(function* () {
        const terms = [...new Set(words(input.query))];
        const targets = yield* Effect.forEach(input.targets, ({ accounts, ...rest }) =>
          Effect.map(target(accounts), (digested) => ({
            ...rest,
            target: digested,
            labels: rest.labels.flatMap(words),
          })),
        );
        const ranked = yield* store.page({
          terms,
          targets,
          offset: input.offset,
          limit: input.limit,
        });
        const definitions = new Map(
          ranked.definitions.map(([listing, position, definition]) => [
            `${listing}\u0000${position}`,
            definition,
          ]),
        );
        const items: Array<ToolSearchItem> = [];
        for (const item of ranked.items) {
          const tool = restoreTool(item.tool, (position) =>
            definitions.get(`${item.listing}\u0000${position}`),
          );
          // The statement read the tool and its definitions together; one missing is corrupt.
          if (tool === undefined) return yield* Effect.fail(new StorageError());
          items.push({
            target: item.target,
            also: item.ordinals.filter((ordinal) => ordinal !== item.target),
            tool,
            router: item.router ?? undefined,
          });
        }
        yield* Effect.annotateCurrentSpan({
          "executor.search.targets": input.targets.length,
          "executor.search.matches": ranked.total,
          "executor.search.missing": ranked.missing.length,
        });
        const result: ToolSearchPage = {
          items,
          remaining: Math.max(0, ranked.total - input.offset - items.length),
          missing: ranked.missing,
        };
        return result;
      }).pipe(Effect.withSpan("sdk.tools.search")),
  };
};
export type ToolSearch = ReturnType<typeof makeToolSearch>;
