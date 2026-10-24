/** Custom imports retain public configuration; credentials are connected after deploying. */
import { Schema } from "effect";
import { AppName, HttpUrl } from "@executor-js/sdk";

/** Credential-free URL syntax; the product decides which network destinations are allowed. */
export const ImportUrl = HttpUrl.check(
  Schema.makeFilter(
    (value) => {
      const url = new URL(value);
      return !url.username && !url.password && !url.hash && !url.search && !/[{}]/.test(value);
    },
    { expected: "an HTTP(S) URL without credentials, query parameters, fragments or placeholders" },
  ),
);
/**
 * A remote MCP server added by URL. Its connection method is confirmed from the server, never
 * chosen in the form; other services are set up with the user's agent.
 */
export const CustomAppInput = Schema.Struct({
  kind: Schema.Literal("mcp"),
  name: AppName,
  url: ImportUrl,
});
export type CustomAppInput = typeof CustomAppInput.Type;
