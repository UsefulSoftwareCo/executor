import {
  ApiErrorResponse,
  FailureCode,
  FailureFields,
  FailureMessage,
  FailureName,
  FailurePhase,
  FailureSource,
  McpError,
  networkRefusalStatus,
  ProviderError,
  SkillLoadFailed,
  UpstreamError,
} from "apps/contracts";
import { ApiError } from "@executor-js/utils/api-error";
import { ProfileId } from "./shared.ts";
import { type ErrorPresentation, UserFacingError } from "@executor-js/utils/user-facing-error";
import { ProfileErrors, ProfileRevision } from "./profiles.ts";
import { callPresentation, type CausePresentation, MayHaveWritten } from "./call-presentation.ts";
/** Existing tool call seam, using the configured app's saved accounts. Discovery design is deferred. */
import { Match, Option, Schema } from "effect";
import {
  ApprovalElicitation,
  ApprovalResponse,
  ElicitationFailed,
  HostEvaluationFailed,
  HostedRouter,
  type HostRouterError,
  HostedTool,
  HostedToolSummary,
  type ElicitationHandler,
} from "apps/contracts";
import { StorageError, CredentialsError, RequestInvalid } from "./shared.ts";
import type { CatalogReadOptions } from "./declarations.ts";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import {
  AccountId,
  AppId,
  ApprovalRequestId,
  Cursor,
  DeploymentId,
  Json,
  OwnerId,
  ProviderId,
  PageLimit,
  ToolName,
} from "./shared.ts";
import { AccountNotFound } from "./account.ts";
import { AccountRequired, AccountSelectionInvalid, AppNotFound, AppNotDeployed } from "./apps.ts";
import { DeploymentNotFound } from "./deployment.ts";
import { OAuthReconnectRequired, OAuthRenewalFailed } from "./oauth.ts";

