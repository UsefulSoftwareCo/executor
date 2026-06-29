import { parse } from "graphql";

// Local validation for a caller-supplied `select` (see invoke / plugin.invokeTool).
// graphql-js is already a runtime dependency of this plugin, so we reuse its
// parser to reject a malformed selection before any network round trip, and to
// catch any attempt to break out of the field's selection set (the spliced text
// must parse as part of a single operation). Field- and argument-level validity
// is left to the upstream server, which returns verbatim errors: building a local
// GraphQLSchema would need a full introspection snapshot, but the stored snapshot
// is a reduced shape (see introspect.ts) that buildClientSchema cannot consume.

/** Parse-check an assembled operation string. Returns a one-element error array
 *  when the selection is not valid GraphQL, or an empty array when it parses. */
export const validateOperationString = (operationString: string): readonly string[] => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: graphql `parse` throws on a syntax error; the thrown value is reported generically (its message is not extracted, per the typed-error lint rules)
  try {
    parse(operationString);
    return [];
  } catch {
    return ["`select` is not a valid GraphQL selection set"];
  }
};
