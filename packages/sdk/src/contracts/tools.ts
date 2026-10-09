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
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { ProfileErrors, ProfileRevision } from "./profiles.ts";
/** Existing tool call seam, using the configured app's saved accounts. Discovery design is deferred. */
import { Option, Schema } from "effect";
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

/** Per-invocation host capabilities. These are not HTTP payloads and never enter approval storage. */
export interface ToolInvocationOptions {
  readonly elicitation?: ElicitationHandler;
}
/** How an in-process caller with its own wait bound reads a tool listing. Not an HTTP input. */
export interface ToolListOptions {
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

/** A running tool could not complete its user interaction. Earlier effects may have completed. */
const elicitationFailures = {
  unavailable: "The tool asked for input, but this caller cannot answer input requests.",
  transaction: "The tool asked for input inside a database transaction, which is not allowed.",
  "invalid-request": "The tool's input request was invalid.",
  "invalid-response": "The answer did not match the input the tool requested.",
  transport: "The tool's input request could not be delivered.",
  expired: "The tool's input request expired before it was answered.",
  forbidden: "This caller may no longer answer the tool's input request.",
} as const;
export const ToolElicitationFailed = ApiError.define({
  tag: "ToolElicitationFailed",
  status: 422,
  fields: {
    app: AppId,
    deployment: DeploymentId,
    tool: ToolName,
    reason: ElicitationFailed.fields.reason,
  },
  message: ({ reason }) => elicitationFailures[reason],
  recorded: ({ reason }) => elicitationFailures[reason],
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

/** Present an MCP server failure from its safe phase, reason, HTTP status and JSON-RPC error. */
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
  const verify =
    phase === "call"
      ? "Before repeating the call, check whether it already made changes, then verify that it succeeds."
      : "Verify that the Tools page loads after the repair.";
  const instructions = `The app's MCP server failed while ${stage}. Inspect the app's MCP server URL, transport and account requirements from its source or import settings. Do not print credentials or raw responses, and do not change accounts automatically. ${verify}`;
  switch (reason) {
    case "timeout":
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
          action: "Check the account’s credentials. Update its API key or reconnect its sign-in.",
          instructions,
        },
        retryable: false,
      };
    case "invalid_response":
      return {
        title: "MCP server response not supported",
        // Includes Executor refusing to follow the server to another origin.
        description: `The app’s MCP server returned a response Executor could not use while ${stage}, such as an unreadable message or an address on another origin.${answered}`,
        recovery: { action: "Check that the app points at a supported MCP server.", instructions },
        retryable: false,
      };
    case "invalid_input":
      // A call's input that cannot be sent as the tool's arguments never reached the server.
      return phase === "call"
        ? {
            title: "Tool input not sent",
            description: "The input could not be sent to the app’s MCP server as tool arguments.",
            recovery: {
              action: "Pass the tool an object that matches its input schema.",
              instructions,
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
          description: `The app’s MCP server could not handle the request yet while ${stage}${http}.${answered}`,
          recovery: {
            action: "Try again later. If this continues, check the MCP server’s status.",
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
      // may not be reachable, or Executor's own request failed.
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
          : {
              title: "MCP server request failed",
              description: `The request to the app’s MCP server failed while ${stage}.`,
              recovery: {
                action: "Try again. If this continues, check the MCP server’s status.",
                instructions,
              },
              retryable: true,
            }
        : {
            title: "MCP server returned an error",
            description: `The app’s MCP server returned an error while ${stage}.${answered}`,
            recovery: {
              action:
                phase === "call"
                  ? "Read the server’s error, then correct the tool’s input or the server’s access."
                  : "Read the server’s error, then correct the app’s MCP server settings or access.",
              instructions,
            },
            retryable: false,
          };
  }
};

/** Evaluating the app's live definition failed before any tool ran. */
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
  presentation: ({ skills, mcp, failure }) =>
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
  },
  recorded: ({ reason, status, phase }) =>
    `The connected service failed (${reason})${recordedStatus(status)}${phaseText(phase)}`,
  presentation: ({ reason, status, phase, upstream, account, credentialsRenewed }) => {
    const service = account === undefined ? "The connected service" : account.provider;
    const target = account === undefined ? "" : ` for account “${account.label}”`;
    /** The HTTP status, then the phase the failure happened in. */
    const context = `${status === undefined ? "" : ` (HTTP ${status})`}${phaseText(phase)}`;
    const reported = upstreamText(upstream, "The service reported");
    const instructions =
      "Use the selected app and profile. Inspect only safe status codes and documented provider error codes. Do not print credentials or raw responses, switch accounts, or change authentication methods automatically. Verify tool discovery and a safe read after the repair. Before repeating a failed operation, check whether it already made changes.";
    switch (reason) {
      case "unavailable":
        return {
          title: "Service temporarily unavailable",
          description: `${service} returned a server error${context}.${reported}`,
          recovery: {
            action: "Try again. If this continues, check the service’s status and server address.",
            instructions: `The upstream returned a server error. Do not replace credentials or change authentication to address a service outage. ${instructions}`,
          },
          retryable: true,
        };
      case "unauthorized":
        if (credentialsRenewed === true)
          return {
            title: "Access renewed; request not repeated",
            description: `${service} rejected the credentials${target}${context}.${reported} Executor has renewed the account’s access, but did not repeat this change automatically.`,
            recovery: {
              action:
                "Check whether the change was already made, then try again. The renewed access is used from now on.",
              instructions: `The provider rejected the account’s previous access token and Executor renewed it. Mutations are never repeated automatically: an earlier request in the same call may already have made changes. ${instructions}`,
            },
            retryable: true,
          };
        return {
          title: "Authentication failed",
          description: `${service} rejected the credentials${target}${context}.${reported}`,
          recovery: {
            action:
              "Check the account’s credentials. Update its API key or reconnect its sign-in, then try again.",
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
            instructions: `The provider reported a rate limit. Do not replace credentials to fix it. ${instructions}`,
          },
          retryable: true,
        };
      case "rejected":
        return {
          title: "Service rejected the request",
          description: `${service} refused the request${target}${context}.${reported === "" ? " We could not identify the cause from the available error details." : reported}`,
          recovery: {
            action: "Check the service’s access requirements and rate limits before trying again.",
            instructions: `A forbidden HTTP response alone does not prove invalid credentials, insufficient scopes, SSO restrictions, or a rate limit. ${instructions}`,
          },
          retryable: false,
        };
    }
  },
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

/** This evaluated app does not expose the named tool. */
export const ToolNotFound = ApiError.define({
  tag: "ToolNotFound",
  status: 404,
  fields: { app: AppId, deployment: DeploymentId, tool: ToolName },
  message: ({ tool }) => `The app does not expose a tool named “${tool}”.`,
  recorded: () => "The app does not expose the requested tool",
});
export type ToolNotFound = typeof ToolNotFound.Type;

/** Whether a tool reads or writes; callers name it so storage is opened in the right mode. */
export const ToolKind = Schema.Literals(["query", "mutation"]);
export type ToolKind = typeof ToolKind.Type;

/** The tool exists with the other kind. Nothing ran; call it again with `actual`. */
export const ToolKindMismatch = ApiError.define({
  tag: "ToolKindMismatch",
  status: 409,
  fields: {
    app: AppId,
    deployment: DeploymentId,
    tool: ToolName,
    requested: ToolKind,
    actual: ToolKind,
  },
  message: ({ tool, requested, actual }) =>
    `The tool “${tool}” is a ${actual}, but it was called as a ${requested}. Nothing ran; call it as a ${actual}.`,
  recorded: ({ requested, actual }) =>
    `The tool is a ${actual}, but it was called as a ${requested}`,
});
export type ToolKindMismatch = typeof ToolKindMismatch.Type;

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
  },
  message: ({ problems }) => `Input failed validation: ${problems.join("; ")}`.slice(0, 4096),
  recorded: () => "The tool's input did not match its schema; the problems are not recorded",
});
export type InputInvalid = typeof InputInvalid.Type;