/** Retention bound for a pending SDK approval and its consumed marker. */
export const ToolApprovalLimits = Schema.Struct({
  ttlMs: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type ToolApprovalLimits = typeof ToolApprovalLimits.Type;
/** Current consume-once approval lifetime; this does not extend a live tool invocation. */
export const defaultToolApprovalLimits = ToolApprovalLimits.make({ ttlMs: 15 * 60 * 1000 });

/**
 * Names where a host issued a call, such as one person's run from its dashboard. A pending approval
 * saves it, and only a resume that presents the same issuer can consume the request, so each
 * approval is answered only through the flow that issued it. Opaque to the SDK.
 */
export const ToolApprovalIssuer = Schema.NonEmptyString.pipe(Schema.brand("ToolApprovalIssuer"));
export type ToolApprovalIssuer = typeof ToolApprovalIssuer.Type;
/**
 * Per-invocation host context. These are not HTTP payloads, so a remote caller cannot present an
 * issuer. Only `issuer` enters approval storage.
 */
export interface ToolInvocationOptions {
  readonly elicitation?: ElicitationHandler;
  readonly issuer?: ToolApprovalIssuer;
}
/** How an in-process caller with its own wait bound reads a tool listing. Not an HTTP input. */
export interface ToolListOptions extends CatalogReadOptions {
  /**
   * Report a listing that another request started at least this long ago, and that is still
   * running, as `ToolListingTimedOut` at once instead of waiting for it. A caller that gives up
   * after this long, such as MCP discovery, would not get it in time. Such a caller is also told
   * at once about a remembered slow failure. Without it the read waits for a live evaluation.
   */
  readonly reportRunningAfterMillis?: number;
}
export {
  ElicitationFailed,
  type ElicitationHandler,
  type FormElicitation,
  type ElicitationResponse,
} from "apps/contracts";

/**
 * Copy for a refusal the app's reply reports, which has no presentation of its own. `message` is
 * what a caller of a query is told. `description` states what happened without advising another
 * call or claiming what ran; `recovery`, when a query's caller has one, is that caller's advice.
 */
interface RefusalCopy {
  readonly message: string;
  readonly title: string;
  readonly description: string;
  readonly recovery?: ErrorPresentation["recovery"];
}

/**
 * A refusal's recovery for a call that may have written, when a query's caller would get none.
 * The app's reply refused the call after its code received the call.
 */
const refusalRecovery = {
  action: "Read the app’s refusal before another call.",
  instructions:
    "The app’s reply refused this call after its code received it, so the refusal does not show what ran.",
};

/** A refusal's presentation, through `callPresentation`; a query's refusal without recovery has none. */
const refusalPresentation =
  <Fields>(copy: (fields: Fields) => RefusalCopy) =>
  (
    fields: Fields & { readonly mayHaveWritten?: true | undefined },
  ): ErrorPresentation | undefined => {
    const { title, description, recovery } = copy(fields);
    if (recovery === undefined && fields.mayHaveWritten !== true) return undefined;
    return callPresentation(() => ({
      title,
      description,
      ...(recovery === undefined ? { recovery: refusalRecovery, forWrite: true } : { recovery }),
      retryable: false,
    }))(fields);
  };

/**
 * A refusal's message. A call that may have written leads with Executor's instruction not to
 * repeat it, then states what happened; it has no recovery field, so the message carries both.
 */
const refusalMessage =
  <Fields>(copy: (fields: Fields) => RefusalCopy) =>
  (fields: Fields & { readonly mayHaveWritten?: true | undefined }): string => {
    const presented =
      fields.mayHaveWritten === true ? refusalPresentation(copy)(fields) : undefined;
    return presented === undefined
      ? copy(fields).message
      : `${presented.recovery.action} ${presented.description}`;
  };

/**
 * A cause's presentation for a call that may have written, for callers that present a failure
 * themselves rather than through its class or `callFailurePresentation`.
 */
export const mayHaveWrittenPresentation = (presented: ErrorPresentation): ErrorPresentation =>
  callPresentation(() => presented)({ mayHaveWritten: true });

/**
 * The same failure, recording that its operation may change data and may have begun. It is
 * encoded and decoded again with `mayHaveWritten`, so the class presents it as its own.
 */
export const mayHaveWritten = <A extends { readonly mayHaveWritten?: true | undefined }, I>(
  schema: Schema.Codec<A, I>,
  failure: A,
): A =>
  Schema.decodeUnknownSync(schema)({ ...Schema.encodeSync(schema)(failure), mayHaveWritten: true });

/** Why a running tool could not complete its user interaction. */
const elicitationFailures = {
  unavailable: "The tool requested input, but input delivery was unavailable for this invocation.",
  transaction: "The tool asked for input inside a database transaction, which is not allowed.",
  "invalid-request": "The tool's input request was invalid.",
  "invalid-response": "The input response did not match the tool's request.",
  transport: "The tool’s input request or answer could not be delivered.",
  expired: "The tool’s input request expired before Executor received an answer.",
  forbidden: "This caller may no longer answer the tool's input request.",
} as const;
/**
 * What to do about each failed input request, and whether repeating the call unchanged can help.
 * Repeat advice is for a read: a call that may have written is presented without it.
 */
const elicitationRecovery = {
  unavailable: {
    action: "Use a supported input-delivery path.",
    instructions:
      "Check whether the client supports input requests or the invocation ended. Use a supported input-delivery path, or tell the user the tool needs their input.",
    retryable: false,
  },
  transaction: {
    action: "Change the app so the tool asks for input outside its database transaction.",
    instructions:
      "The tool requested input while its database transaction was open. Collect any input needed for the write before opening the transaction.",
    retryable: false,
  },
  "invalid-request": {
    action: "Check the tool’s input request before changing the app.",
    instructions:
      "Executor could not accept or record the tool’s input request. Check its form and delivery limits before changing the app.",
    retryable: false,
  },
  "invalid-response": {
    action: "Correct the input response before another attempt.",
    instructions:
      "The input response did not match the requested form or response format. Correct it before another attempt. If the execution is still paused, answer through resume.",
    retryable: true,
  },
  transport: {
    action: "Try again once. If it fails again, tell the user the tool’s input request fails.",
    instructions:
      "For a read, one further attempt may help. If it fails again, tell the user the tool’s input request fails.",
    retryable: true,
  },
  expired: {
    action: "Call the tool again when the user can answer its input request.",
    instructions:
      "Retry a read when the user can answer. Check delivery if an answer was already sent.",
    retryable: true,
  },
  forbidden: {
    action: "Confirm or restore access to the app and its accounts before another attempt.",
    instructions:
      "Executor checks the caller's access before it delivers an input request, and that check was refused, such as after access changed while the tool was waiting. Confirm or restore the caller's access to the app and its accounts before another attempt.",
    retryable: false,
  },
} as const;
/** A running tool could not complete its user interaction. Earlier effects may have completed. */
export const ToolElicitationFailed = UserFacingError.define({
  tag: "ToolElicitationFailed",
  status: 422,
  fields: {
    app: AppId,
    deployment: DeploymentId,
    tool: ToolName,
    reason: ElicitationFailed.fields.reason,
    mayHaveWritten: MayHaveWritten,
  },
  recorded: ({ reason }) => elicitationFailures[reason],
  presentation: callPresentation(({ reason }) => {
    const { action, instructions, retryable } = elicitationRecovery[reason];
    return {
      title: "The tool needed more input",
      description: elicitationFailures[reason],
      recovery: { action, instructions },
      retryable,
    };
  }),
});
export type ToolElicitationFailed = typeof ToolElicitationFailed.Type;

/** One callable in an app's live definition. inputSchema is a JSON Schema document. */
export const Tool = Schema.Struct({
  ...HostedTool.fields,
  app: AppId,
  deployment: DeploymentId,
  name: ToolName,
});

export type Tool = typeof Tool.Type;

/**
 * A group of tools in an app's live catalog. `path` is "" for the app's root. Its instructions,
 * when present, are the skill named `skill`. A router with `error` could not list its tools.
 */
export const ToolRouter = HostedRouter;
export type ToolRouter = typeof ToolRouter.Type;

/** One page of a live catalog, evaluated using the named profile's saved selections. */
export const ToolPage = Schema.Struct({
  profile: Schema.optional(ProfileId),
  profileRevision: Schema.optional(ProfileRevision),
  deployment: DeploymentId,
  items: Schema.Array(Tool),
  /** Every router in the catalog, on every page. */
  routers: Schema.Array(ToolRouter),
  next: Schema.optional(Cursor),
});

export type ToolPage = typeof ToolPage.Type;

/** One callable's name and description. Its schemas are read with tools.get. */
export const ToolSummary = Schema.Struct({
  ...HostedToolSummary.fields,
  app: AppId,
  deployment: DeploymentId,
  name: ToolName,
});

export type ToolSummary = typeof ToolSummary.Type;

/** The whole live catalog without schemas, evaluated using the named profile's saved selections. */
export const ToolIndex = Schema.Struct({
  profile: Schema.optional(ProfileId),
  profileRevision: Schema.optional(ProfileRevision),
  deployment: DeploymentId,
  items: Schema.Array(ToolSummary),
  routers: Schema.Array(ToolRouter),
});

export type ToolIndex = typeof ToolIndex.Type;

const evaluationInstructions =
  "Reproduce tool discovery for the current app, deployment, and selected profile. Inspect safe runtime diagnostics to distinguish an unavailable build, invalid app definition, invalid account bindings, protocol failure, or app evaluation failure. This error alone does not identify which cause occurred. Do not assume an account needs reconnecting. Verify that the Tools page loads after the repair.";
/**
 * What to do when the answer the skill loader received points to a repository or ref it cannot
 * find. The answer reached the app's code, which can stand in for a failed request, so it is not
 * claimed to be the service's, and the repository is not claimed missing.
 */
const missingSource = {
  repository: {
    action:
      "Check the repository the app’s skill source names. If it is private, pass a GitHub account and its token to the skill loader.",
    instructions:
      "Reading the repository the skill source names without credentials returned HTTP 404 or 401: it may be misspelled, it may be private, or the request may have failed. This does not show that the repository does not exist. Check the repository name in the skill loader's options for typos. For a private repository, pass the loader a GitHub account and its token, such as account: ctx.accounts.github and token: ctx.accounts.github.fields.token, from a provider that declares hosts github.com and raw.githubusercontent.com; the user connects an account whose token can read the repository. Alternatively, bundle its skill folders with the app.",
  },
  ref: {
    action: "Check the branch or tag the app’s skill source names.",
    instructions:
      "The refs read from the repository include no branch or tag with the name the skill source gives. Check the ref in the skill loader's options against the repository's branches and tags.",
  },
} as const;
/**
 * A service that answers 404 may hide a source the request's credentials cannot read, as GitHub
 * does for a private repository, so the source is not claimed missing.
 */
const unavailableSource = {
  action:
    "Check the address or repository the app’s skill source names, and that any account it reads with can access it.",
  instructions:
    "Reading the source returned HTTP 404. The address or repository name may be misspelled, or the source may exist but not be readable with the credentials sent: GitHub answers 404 when a token cannot read a private repository. This does not show that the source does not exist. Check the name in the skill loader's options for typos, and that the account passed to the loader, if any, is selected and its token can read the source. Do not print the token.",
};
/** A request carrying an account's token was refused for a host its provider does not declare. */
const refusedCredentialHost = {
  action: "Check the hosts the provider of the skill loader’s account declares.",
  instructions:
    "A request of the skill loader that carried the account's token was refused because the account's provider does not declare the host it went to. The provider must declare every host the loader sends the token to: for GitHub, github.com and raw.githubusercontent.com. Reconnect an account connected with the provider's current hosts. Do not print the token.",
};
const invalidSourceInstructions =
  "The skill loader reported a problem with its source, which its message names. Its settings may not be valid, such as a malformed or non-HTTP URL or an invalid repository name or path, or the source may list a file Executor cannot read, such as a symbolic link or a path outside the skill's folder. Check the skill loader's options and the files the source publishes.";
const skillInstructions =
  "The app loads skills from a remote source. Read the app source to find the skill loader and its options. Do not print credentials or raw responses, and do not change accounts. If the factory awaits the loader, tools and skills both fail when that load fails. Declare it with dynamicSkills instead, such as dynamicSkills: dynamicSkills({ list: () => githubSkills(...) }), so only skill reads call it. To stop depending on the remote source, the app can bundle its skill folders and read them with folderSkills. Verify that the Skills and Tools pages load after the repair.";

/**
 * The error an app's own code threw, or the specific app data failure it hit. The message, code
 * and fields are the app's own, bounded and with the invocation's account secrets replaced.
 */
export const AppFailure = Schema.Struct({
  source: FailureSource,
  errorName: FailureName,
  code: Schema.optional(FailureCode),
  message: FailureMessage,
  /** The thrown error's own scalar fields, such as `reason` or `pointer`. */
  fields: Schema.optional(FailureFields),
});
export type AppFailure = typeof AppFailure.Type;

/** The thrown error's fields as `name: value` pairs, each value as JSON. */
const fieldsText = (fields: FailureFields | undefined) =>
  fields === undefined
    ? ""
    : ` Details: ${Object.entries(fields)
        .map(([name, value]) => `${name}: ${JSON.stringify(value)}`)
        .join("; ")}.`;

/** One line naming who raised the failure, its code, its own message and its fields. */
export const appFailureText = ({ source, errorName, code, message, fields }: AppFailure) =>
  source === "storage"
    ? `${errorName === "CacheError" ? "App cache" : "App data"} failed (${code ?? errorName}): ${message}`
    : source === "service"
      ? `The app's API call failed: ${message}`
      : `The app threw ${errorName}${code === undefined ? "" : ` (${code})`}: ${message}${fieldsText(fields)}`;

/** The error a service stated, with its own message quoted after Executor's explanation. */
const upstreamText = (upstream: UpstreamError | undefined, stated: string) =>
  upstream === undefined
    ? ""
    : ` ${stated} ${upstream.code}${upstream.message === undefined ? "" : `: ${JSON.stringify(upstream.message)}`}.`;

/** The stage of a provider failure, as a clause. */
const phaseText = (phase: FailurePhase | undefined) =>
  phase === undefined
    ? ""
    : phase === "connect"
      ? " while connecting"
      : phase === "call"
        ? " while calling a tool"
        : " while listing its tools";

/** Present a skill load failure with the loader's own message. */
const skillPresentation = ({
  reason,
  message,
  status,
  missing,
}: {
  readonly reason: SkillLoadFailed["reason"];
  readonly message?: string | undefined;
  readonly status?: number | undefined;
  readonly missing?: SkillLoadFailed["missing"];
}) => {
  const retryable =
    reason === "rate_limited" ||
    reason === "changed" ||
    (reason === "request" && (status === undefined || status >= 500));
  const source =
    reason === "request" && status === 404
      ? unavailableSource
      : reason !== "source"
        ? undefined
        : status === networkRefusalStatus
          ? refusedCredentialHost
          : missing === undefined
            ? {
                action: "Check the app’s skill source settings and the files it lists.",
                instructions: invalidSourceInstructions,
              }
            : missingSource[missing];
  const action =
    source?.action ??
    (reason === "rate_limited"
      ? "Wait for the rate limit to reset, then try again."
      : retryable
        ? "Try again. If this continues, check the app’s skill source."
        : "Check the app’s skill source, then try again.");
  return {
    title:
      reason === "rate_limited" ? "Skill source rate limit reached" : "Skills could not be loaded",
    description: message || "The app could not load its skills.",
    recovery: {
      action,
      instructions:
        source === undefined ? skillInstructions : `${source.instructions} ${skillInstructions}`,
    },
    retryable,
  };
};

/**
 * An MCP server's failure: its safe phase, reason and HTTP status, and the JSON-RPC error it
 * answered with, such as a refusal and how to fix it.
 */
export const McpFailure = Schema.Struct({
  phase: McpError.fields.phase,
  reason: McpError.fields.reason,
  status: McpError.fields.status,
  /** The JSON-RPC error the server answered with, bounded and with account secrets replaced. */
  upstream: McpError.fields.upstream,
  /** The refused request carried the session ID the server issued at initialization. */
  session: McpError.fields.session,
  initialized: McpError.fields.initialized,
  fallback: McpError.fields.fallback,
});
export type McpFailure = typeof McpFailure.Type;

/** An MCP failure's fields, without keys for absent ones. */
const mcpFailure = ({
  phase,
  reason,
  status,
  upstream,
  session,
  initialized,
  fallback,
}: McpError): McpFailure => ({
  phase,
  reason,
  ...(status === undefined ? {} : { status }),
  ...(upstream === undefined ? {} : { upstream }),
  ...(session === undefined ? {} : { session }),
  ...(initialized === undefined ? {} : { initialized }),
  ...(fallback === undefined ? {} : { fallback }),
});

/**
 * What traces and error reports record for a failure an app or its MCP server stated: who failed,
 * in Executor's words, with the typed reason, phase and status. Never the app's message, error
 * name, code or fields, nor a service's stated error; those reach only the caller. Every value
 * interpolated is a closed literal, except a status: released protocols accept any number for an
 * MCP status, so only an HTTP status is recorded.
 */
const recordedStatus = (status: number | undefined) =>
  status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599
    ? ` (HTTP ${status})`
    : "";
const recordedApp = ({ source }: AppFailure) =>
  source === "storage"
    ? "the app's data store failed"
    : source === "service"
      ? "the app's API call failed"
      : "the app's code raised an error";
const recordedMcp = ({ phase, reason, status }: McpFailure) =>
  `the app's MCP server failed during ${phase} (${reason})${recordedStatus(status)}`;

/**
 * Present an MCP server failure from its safe phase, reason, HTTP status and JSON-RPC error. The
 * app reports all of them, so they choose the copy and a read's retry policy, but never claim that
 * a request was not sent or changed nothing. A failed tool call's presentation is for a read; a
 * call that may have written is presented with Executor's instruction first and is never retryable
 * (see `callPresentation`), whatever the reason.
 */
export const mcpFailurePresentation = ({
  phase,
  reason,
  status,
  upstream,
  session,
  initialized,
  fallback,
}: McpFailure) => {
  const http = status === undefined ? "" : ` (HTTP ${status})`;
  const answered =
    upstreamText(upstream, "The server answered with JSON-RPC error") +
    (initialized === true ? " The Streamable HTTP session failed after initialization." : "") +
    (fallback === undefined
      ? ""
      : ` Legacy SSE fallback also failed${fallback.status === undefined ? "" : ` (HTTP ${fallback.status})`}${fallback.reason === "timeout" ? " because it timed out" : ""}.`);
  const stage =
    phase === "connect" || phase === "transport"
      ? "connecting"
      : phase === "call"
        ? "calling a tool"
        : "listing its tools";
  const instructions =
    "Use the reported phase and error to identify the failure. Check the server URL, transport or access settings only when relevant. Do not expose credentials.";
  switch (reason) {
    case "timeout":
      // A server that did not answer one call may answer the next, so a read may be repeated
      // once; a second timeout is investigated before repeating it again.
      if (phase === "call")
        return {
          title: "MCP server did not answer the tool call",
          description: `The app’s MCP server did not answer the tool call in time, so Executor stopped waiting. The server may still finish it.${answered}`,
          recovery: {
            action: "You may retry once. If it times out again, investigate before repeating it.",
            instructions:
              "The server may still complete the first attempt. For a read, you may retry once; if it times out again, check the server’s status before repeating it. Reduce the input only if that still meets the task. Do not expose credentials.",
          },
          retryable: true,
        };
      return {
        title: "MCP server did not respond",
        description: `The app’s MCP server did not respond in time while ${stage}.${answered}`,
        recovery: {
          action: "Try again later. If this continues, check the MCP server’s status.",
          instructions,
        },
        retryable: true,
      };
    case "unauthorized":
      return {
        title: "MCP server rejected the credentials",
        description: `The app’s MCP server rejected the credentials${http}.${answered}`,
        recovery: {
          action:
            "Check how the request authenticates. Update credentials or reconnect only if the evidence requires it.",
          instructions,
        },
        retryable: false,
      };
    case "invalid_response":
      return {
        title: "MCP server response not supported",
        // Includes Executor refusing to follow the server to another origin.
        description: `The app’s MCP server returned a response Executor could not use while ${stage}, such as an unreadable message or an address on another origin.${answered}`,
        recovery: {
          action: "Check the response compatibility and the app’s MCP server configuration.",
          instructions,
        },
        retryable: false,
      };
    case "invalid_input":
      // The app reports this reason, so the copy does not claim the call was not sent.
      return phase === "call"
        ? {
            title: "Tool input could not be used",
            description:
              "The app reported that it could not use the input as the MCP tool’s arguments.",
            recovery: {
              action: "Pass the tool an object that matches its input schema.",
              instructions:
                "The input could not be encoded as the tool's arguments. Pass an object that matches the tool's input schema; a call with corrected input is a new call.",
            },
            retryable: false,
          }
        : {
            title: "MCP server settings are invalid",
            description: `The app’s MCP server URL or settings are invalid.${answered}`,
            recovery: { action: "Correct the app’s MCP server URL or settings.", instructions },
            retryable: false,
          };
    case "request":
      // Request Timeout and Too Early ask the client to retry the same request later.
      if (status === 408 || status === 425)
        return {
          title: "MCP server asked to retry",
          description: `The app’s MCP server returned HTTP ${status} while ${stage}.${answered}`,
          recovery: {
            action:
              "Try again later, at most once. If it fails again, check the MCP server’s status.",
            instructions,
          },
          retryable: true,
        };
      // A server may answer a request carrying the session it issued with 404 when it no longer
      // has that session, such as one run on several instances that do not share sessions. A new
      // listing opens another. `session` comes from the app, so the copy only says the session
      // may have expired. Without a session, a 404 is an ordinary refusal.
      if (status === 404 && phase === "discover" && session === true)
        return {
          title: "MCP session may have expired",
          description: `The app reported HTTP 404 while listing tools with a session; the server may no longer recognize it.${answered}`,
          recovery: {
            action:
              "Try again. If this continues, check that the MCP server keeps its sessions, for example across all of its instances.",
            instructions,
          },
          retryable: true,
        };
      if (status !== undefined)
        return {
          title: "MCP server refused the request",
          description: `The app’s MCP server refused the request while ${stage}${http}.${answered}`,
          recovery: {
            action: "Check the app’s MCP server URL and access requirements.",
            instructions,
          },
          retryable: false,
        };
      // A JSON-RPC error inside a successful response, such as arguments a tool rejects, states
      // the server's error. Without one, a transport failure got no answer from the server: it
      // may not be reachable, or Executor's own request failed. A tool call that failed without an
      // answer, such as on a dropped connection, may have run.
      return upstream === undefined
        ? phase === "transport"
          ? {
              title: "MCP server did not answer",
              description: `Executor’s request to the app’s MCP server failed before the server answered, while ${stage}.`,
              recovery: {
                action: "Try again. If this continues, check the MCP server’s address and status.",
                instructions,
              },
              retryable: true,
            }
          : phase === "call"
            ? {
                title: "Tool call ended without an answer",
                description:
                  "The request to the app’s MCP server failed before the server answered the tool call, so Executor cannot tell whether the server ran it.",
                recovery: {
                  action:
                    "Retry at most once. If it fails again, check the server’s status and connection.",
                  instructions: `For a read, retry at most once. If it fails again, check the server’s status and connection. ${instructions}`,
                },
                retryable: true,
              }
            : {
                title: "MCP server request failed",
                description: `The request to the app’s MCP server failed while ${stage}.`,
                recovery: {
                  action: "Try again once. If it fails again, check the MCP server’s status.",
                  instructions,
                },
                retryable: true,
              }
        : {
            title: "MCP server returned an error",
            description: `The app’s MCP server returned an error while ${stage}.${answered}`,
            recovery: {
              action: "Read the server’s error to determine the next step.",
              instructions,
            },
            retryable: false,
          };
  }
};

/**
 * Evaluating the app's live definition failed before any tool ran. With `mayHaveWritten`, it
 * failed during a call that may write, after the host handed the call to the app's code, which
 * includes its factory: that code may have made changes before the failure, whatever it reports.
 */
export const AppEvaluationFailed = UserFacingError.define({
  tag: "AppEvaluationFailed",
  status: 502,
  fields: {
    app: AppId,
    deployment: DeploymentId,
    reason: Schema.String,
    /** Present when the app's remote skill loader caused the failure. */
    skills: Schema.optional(
      Schema.Struct({
        reason: SkillLoadFailed.fields.reason,
        message: SkillLoadFailed.fields.message,
        status: SkillLoadFailed.fields.status,
        missing: SkillLoadFailed.fields.missing,
      }),
    ),
    /** Present when the app's own code threw while loading its definition. */
    failure: Schema.optional(AppFailure),
    /**
     * Present when the app's MCP server failed before a request reached a tool: while connecting,
     * including the session a tool call opens, or while listing its tools.
     */
    mcp: Schema.optional(McpFailure),
    mayHaveWritten: MayHaveWritten,
  },
  recorded: ({ skills, mcp, failure }) =>
    `Tools could not be loaded: ${
      mcp !== undefined
        ? recordedMcp(mcp)
        : failure !== undefined
          ? recordedApp(failure)
          : skills !== undefined
            ? `the app's skill source failed (${skills.reason})${recordedStatus(skills.status)}`
            : "the app's definition could not be evaluated"
    }`,
  presentation: callPresentation(({ skills, mcp, failure }) =>
    mcp !== undefined
      ? mcpFailurePresentation(mcp)
      : failure !== undefined
        ? {
            title: "Tools could not be loaded",
            description: `Executor could not load this app’s tool definitions. ${appFailureText(failure)}`,
            recovery: {
              action: "Try again. If this continues, investigate this error and fix its cause.",
              instructions: `The app's factory or dynamic tool loader failed with this error. It does not show whether the cause is the app's code, a service the app calls, or Executor, such as its storage or network. A transient cause, such as an unavailable upstream, may clear on retry. Otherwise find where the error is raised and what caused it, fix the cause, and verify that the app's tools load. Error: ${appFailureText(failure)}`,
            },
            retryable: true,
          }
        : skills === undefined
          ? {
              title: "Tools could not be loaded",
              description: "Executor could not load this app’s tool definitions.",
              recovery: {
                action: "Try again. If this continues, copy the fix prompt to investigate the app.",
                instructions: evaluationInstructions,
              },
              retryable: true,
            }
          : skillPresentation(skills),
  ),
});
/** Parsed evaluation failure; raw runtime diagnostics never enter its presentation. */
export type AppEvaluationFailed = typeof AppEvaluationFailed.Type;

