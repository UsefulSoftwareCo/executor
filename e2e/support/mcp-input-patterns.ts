import { Effect, Schema } from "effect";

const ListedTools = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    inputSchema: Schema.Struct({ properties: Schema.Record(Schema.String, Schema.Unknown) }),
  }),
);
const PatternedString = Schema.Struct({ pattern: Schema.optional(Schema.String) });
const Property = Schema.Struct({
  pattern: Schema.optional(Schema.String),
  anyOf: Schema.optional(Schema.Array(PatternedString)),
});

export const wholeStringInputPattern = (tools: unknown, tool: string, property: string) =>
  Effect.gen(function* () {
    const listed = yield* Schema.decodeUnknownEffect(ListedTools)(tools);
    const advertised = listed.find((entry) => entry.name === tool)?.inputSchema.properties[
      property
    ];
    if (advertised === undefined)
      return yield* Effect.die(`MCP tool ${tool} does not advertise ${property}`);
    const { pattern, anyOf = [] } = yield* Schema.decodeUnknownEffect(Property)(advertised);
    const patterns = [pattern, ...anyOf.map((branch) => branch.pattern)].filter(
      (source) => source !== undefined,
    );
    return new RegExp(`^(?:${patterns.map((source) => `(?:${source})`).join("|")})$`, "u");
  });
