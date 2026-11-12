/**
 * Setup help as a declaration stores it. Authors usually indent help inside a template literal,
 * and Markdown reads four leading spaces as a code block, so indented source would render as code.
 */
import { mapFieldHelp } from "../contracts/help-text.ts";
import type { JsonObject } from "../contracts/schema.ts";

/** Remove the indentation every non-blank line shares, trailing spaces, and blank outer lines. */
export const dedent = (text: string) => {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
  while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
  const indents = lines
    .filter((line) => line.trim() !== "")
    .map((line) => line.length - line.trimStart().length);
  const common = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((line) => line.slice(Math.min(common, line.length)).trimEnd()).join("\n");
};

/** A fields or response JSON Schema with every `title` and `description` in it dedented. */
export const dedentFieldHelp = (document: JsonObject): JsonObject =>
  mapFieldHelp(document, (schema) => {
    const { title, description } = schema;
    return {
      ...schema,
      ...(typeof title === "string" ? { title: dedent(title) } : {}),
      ...(typeof description === "string" ? { description: dedent(description) } : {}),
    };
  });