/**
 * A tool listing ran longer than a caller waits, or than its bound with nobody waiting, or was
 * stopped before it finished. While it still runs, callers with a shorter wait, and briefly after
 * it gave up, every reader, are told this at once rather than wait for the same slow app again.
 */
export const ToolListingTimedOut = UserFacingError.define({
  tag: "ToolListingTimedOut",
  status: 504,
  fields: {
    app: AppId,
    deployment: DeploymentId,
    elapsedMs: Schema.Number,
    /** The listing is still running in the background. */
    running: Schema.Boolean,
  },
  recorded: ({ elapsedMs, running }) =>
    running
      ? `Listing the app's tools has run for ${elapsedMs}ms, longer than this request waits`
      : `Listing the app's tools timed out after ${elapsedMs}ms`,
  presentation: ({ elapsedMs, running }) => ({
    title: "App tools did not load in time",
    description: running
      ? `Listing this app's tools timed out: it has been running for ${elapsedMs}ms, longer than this request waits, so the app is unavailable until it finishes.`
      : `Listing this app's tools timed out after ${elapsedMs}ms, so the app is unavailable until a later listing finishes.`,
    retryable: true,
    recovery: {
      action:
        "Try again shortly. If this continues, check that the app's upstream server responds.",
      instructions:
        "Tell the user this app's tools could not be listed in time; its server may be slow or offline. Its tools cannot be called until a listing finishes. Other apps remain usable.",
    },
  }),
});
export type ToolListingTimedOut = typeof ToolListingTimedOut.Type;

