/** Queries embedded in each Executor management app; the catalog travels with that deployment. */
import { array, number, object, query, string } from "apps";

const Entry = object({
  symbol: string(),
  kind: string(),
  summary: string(),
  signatures: array(string()),
  definition: string().optional(),
  tags: array(object({ name: string(), text: string() })),
  docs: string(),
  source: string(),
  related: array(string()),
  examples: array(string()),
});
const Identity = object({ version: string(), digest: string() });
const Example = object({
  id: string(),
  title: string(),
  files: array(object({ path: string(), content: string() })),
});
const Reference = object({
  version: string(),
  digest: string(),
  entries: array(Entry),
  examples: array(Example),
});
const Selection = { version: string().optional(), digest: string().optional() };

/** Decode the generated artifact once and expose read-only, credential-free library documentation. */
export const frameworkQueries = (input: unknown) => {
  const reference = Reference.parse(input);
  const identity = { version: reference.version, digest: reference.digest };
  const select = (selection: {
    readonly version?: string | undefined;
    readonly digest?: string | undefined;
  }) => {
    if (
      (selection.version !== undefined && selection.version !== reference.version) ||
      (selection.digest !== undefined && selection.digest !== reference.digest)
    ) {
      throw new Error(
        "Framework reference version does not match. Read the selected apps package's framework-reference.json.",
      );
    }
  };
  return {
    framework_search: query(
      {
        description:
          "Find framework library functions and methods by name or task. These symbols are used in app source, not called as agent tools. Returns the exact framework version and digest for subsequent describes.",
        input: object({ query: string().default(""), offset: number().default(0), ...Selection }),
        output: object({
          reference: Identity,
          items: array(
            object({ symbol: string(), kind: string(), summary: string(), docs: string() }),
          ),
          remaining: number(),
        }),
      },
      async (_ctx, input) => {
        select(input);
        if (!Number.isSafeInteger(input.offset) || input.offset < 0)
          throw new Error("offset must be a nonnegative integer");
        const terms = input.query
          .replace(/([a-z])([A-Z])/g, "$1 $2")
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter(Boolean);
        const ranked = reference.entries
          .map((entry) => ({
            entry,
            score:
              entry.symbol === input.query
                ? 10000
                : terms.reduce(
                    (score, term) =>
                      score +
                      (entry.symbol.toLowerCase().includes(term) ? 4 : 0) +
                      ((entry.summary + " " + entry.docs).toLowerCase().includes(term) ? 1 : 0),
                    0,
                  ),
          }))
          .filter(({ score }) => terms.length === 0 || score > 0)
          .sort((a, b) => b.score - a.score || a.entry.symbol.localeCompare(b.entry.symbol));
        return {
          reference: identity,
          items: ranked.slice(input.offset, input.offset + 12).map(({ entry }) => ({
            symbol: entry.symbol,
            kind: entry.kind,
            summary: entry.summary,
            docs: entry.docs,
          })),
          remaining: Math.max(0, ranked.length - input.offset - 12),
        };
      },
    ),
    framework_describe: query(
      {
        description:
          "Read an exact framework symbol's generated signatures, related types and JSDoc. Pass the version and digest from framework_search to reject stale references. Read its linked skill document for behavior and examples.",
        input: object({ symbol: string(), ...Selection }),
        output: object({
          reference: Identity,
          entry: Entry,
          types: array(Entry),
          examples: array(Example),
        }),
      },
      async (_ctx, input) => {
        select(input);
        const entry = reference.entries.find((entry) => entry.symbol === input.symbol);
        if (entry === undefined)
          throw new Error("Framework symbol not found. Use framework_search first.");
        return {
          reference: identity,
          entry,
          types: reference.entries.filter((candidate) => entry.related.includes(candidate.symbol)),
          examples: reference.examples.filter((example) => entry.examples.includes(example.id)),
        };
      },
    ),
  };
};
