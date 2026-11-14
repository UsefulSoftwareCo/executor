/**
 * Effect's HTTP API rejects a request that does not match its endpoint's schema before any
 * handler runs, and on its own answers an empty 400 that no operation declares. Product APIs
 * apply `RequestRejection` to every endpoint instead, so the answer is the declared
 * `RequestInvalid`, naming where the request did not match.
 */
import { recordRequestRejection } from "@executor-js/telemetry/http";
import { Effect, SchemaIssue } from "effect";
import { type HttpApiError, HttpApiMiddleware } from "effect/http-api";
import {
  RequestInvalid,
  type RequestIssue,
  type RequestPart,
  RequestRejection,
} from "../contracts/shared.ts";

/** Request parts the caller supplies. Response encoding failures stay server faults. */
const parts: Partial<Record<HttpApiError.HttpApiSchemaError["kind"], RequestPart>> = {
  Params: "path",
  Headers: "headers",
  Query: "query",
  Payload: "body",
};

const maxIssues = 10;
const maxExpected = 300;
// HTTP API decoding does not retain input (`reportInput`), so these messages state what the
// schema expects without the submitted value. A filter's own message can name the caller's path.
const format = SchemaIssue.makeFormatterStandardSchemaV1();
const segment = (key: PropertyKey) =>
  typeof key === "number" ? `[${key}]` : `.${String(key).slice(0, 64)}`;

const issues = (error: HttpApiError.HttpApiSchemaError): ReadonlyArray<RequestIssue> => {
  const found = new Map<string, RequestIssue>();
  for (const issue of format(error.cause.issue).issues) {
    const path = `$${(issue.path ?? []).map((key) => segment(typeof key === "object" ? key.key : key)).join("")}`;
    const expected = issue.message.slice(0, maxExpected);
    // Union members can repeat the same finding.
    found.set(`${path}\n${expected}`, { path, expected });
  }
  return [...found.values()].slice(0, maxIssues);
};

/** Answer a request its endpoint's schema rejected with `RequestInvalid`, recorded on its span. */
export const rejectRequest = (error: HttpApiError.HttpApiSchemaError) => {
  const part = parts[error.kind];
  return part === undefined
    ? Effect.fail(error)
    : recordRequestRejection(error).pipe(
        Effect.andThen(Effect.fail(new RequestInvalid({ part, issues: issues(error) }))),
      );
};

/** The `RequestRejection` middleware product APIs serve. */
export const requestRejections = HttpApiMiddleware.layerSchemaErrorTransform(
  RequestRejection,
  rejectRequest,
);