/** Why renewing an account's refused credentials failed, as resolving them reports it. */
export const RenewalFailure = Schema.Union([
  OAuthReconnectRequired,
  OAuthRenewalFailed,
  StorageError,
  CredentialsError,
]);
export type RenewalFailure = typeof RenewalFailure.Type;

/**
 * What to do about a renewal that failed after a call that may write was dispatched. The
 * renewal's own recovery is written for an operation that may be repeated, so it is replaced: a
 * failure Executor's storage caused names what to check, a reconnect or a non-temporary refusal
 * keeps its steps. A temporary refusal is not renewed again until access is due for renewal or
 * refused again, so its recovery says only what may trigger renewal and when to reconnect, and
 * leaves out its own advice.
 */
const renewalRecovery = (
  failure: RenewalFailure,
): Pick<CausePresentation, "recovery" | "forWrite"> => {
  switch (failure._tag) {
    case "StorageError":
      return {
        recovery: {
          action: "Check Executor’s storage availability.",
          instructions: failure.recovery.instructions,
        },
      };
    case "CredentialsError":
      return {
        recovery: {
          action: "Check Executor’s credential storage and encryption-key availability.",
          instructions: failure.recovery.instructions,
        },
      };
    case "OAuthReconnectRequired":
      return { recovery: failure.recovery };
    case "OAuthRenewalFailed":
      return failure.retryable
        ? {
            recovery: {
              action:
                "Respect any wait specified by the renewal error; a later safe read that uses this account may trigger renewal when access is due for renewal or rejected again.",
              instructions:
                "If renewal keeps failing, inspect its error and reconnect only when the service indicates it is needed.",
            },
            forWrite: true,
          }
        : { recovery: failure.recovery };
  }
};

