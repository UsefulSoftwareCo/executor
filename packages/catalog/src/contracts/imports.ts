import { Schema } from "effect";
import { AppName, HttpUrl } from "@executor-js/sdk";

export const ImportUrl = HttpUrl.check(
  Schema.makeFilter(
    (value) => {
      const url = new URL(value);
      return !url.username && !url.password && !url.hash && !url.search && !/[{}]/.test(value);
    },
    { expected: "an HTTP(S) URL without credentials, query parameters, fragments or placeholders" },
  ),
);
export const CustomAppInput = Schema.Struct({
  kind: Schema.Literal("mcp"),
  name: AppName,
  url: ImportUrl,
});
export type CustomAppInput = typeof CustomAppInput.Type;