/** A tool failed after starting; its external effects may already have occurred. */
export const ToolCallFailed = ApiError.define({
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
    response: Schema.optional(ApiErrorResponse),
    /** The app's own error, or the app data failure, that stopped the operation. */
    failure: Schema.optional(AppFailure),
    /** The app's MCP server refused or failed the tool call, such as with a JSON-RPC error. */
    mcp: Schema.optional(McpFailure),
  },
  message: ({ reason }) => reason,
  recorded: ({ failure, mcp }) =>
    mcp !== undefined
      ? `The tool failed: ${recordedMcp(mcp)}`
      : failure !== undefined
        ? `The tool failed: ${recordedApp(failure)}`
        : "The tool failed after starting",
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
  fields: { app: AppId, deployment: DeploymentId, tool: ToolName },
  presentation: ({ tool }) => ({
    title: "Blocked by the app’s approval policy",
    description: `The approval policy in the app’s code denied this call to “${tool}”.`,
    recovery: {
      action:
        "Check what the app’s approval policy requires for this tool. If the call should be allowed, meet those requirements or, with the user’s agreement, change the policy and deploy it. Otherwise use a different tool.",
      instructions: `The approval policy that “${tool}” declares in the app’s code returned \`denied\` for this call. Do not retry the call unchanged. Tell the user which tool was blocked. Read the policy to see what it checks: its input, the app’s configuration, or the user’s access. If the call should be allowed and a requirement is unmet, meet it (for example, ask the user to enable the setting or grant the access) and call the tool again. Change the app’s source only when the policy itself is wrong and the user agrees: find the tool’s \`approval\` option, or the \`withApprovals\` policy over its router, return \`user-approval\` to ask the user or \`approved\` to run it, then deploy. Otherwise reach the goal with a different tool.`,
    },
  }),
  recorded: () => "The tool's approval policy blocked this call. The tool did not run.",
});
export type ToolBlocked = typeof ToolBlocked.Type;