/** Recognized provider failure, enriched only with trusted selected-account metadata. */
export const AppProviderFailed = UserFacingError.define({
  tag: "AppProviderFailed",
  status: 502,
  fields: {
    app: AppId,
    deployment: DeploymentId,
    reason: ProviderError.fields.reason,
    status: ProviderError.fields.status,
    /** Whether the service failed while connecting, listing the app's tools or running one. */
    phase: ProviderError.fields.phase,
    /** The error code and description the service stated, with account secrets replaced. */
    upstream: ProviderError.fields.upstream,
    account: Schema.optional(
      Schema.Struct({ id: AccountId, label: Schema.String, provider: Schema.String }),
    ),
    /**
     * The service refused the account's credentials during a mutation, and Executor has since
     * renewed them. The mutation was not repeated, because it may have made changes before the
     * refusal; a later call uses the renewed credentials.
     */
    credentialsRenewed: Schema.optional(Schema.Literal(true)),
    /**
     * The service refused the account's credentials during a call that may write, and renewing
     * them failed with this error. The call was not repeated.
     */
    renewalFailure: Schema.optional(RenewalFailure),
    mayHaveWritten: MayHaveWritten,
  },
  recorded: ({ reason, status, phase }) =>
    `The connected service failed (${reason})${recordedStatus(status)}${phaseText(phase)}`,
  presentation: callPresentation(
    ({ reason, status, phase, upstream, account, credentialsRenewed, renewalFailure }) => {
      const service = account === undefined ? "The connected service" : account.provider;
      const target = account === undefined ? "" : ` for account “${account.label}”`;
      /** The HTTP status, then the phase the failure happened in. */
      const context = `${status === undefined ? "" : ` (HTTP ${status})`}${phaseText(phase)}`;
      const reported = upstreamText(upstream, "The service reported");
      const instructions =
        "Do not print credentials or raw responses, switch accounts, or change authentication methods automatically.";
      switch (reason) {
        case "unavailable":
          return {
            title: "Service temporarily unavailable",
            description: `${service} returned a server error${context}.${reported}`,
            recovery: {
              action:
                "Wait at least 30 seconds before trying again, at most twice. If it keeps failing, report the repeated server error.",
              instructions: `The response does not identify the root cause. Check service status and request-specific diagnostics if available. Do not change credentials without authentication evidence. ${instructions}`,
            },
            retryable: true,
          };
        case "unauthorized":
          if (credentialsRenewed === true)
            return {
              title: "Access renewed; request not repeated",
              description: `${service} rejected the credentials${target}${context}.${reported} Executor has renewed the account’s access, but did not repeat this call automatically.`,
              recovery: {
                action: "The renewed access is used from now on.",
                instructions: `Executor renewed the account’s access but did not repeat this call. Renewal does not establish whether an earlier part of the call changed data. ${instructions}`,
              },
              retryable: false,
            };
          // The renewal's own error says what failed. Only a call that may write reports it, so
          // its recovery is the one for such a call, never repeating it.
          if (renewalFailure !== undefined)
            return {
              title: renewalFailure.title,
              description: `${service} rejected the credentials${target}${context}.${reported} Renewing the account’s access failed: ${renewalFailure.description}`,
              ...renewalRecovery(renewalFailure),
              retryable: false,
            };
          return {
            title: "Authentication failed",
            description: `${service} rejected the credentials${target}${context}.${reported}`,
            recovery: {
              action:
                "Check how the request authenticates. Update credentials or reconnect only if the evidence requires it.",
              instructions: `The provider rejected authentication. This does not establish whether credentials are expired, revoked, missing, or sent incorrectly. ${instructions}`,
            },
            retryable: false,
          };
        case "forbidden":
          return {
            title: "Permission required",
            description: `${service} reported insufficient permission${target}${context}.${reported}`,
            recovery: {
              action: "Check the account’s permissions and the service’s access requirements.",
              instructions: `The provider explicitly reported insufficient permission. Do not invent required scopes or organization approval requirements. ${instructions}`,
            },
            retryable: false,
          };
        case "rate_limited":
          return {
            title: "Service rate limit reached",
            description: `${service} is limiting requests${target}${context}.${reported}`,
            recovery: {
              action: "Wait for the service’s rate limit to reset before trying again.",
              instructions: `The service reported a rate limit. Wait for its documented retry time before another read attempt. Avoid immediate repeated calls. ${instructions}`,
            },
            retryable: true,
          };
        case "rejected":
          return {
            title: "Service rejected the request",
            description: `${service} refused the request${target}${context}.${reported === "" ? " We could not identify the cause from the available error details." : reported}`,
            recovery: {
              action: "Check the service’s access requirements and rate limits.",
              instructions: `A forbidden HTTP response alone does not prove invalid credentials, insufficient scopes, SSO restrictions, or a rate limit. ${instructions}`,
            },
            retryable: false,
          };
      }
    },
  ),
});
/** Safe, decoded provider failure with product recovery guidance. */
export type AppProviderFailed = typeof AppProviderFailed.Type;

/** Builds from before failure details existed send none; keep their generic reason. */
export const appFailure = ({
  source,
  errorName,
  code,
  message,
  fields,
}: {
  readonly source?: AppFailure["source"];
  readonly errorName?: string;
  readonly code?: string;
  readonly message?: string;
  readonly fields?: AppFailure["fields"];
}) =>
  source === undefined || errorName === undefined || message === undefined
    ? Option.none<AppFailure>()
    : Option.some<AppFailure>({
        source,
        errorName,
        message,
        ...(code === undefined ? {} : { code }),
        ...(fields === undefined ? {} : { fields }),
      });

/**
 * Keep a skill loader's or MCP server's safe fields, and the error the app's own factory or loader
 * raised; other evaluation failures stay generic.
 */
export const evaluationFailure = (
  identity: { app: AppId; deployment: DeploymentId },
  error: unknown,
  reason = "App evaluation failed",
) =>
  new AppEvaluationFailed({
    app: identity.app,
    deployment: identity.deployment,
    reason,
    ...(Schema.is(SkillLoadFailed)(error)
      ? {
          skills: {
            reason: error.reason,
            ...(error.message ? { message: error.message } : {}),
            ...(error.status === undefined ? {} : { status: error.status }),
            ...(error.missing === undefined ? {} : { missing: error.missing }),
          },
        }
      : {}),
    ...(Schema.is(HostEvaluationFailed)(error)
      ? Option.match(appFailure(error), { onNone: () => ({}), onSome: (failure) => ({ failure }) })
      : {}),
    ...(Schema.is(McpError)(error) ? { mcp: mcpFailure(error) } : {}),
  });

/**
 * What a router that could not list its tools reports to a caller of the listing, such as MCP
 * discovery. A provider failure here names no account; a call into the router attributes it to
 * the selected account.
 */
export const routerFailure = (
  identity: { app: AppId; deployment: DeploymentId },
  error: HostRouterError,
) =>
  Schema.is(ProviderError)(error)
    ? new AppProviderFailed({
        ...identity,
        reason: error.reason,
        ...(error.status === undefined ? {} : { status: error.status }),
        ...(error.phase === undefined ? {} : { phase: error.phase }),
        ...(error.upstream === undefined ? {} : { upstream: error.upstream }),
      })
    : evaluationFailure(identity, error);

const toolNotFound = ({ tool }: { readonly tool: ToolName }): RefusalCopy => {
  const description = `The app does not expose a tool named “${tool}”.`;
  return { message: description, title: "Tool not found", description };
};
/**
 * This evaluated app does not expose the named tool. With `mayHaveWritten`, the app's reply to a
 * call that may write said so after the app's code received the call, as for every refusal below.
 */
export const ToolNotFound = ApiError.define({
  tag: "ToolNotFound",
  status: 404,
  fields: { app: AppId, deployment: DeploymentId, tool: ToolName, mayHaveWritten: MayHaveWritten },
  message: refusalMessage(toolNotFound),
  recorded: () => "The app does not expose the requested tool",
});
export type ToolNotFound = typeof ToolNotFound.Type;

/** Whether a tool reads or writes; callers name it so storage is opened in the right mode. */
export const ToolKind = Schema.Literals(["query", "mutation"]);
export type ToolKind = typeof ToolKind.Type;

const toolKindMismatch = ({
  tool,
  requested,
  actual,
}: {
  readonly tool: ToolName;
  readonly requested: ToolKind;
  readonly actual: ToolKind;
}): RefusalCopy => {
  const description = `The tool “${tool}” is a ${actual}, but it was called as a ${requested}.`;
  return {
    message: `${description} Call it as a ${actual}.`,
    title: "Tool kind changed",
    description,
  };
};
/**
 * The tool exists with the other kind; a query's caller calls it again with `actual`. The app's
 * framework reports this after evaluating the app, so the copy does not claim that nothing ran,
 * and a call that may have written is not told to call again.
 */
export const ToolKindMismatch = ApiError.define({
  tag: "ToolKindMismatch",
  status: 409,
  fields: {
    app: AppId,
    deployment: DeploymentId,
    tool: ToolName,
    requested: ToolKind,
    actual: ToolKind,
    mayHaveWritten: MayHaveWritten,
  },
  message: refusalMessage(toolKindMismatch),
  recorded: ({ requested, actual }: { readonly requested: ToolKind; readonly actual: ToolKind }) =>
    `The tool is a ${actual}, but it was called as a ${requested}`,
});
export type ToolKindMismatch = typeof ToolKindMismatch.Type;

