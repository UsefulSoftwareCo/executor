import { Schema } from "effect";
import { ToolAnnotationsView } from "@executor-js/sdk";

/** Parse the public search result, including schemas and account identity. */
export const decodeToolSearch = Schema.decodeUnknownSync(
  Schema.Struct({
    structuredContent: Schema.Struct({
      items: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          integration: Schema.String,
          owner: Schema.String,
          connection: Schema.String,
          inputSchema: Schema.Record(Schema.String, Schema.Unknown),
          annotations: Schema.optional(ToolAnnotationsView),
        }),
      ),
      total: Schema.Number,
      hasMore: Schema.Boolean,
      nextOffset: Schema.NullOr(Schema.Number),
    }),
  }),
);
