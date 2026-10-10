/** The operator's own OAuth clients, read from host configuration. */
import { FirstPartyOAuthClient } from "@executor-js/sdk/core";
import { Config, Effect, Option, Redacted, Schema, SchemaAST, SchemaIssue } from "effect";
import { FirstPartyOAuthClientsInvalid } from "../contracts/oauth-client-metadata.ts";

const setting = "EXECUTOR_FIRST_PARTY_OAUTH_CLIENTS";
const Clients = Schema.Array(FirstPartyOAuthClient);
/** The most problems one report lists; the rest are counted. */
const reportedProblems = 20;

/**
 * Where an issue's value is, as array positions and the names of declared fields. A key no schema
 * declares, such as one of `authorizationParams`, is the operator's own text and is not repeated.
 */
const segment = (key: PropertyKey, parent: SchemaAST.AST | undefined) =>
  typeof key === "number"
    ? `[${key}]`
    : parent !== undefined &&
        SchemaAST.isObjects(parent) &&
        parent.propertySignatures.some((property) => property.name === key)
      ? `.${String(key)}`
      : "[key]";

/** A filter's own description, written in the schema; never derived from the rejected value. */
const filterReason = (filter: SchemaAST.Filter<unknown>) => {
  const { message, expected } = filter.annotations ?? {};
  return typeof message === "string"
    ? message
    : typeof expected === "string"
      ? `must be ${expected}`
      : "is not valid";
};

/**
 * Each problem in `issue` as its location and a fixed reason. Schema issues can carry the rejected
 * input and messages built from it; only their structure is read here, so a client secret or any
 * other supplied value never reaches the report.
 */
const problems = (
  issue: SchemaIssue.Issue,
  path = "",
  parent?: SchemaAST.AST,
): ReadonlyArray<string> => {
  const at = (reason: string) => [path === "" ? `The setting ${reason}` : `${path}: ${reason}`];
  switch (issue._tag) {
    case "Pointer":
      return problems(
        issue.issue,
        path + issue.path.map((key) => segment(key, parent)).join(""),
        parent,
      );
    case "Composite":
      return issue.issues.flatMap((inner) => problems(inner, path, issue.ast));
    case "Encoding":
      return problems(issue.issue, path, parent);
    case "Filter":
      return at(filterReason(issue.filter));
    case "MissingKey":
      return at("is required");
    case "UnexpectedKey":
      return at("is not allowed");
    case "InvalidType":
      return at("has the wrong type");
    case "InvalidValue":
      return at("is not a valid value");
    case "AnyOf":
      return at("matches none of the accepted forms");
    case "OneOf":
      return at("matches more than one accepted form");
    case "Forbidden":
      return at("cannot be read");
  }
};

/** The settings were rejected for `found`, listed in order, at most `reportedProblems` of them. */
const invalid = (found: ReadonlyArray<string>) => {
  const listed = found.slice(0, reportedProblems);
  const more = found.length - listed.length;
  return new FirstPartyOAuthClientsInvalid({
    message: `${setting} is invalid. ${[...listed, ...(more > 0 ? [`${more} more problems`] : [])]
      .map((problem) => (problem.endsWith(".") ? problem : `${problem}.`))
      .join(" ")}`,
    problems: listed,
  });
};

/**
 * `EXECUTOR_FIRST_PARTY_OAUTH_CLIENTS`, checked at startup: a JSON array of the operator's OAuth
 * clients, such as one-click Google sign-in. Each names the authorization server it belongs to,
 * its client credentials, the scopes it requests by default and allows, and its placement: the
 * header and hosts its access tokens may reach. It holds client secrets, so it is a secret. Unset,
 * there are none, and every provider needs a supplied, saved, metadata-document or registered
 * client as before. Invalid settings fail with each problem's position, field and a fixed reason.
 */
export const firstPartyOAuthClients = Config.Redacted(setting).pipe(
  Config.option,
  Effect.flatMap(
    Option.match({
      onNone: () => Effect.succeed<readonly FirstPartyOAuthClient[]>([]),
      onSome: (value) =>
        Effect.gen(function* () {
          const json = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
            Redacted.value(value),
          ).pipe(Effect.mapError(() => invalid(["The setting is not valid JSON"])));
          const clients = yield* Schema.decodeUnknownEffect(Clients)(json, { errors: "all" }).pipe(
            Effect.mapError((error) => invalid(problems(error.issue))),
          );
          const first = new Map<string, number>();
          const repeated = clients.flatMap((client, index) => {
            const earlier = first.get(client.id);
            if (earlier === undefined) first.set(client.id, index);
            return earlier === undefined ? [] : [`[${index}].id: repeats the id of [${earlier}]`];
          });
          if (repeated.length > 0) return yield* invalid(repeated);
          return clients;
        }),
    }),
  ),
);