/** How input problems read; supplied values are never included. */
const inputProblems =
  "Each problem names an input path and what that path expects: a type, the values the schema allows, an object's keys (? marks an optional key, ... marks other keys allowed), an unexpected key to remove, or the alternatives a union accepts. For a union, pick one alternative and set the key that tells them apart; the problems after it are for the closest alternative. Nest each field where the tool's input type from tools.search or tools.search.describe places it";
const inputInvalid = ({ problems }: { readonly problems: ReadonlyArray<string> }): RefusalCopy => {
  const description = `Input failed validation: ${problems.join("; ")}`.slice(0, 4096);
  return {
    message: description,
    title: "Input failed validation",
    description,
    recovery: {
      action: "Change the input to the shape each problem expects, then call the tool again.",
      instructions: `${inputProblems}, then retry.`,
    },
  };
};
/**
 * The tool input did not match its declared schema. The app states its problems, which name the
 * caller's keys and paths and the schema's keys, values and patterns; only the caller reads them.
 */
export const InputInvalid = ApiError.define({
  tag: "InputInvalid",
  status: 422,
  fields: {
    app: AppId,
    deployment: DeploymentId,
    tool: ToolName,
    problems: Schema.Array(Schema.String),
    mayHaveWritten: MayHaveWritten,
  },
  message: (fields) => refusalMessage(inputInvalid)(fields).slice(0, 4096),
  recorded: () => "The tool's input did not match its schema; the problems are not recorded",
});
export type InputInvalid = typeof InputInvalid.Type;

/**
 * Statuses that report a temporary condition, so repeating the same request later may help. Other
 * server errors, such as 501 Not Implemented or 505 HTTP Version Not Supported, do not. A declared
 * error states no retry policy of its own, so its status decides.
 */
const temporaryStatus = (status: number) =>
  status === 408 ||
  status === 425 ||
  status === 429 ||
  status === 500 ||
  status === 502 ||
  status === 503 ||
  status === 504;

/**
 * App storage failures a later attempt may not meet: a timeout, a failure to complete, or the
 * cache being unavailable for the operation, such as when a concurrent load took over the lease to
 * publish its value. A cache request it cannot accept (`invalid`) or one over its limits
 * (`capacity`), and app data limits, fail the same way again.
 */
const temporaryStorage = ({ errorName, code }: AppFailure) =>
  errorName === "CacheError" &&
  (code === "timeout" || code === "storage" || code === "unavailable");

/** The error name and code a failure reported, for copy. */
const failureName = ({ errorName, code }: AppFailure) =>
  `${errorName}${code === undefined ? "" : `, ${code}`}`;

/**
 * A tool call failed once it reached the app, or its result was lost; its external effects may
 * already have occurred. Without `mayHaveWritten`, the call was a query, which only reads.
 */
export const ToolCallFailed = UserFacingError.define({
  tag: "ToolCallFailed",
  status: 502,
  fields: {
    app: AppId,
    deployment: DeploymentId,
    tool: ToolName,
    /**
     * Only the app's own bounded error message, or its MCP server's bounded JSON-RPC error, with
     * account secrets replaced.
     */
    reason: Schema.String,
    /** The error the app's API declared and returned, with its own status and recovery. */
    response: Schema.optional(ApiErrorResponse),
    /** The app's own error, or the app data failure, that stopped the operation. */
    failure: Schema.optional(AppFailure),
    /** The app's MCP server refused or failed the tool call, such as with a JSON-RPC error. */
    mcp: Schema.optional(McpFailure),
    mayHaveWritten: MayHaveWritten,
  },
  recorded: ({ failure, mcp, response }) =>
    mcp !== undefined
      ? `The tool failed: ${recordedMcp(mcp)}`
      : failure !== undefined
        ? `The tool failed: ${recordedApp(failure)}`
        : response !== undefined
          ? "The tool failed after starting"
          : "The tool failed without further detail",
  presentation: callPresentation(({ reason, response, failure, mcp }) => {
    if (mcp !== undefined) return mcpFailurePresentation(mcp);
    // The API's own recovery, when it stated one, is shown as the API wrote it.
    if (response !== undefined)
      return {
        title: "The app’s API returned an error",
        description: response.message,
        ...(response.recovery === undefined
          ? {
              recovery: {
                action: "Read the API’s error to determine the next step.",
                instructions: `An API the app calls returned an error its OpenAPI document declares (${response.code}, HTTP ${response.status}). Read its message to decide whether the input, the account's access or the API is at fault.${temporaryStatus(response.status) ? ` HTTP ${response.status} can be temporary: for a read, one later attempt may help.` : ""}`,
              },
            }
          : { recovery: response.recovery, declared: true as const }),
        retryable: temporaryStatus(response.status),
      };
    if (failure === undefined)
      return {
        title: "Tool failed",
        description: `${reason.endsWith(".") ? reason : `${reason}.`} No further failure detail is available.`,
        recovery: {
          action:
            "Try once more. If it fails again, inspect the available diagnostics or report the failure.",
          instructions:
            "No further failure detail is available, and this error does not establish whether the tool completed. For a read, one further attempt may help. If it fails again, inspect the available diagnostics or report the failure.",
        },
        retryable: true,
      };
    switch (failure.source) {
      case "service":
        return {
          title: "The app’s service integration failed",
          description: reason,
          recovery: {
            action: "Read the reported error and check the corresponding request or configuration.",
            instructions: `The app’s service integration failed (${failureName(failure)}). The reported details do not establish whether the cause is the request, the service or Executor.${failure.errorName !== "OpenapiError" ? "" : failure.code === "invalid_definition" ? " The API's OpenAPI document describes this operation in a way Executor cannot use. Check the operation's definition in that document." : " The message names the API operation when it is known and, when a response arrived, its status, media type and length; the response body is not shown. Check the operation's parameters, the API's status, and whether its OpenAPI document declares this error."}`,
          },
          retryable: false,
        };
      case "storage":
        return temporaryStorage(failure)
          ? {
              title: "App storage did not complete the operation",
              description: reason,
              recovery: {
                action:
                  "Retry once after a short wait. If it fails again, report that the app’s storage is failing.",
                instructions: `The app's storage did not complete this operation (${failureName(failure)}), such as on a timeout, a temporary failure or a cache that was unavailable for it. For a read, a bounded retry may help. If the same failure repeats, the host may not provide the storage the app uses.`,
              },
              retryable: true,
            }
          : {
              title: "App storage rejected the operation",
              description: reason,
              recovery: {
                action: "Change the operation to stay within the storage rule or limit it names.",
                instructions: `The app's storage refused this operation (${failureName(failure)}): it breaks a schema or limit rule, so the same operation is expected to fail again. Correct the operation, such as the app's query, mutation or cache use, before another attempt.`,
              },
              retryable: false,
            };
      case "app":
        return {
          title: "The app’s tool failed",
          description: reason,
          recovery: {
            action:
              "Read the error to determine whether input, app code, configuration or Executor needs attention.",
            instructions:
              "This error arose while running the app’s tool. Corrected input is a new call. For a read with an uncertain temporary cause, one further attempt may help.",
          },
          retryable: true,
        };
    }
  }),
});
export type ToolCallFailed = typeof ToolCallFailed.Type;

/**
 * An MCP failure of an operation. A failure of the tools/call request fails the call; one before
 * a request reached the tool, such as a refused session, is reported like evaluation failures.
 */
export const operationMcpFailure = (
  identity: { app: AppId; deployment: DeploymentId; tool: ToolName },
  error: McpError,
) =>
  error.phase === "call"
    ? new ToolCallFailed({
        ...identity,
        reason: mcpFailurePresentation(mcpFailure(error)).description,
        mcp: mcpFailure(error),
      })
    : evaluationFailure(identity, error);

/**
 * The tool's approval policy denied the call. The decision and the report of it come from the
 * app's code, so the copy says whose decision it was without claiming what the app did.
 */