/** Adapter diagnostic for callers that cannot yet present a pending SDK approval request. */
export const ToolApprovalRequired = ApiError.define({
  tag: "ToolApprovalRequired",
  status: 409,
  fields: { app: AppId, deployment: DeploymentId, tool: ToolName },
  message: ({ tool }) =>
    `“${tool}” needs approval before it runs, and this request cannot present an approval prompt. The tool did not run.`,
  recorded: () =>
    "The tool needs approval before it runs, and this request cannot present an approval prompt. The tool did not run.",
});
export type ToolApprovalRequired = typeof ToolApprovalRequired.Type;

/** The tool's approval policy could not decide. The tool did not run and author failure details remain private. */
export const ToolPolicyFailed = ApiError.define({
  tag: "ToolPolicyFailed",
  status: 500,
  fields: { app: AppId, deployment: DeploymentId, tool: ToolName },
  message: ({ tool }) =>
    `The approval policy of “${tool}” failed before deciding. The tool did not run.`,
  recorded: () => "The tool's approval policy failed before deciding. The tool did not run.",
});
export type ToolPolicyFailed = typeof ToolPolicyFailed.Type;

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
  /** Approvals saved before calls named their kind carry none; resumption reads it from the catalog. */
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
/** Pending call plus the framework's MCP confirmation form. The SDK does not collect the response. */
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
/** Only the consuming caller receives an execution result. Duplicates do not replay it. */
export const ToolResumeResult = Schema.Union([
  ToolCompleted,
  Schema.Struct({ status: Schema.Literal("denied"), requestId: ApprovalRequestId }),
  Schema.Struct({ status: Schema.Literal("cancelled"), requestId: ApprovalRequestId }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    requestId: ApprovalRequestId,
    reason: Schema.Literals(["expired", "context-changed", "execution-failed"]),
  }),
  Schema.Struct({ status: Schema.Literal("already-consumed"), requestId: ApprovalRequestId }),
]);
export type ToolResumeResult = typeof ToolResumeResult.Type;
/** Unknown request or a request outside an optional owner filter. */
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
      error: [
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
      ],
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
