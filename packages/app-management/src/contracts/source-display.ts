import { Schema } from "effect";

/** Source reads are byte-preserving by default. Display mode is read-only presentation. */
export const SourceDisplayQuery = {
  format: Schema.optional(Schema.Literal("display")),
};

/** Bound parser work in a server request; larger files remain readable as their original text. */
export const sourceDisplayLimits = {
  fileBytes: 256 * 1024,
  requestBytes: 1024 * 1024,
} as const;