export const ToolBlocked = UserFacingError.define({
  tag: "ToolBlocked",
  status: 403,
  fields: { app: AppId, deployment: DeploymentId, tool: ToolName, mayHaveWritten: MayHaveWritten },
  presentation: callPresentation(({ tool }) => ({
    title: "Blocked by the app’s approval policy",
    description: `The approval policy in the app’s code denied this call to “${tool}”.`,
    recovery: {
      action:
        "Check what the app’s approval policy requires for this tool. If the call should be allowed, meet those requirements or, with the user’s agreement, change the policy and deploy it. Otherwise use a different tool.",
      instructions: `The approval policy that “${tool}” declares in the app’s code returned \`denied\` for this call. Do not retry the call unchanged. Tell the user which tool was blocked. Read the policy to see what it checks: its input, the app’s configuration, or the user’s access. If the call should be allowed and a requirement is unmet, meet it (for example, ask the user to enable the setting or grant the access) and call the tool again. Change the app’s source only when the policy itself is wrong and the user agrees: find the tool’s \`approval\` option, or the \`withApprovals\` policy over its router, return \`user-approval\` to ask the user or \`approved\` to run it, then deploy. Otherwise reach the goal with a different tool.`,
    },
  })),
  recorded: () => "The tool's approval policy blocked this call.",
});
export type ToolBlocked = typeof ToolBlocked.Type;

const toolApprovalRequired = ({ tool }: { readonly tool: ToolName }): RefusalCopy => ({
  message: `“${tool}” needs approval before it runs, and this request cannot present an approval prompt.`,
  title: "Approval required",
  description: `“${tool}” needs approval, and this request cannot present an approval prompt.`,
});
/**
 * Adapter diagnostic for callers that cannot yet present a pending SDK approval request
 * (`approvalRequired`). The app's code asked for the approval, so for a call that may write the
 * copy does not claim that the tool has not run.
 */
export const ToolApprovalRequired = ApiError.define({
  tag: "ToolApprovalRequired",
  status: 409,
  fields: { app: AppId, deployment: DeploymentId, tool: ToolName, mayHaveWritten: MayHaveWritten },
  message: refusalMessage(toolApprovalRequired),
  recorded: () => "The tool needs approval, and this request cannot present an approval prompt.",
});
export type ToolApprovalRequired = typeof ToolApprovalRequired.Type;

const toolPolicyFailed = ({ tool }: { readonly tool: ToolName }): RefusalCopy => {
  const description = `The approval policy of “${tool}” failed before deciding.`;
  return { message: description, title: "Approval policy failed", description };
};
/**
 * The tool's approval policy could not decide. The policy is the app's code, so the copy does not
 * claim what ran; author failure details remain private.
 */
export const ToolPolicyFailed = ApiError.define({
  tag: "ToolPolicyFailed",
  status: 500,
  fields: { app: AppId, deployment: DeploymentId, tool: ToolName, mayHaveWritten: MayHaveWritten },
  message: refusalMessage(toolPolicyFailed),
  recorded: () => "The tool's approval policy failed before deciding.",
});
export type ToolPolicyFailed = typeof ToolPolicyFailed.Type;

/**
 * Every error a failed tool call reports to its caller once the call reached the app's code,
 * including a failure of Executor's own storage after it. Each records `mayHaveWritten` for a call
 * that may have written, and presents it through `callPresentation`.
 */
export const CallFailure = Schema.Union([
  ToolCallFailed,
  AppProviderFailed,
  AppEvaluationFailed,
  ToolElicitationFailed,
  ToolNotFound,
  ToolKindMismatch,
  InputInvalid,
  ToolBlocked,
  ToolApprovalRequired,
  ToolPolicyFailed,
  StorageError,
  CredentialsError,
]);
export type CallFailure = typeof CallFailure.Type;

/** A product error's own presentation. */
const presented = ({
  title,
  description,
  recovery,
  retryable,
}: UserFacingError): ErrorPresentation => ({ title, description, recovery, retryable });

/**
 * A call failure as a surface that presents failures itself shows it, such as MCP or a dashboard:
 * the error's own presentation, or a refusal's. Both are composed by `callPresentation`, so a call
 * that may have written leads with Executor's instruction not to repeat it and no cause advises
 * another call. A query's refusal without recovery advice has no presentation; its code names it.
 */
export const callFailurePresentation = (failure: CallFailure): ErrorPresentation | undefined =>
  Match.value(failure).pipe(
    Match.tagsExhaustive({
      ToolNotFound: refusalPresentation(toolNotFound),
      ToolKindMismatch: refusalPresentation(toolKindMismatch),
      InputInvalid: refusalPresentation(inputInvalid),
      ToolApprovalRequired: refusalPresentation(toolApprovalRequired),
      ToolPolicyFailed: refusalPresentation(toolPolicyFailed),
      ToolCallFailed: presented,
      AppProviderFailed: presented,
      AppEvaluationFailed: presented,
      ToolElicitationFailed: presented,
      ToolBlocked: presented,
      StorageError: presented,
      CredentialsError: presented,
    }),
  );

/**
 * The presentation of a failure whose call may have written, for a surface that otherwise shows
 * the failure with its own fixed copy, such as a dashboard; undefined for any other error.
 */
export const mayHaveWrittenFailure = (error: unknown): ErrorPresentation | undefined =>
  Schema.is(CallFailure)(error) && error.mayHaveWritten === true
    ? callFailurePresentation(error)
    : undefined;

/** A saved account identity; credentials are always resolved again on resume. */
export const InvocationAccount = Schema.Struct({
  id: AccountId,
  owner: OwnerId,
  provider: ProviderId,
  method: Schema.String,
});
/**
 * Reviewed call with decoded arguments, exact code version and account identities. A call without
 * a profile omits both profile keys: pending requests are JSON, which has no undefined.
 */
export const ToolInvocation = Schema.Struct({
  profile: Schema.optionalKey(ProfileId),
  profileRevision: Schema.optionalKey(ProfileRevision),
  app: AppId,
  owner: OwnerId,
  deployment: DeploymentId,
  tool: ToolName,
  /**
   * The caller's kind. Without one (a call that named none, or saved before calls named one),
   * resumption dispatches with the catalog's kind and treats the call as one that may write.
   */
  kind: Schema.optionalKey(ToolKind),
  input: Json,
  accounts: Schema.Record(
    Schema.String,
    Schema.Union([InvocationAccount, Schema.Array(InvocationAccount)]),
  ),
});
export type ToolInvocation = typeof ToolInvocation.Type;
/** Completed transport; toolError marks a framework-recognized semantic error. Value is unchanged. */
export const ToolCompleted = Schema.Struct({
  status: Schema.Literal("completed"),
  value: Json,
  toolError: Schema.optionalKey(Schema.Literal(true)),
});
/**
 * Pending call plus the MCP confirmation form the SDK builds from it, which shortens long arguments.
 * The SDK does not collect the response.
 */
export const ToolPending = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: ApprovalRequestId,
  invocation: ToolInvocation,
  elicitation: ApprovalElicitation,
  expiresAt: Schema.Number,
});
/** Public outcome of an initial call. */
export const ToolCallResult = Schema.Union([ToolCompleted, ToolPending]);
export type ToolCallResult = typeof ToolCallResult.Type;

/**
 * The failure a caller reports when it cannot present a pending call's approval prompt. The app's
 * code asked for the approval after it received the call, so a call that may write (not a query)
 * may already have made its change.
 */
export const approvalRequired = ({ invocation }: Pick<typeof ToolPending.Type, "invocation">) =>
  new ToolApprovalRequired({
    app: invocation.app,
    deployment: invocation.deployment,
    tool: invocation.tool,
    ...(invocation.kind === "query" ? {} : { mayHaveWritten: true as const }),
  });
/** Every way a live call fails. A resumed call is the same call, so it fails the same ways. */
const toolCallErrors = [
  ...ProfileErrors,
  StorageError,
  CredentialsError,
  AppNotFound,
  AppNotDeployed,
  DeploymentNotFound,
  AppEvaluationFailed,
  AppProviderFailed,
  AccountNotFound,
  AccountRequired,
  AccountSelectionInvalid,
  ToolNotFound,
  ToolKindMismatch,
  InputInvalid,
  ToolCallFailed,
  OAuthReconnectRequired,
  OAuthRenewalFailed,
  ToolBlocked,
  ToolApprovalRequired,
  ToolPolicyFailed,
  ToolElicitationFailed,
  RequestInvalid,
] as const;
/**
 * What resuming an approved call failed with, exactly as the live call would report it. Some of
 * these, such as an account that no longer resolves, fail before the tool's code is dispatched.
 */
export const ToolResumeFailure = Schema.Union(toolCallErrors);
export type ToolResumeFailure = typeof ToolResumeFailure.Type;
/** Only the consuming caller receives an execution result. Duplicates do not replay it. */
export const ToolResumeResult = Schema.Union([
  ToolCompleted,
  Schema.Struct({ status: Schema.Literal("denied"), requestId: ApprovalRequestId }),
  Schema.Struct({ status: Schema.Literal("cancelled"), requestId: ApprovalRequestId }),
  /**
   * Executor did not resume the saved call: the request expired, or Executor read the app,
   * deployment, profile or accounts and they differ from the reviewed call.
   */
  Schema.Struct({
    status: Schema.Literal("failed"),
    requestId: ApprovalRequestId,
    reason: Schema.Literals(["expired", "context-changed"]),
  }),
  /** Resuming the approved call failed with the error a live call reports. */
  Schema.Struct({
    status: Schema.Literal("failed"),
    requestId: ApprovalRequestId,
    reason: Schema.Literal("execution-failed"),
    error: ToolResumeFailure,
    /**
     * `unconfirmed`: Executor's own storage failed, with `error`, while it read the current app,
     * deployment, profile or accounts to compare with the reviewed call, so it did not resume the
     * call. Nothing shows that they changed. It is a field, not a reason: clients that predate it,
     * such as dashboards still open during a deploy, reject an unknown reason but ignore a field.
     */
    context: Schema.optionalKey(Schema.Literal("unconfirmed")),
  }),
  Schema.Struct({ status: Schema.Literal("already-consumed"), requestId: ApprovalRequestId }),
]);
export type ToolResumeResult = typeof ToolResumeResult.Type;
/**
 * A resume result as a client receives it. Servers always send a `ToolResumeResult`, but servers
 * from releases before `error` was added send `execution-failed` without it. A client can meet one:
 * an open dashboard tab outlives a rollback, and Cloud deploys its dashboard and API separately.
 * So this also accepts that member with neither `error` nor `context`; a supplied one must decode
 * as above.
 */
export const ToolResumeResultReceived = ToolResumeResult.mapMembers((members) => [
  ...members,
  Schema.Struct({
    status: Schema.Literal("failed"),
    requestId: ApprovalRequestId,
    reason: Schema.Literal("execution-failed"),
    error: Schema.optionalKey(Schema.Never),
    context: Schema.optionalKey(Schema.Never),
  }),
]);
export type ToolResumeResultReceived = typeof ToolResumeResultReceived.Type;
/**
 * A pending request a host reads to show the person the call it would resume. The arguments are the
 * saved invocation's. The issuer is the host's own record; the host refuses requests it did not issue.
 */
export const ToolApproval = Schema.Struct({
  invocation: ToolInvocation,
  expiresAt: Schema.Number,
  issuer: Schema.optional(ToolApprovalIssuer),
});
export type ToolApproval = typeof ToolApproval.Type;
/** Unknown request, a request outside an optional owner filter, or one issued to another flow. */
export class ToolApprovalNotFound extends Schema.TaggedError<ToolApprovalNotFound>()(
  "ToolApprovalNotFound",
  {
    requestId: ApprovalRequestId,
  },
  { httpApiStatus: 404 },
) {}
/** Shared operation inputs. Only list's HTTP limit is string-encoded. Resume accepts no replacement invocation. */
export const ToolInputs = {
  list: Schema.Struct({
    app: AppId,
    profile: Schema.optional(ProfileId),
    expectedProfileRevision: Schema.optional(ProfileRevision),
    deployment: Schema.optional(DeploymentId),
    cursor: Schema.optional(Cursor),
    limit: Schema.optional(PageLimit),
  }),
  index: Schema.Struct({
    app: AppId,
    profile: Schema.optional(ProfileId),
    expectedProfileRevision: Schema.optional(ProfileRevision),
    deployment: Schema.optional(DeploymentId),
  }),
  get: Schema.Struct({
    app: AppId,
    profile: Schema.optional(ProfileId),
    expectedProfileRevision: Schema.optional(ProfileRevision),
    deployment: Schema.optional(DeploymentId),
    tool: ToolName,
  }),
  call: Schema.Struct({
    app: AppId,
    profile: Schema.optional(ProfileId),
    expectedProfileRevision: Schema.optional(ProfileRevision),
    deployment: Schema.optional(DeploymentId),
    tool: ToolName,
    /**
     * "query" for tools the catalog marks readOnly, otherwise "mutation". Omitted, it is read from
     * the catalog; supplied and wrong, the call fails with ToolKindMismatch before anything runs.
     */
    kind: Schema.optional(ToolKind),
    input: Schema.optional(Json),
  }),
  pruneApprovals: Schema.Struct({ owner: Schema.optional(OwnerId) }),
  resume: Schema.Struct({
    requestId: ApprovalRequestId,
    response: ApprovalResponse,
    owner: Schema.optional(OwnerId),
  }),
};

/**
 * Calls return completion or a persisted approval request. Resume trusts the SDK caller's
 * elicitation response, pins the saved deployment and rejects changed account identities. Unknown
 * requests fail; repeated resumes report already-consumed while the marker is retained.
 */
export const ToolsGroup = HttpApiGroup.make("tools")
  .add(
    HttpApiEndpoint.get("list", "/v1/tools", {
      query: ToolInputs.list.fields,
      success: ToolPage,
      error: [
        ...ProfileErrors,
        StorageError,
        CredentialsError,
        AppNotFound,
        AppNotDeployed,
        DeploymentNotFound,
        AppEvaluationFailed,
        ToolListingTimedOut,
        AppProviderFailed,
        AccountNotFound,
        AccountRequired,
        AccountSelectionInvalid,
        OAuthReconnectRequired,
        OAuthRenewalFailed,
      ],
    }).annotate(
      OpenApi.Description,
      "Inspect an app current tools. Returns the active deployment and a cursor for the next page.",
    ),
  )
  .add(
    HttpApiEndpoint.get("index", "/v1/tools/index", {
      query: ToolInputs.index.fields,
      success: ToolIndex,
      error: [
        ...ProfileErrors,
        StorageError,
        CredentialsError,
        AppNotFound,
        AppNotDeployed,
        DeploymentNotFound,
        AppEvaluationFailed,
        ToolListingTimedOut,
        AppProviderFailed,
        AccountNotFound,
        AccountRequired,
        AccountSelectionInvalid,
        OAuthReconnectRequired,
        OAuthRenewalFailed,
      ],
    }).annotate(
      OpenApi.Description,
      "List an app's current tools without their schemas. Read one tool's schemas with get.",
    ),
  )
  .add(
    HttpApiEndpoint.get("get", "/v1/tools/get", {
      query: ToolInputs.get.fields,
      success: Tool,
      error: [
        ...ProfileErrors,
        StorageError,
        CredentialsError,
        AppNotFound,
        AppNotDeployed,
        DeploymentNotFound,
        AppEvaluationFailed,
        ToolListingTimedOut,
        AppProviderFailed,
        AccountNotFound,
        AccountRequired,
        AccountSelectionInvalid,
        OAuthReconnectRequired,
        OAuthRenewalFailed,
        ToolNotFound,
      ],
    }).annotate(
      OpenApi.Description,
      "Describe one of an app's current tools, including its schemas.",
    ),
  )
  .add(
    HttpApiEndpoint.post("call", "/v1/tools/call", {
      payload: ToolInputs.call,
      success: ToolCallResult,
      error: toolCallErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("resume", "/v1/tools/resume", {
      payload: ToolInputs.resume,
      success: ToolResumeResult,
      error: [StorageError, CredentialsError, ToolApprovalNotFound, RequestInvalid],
    }),
  )
  .add(
    HttpApiEndpoint.post("pruneApprovals", "/v1/tools/approvals/prune", {
      payload: ToolInputs.pruneApprovals,
      success: Schema.Void,
      error: [StorageError, RequestInvalid],
    }),
  );
