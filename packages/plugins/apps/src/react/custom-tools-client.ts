import { Data, Effect, Schema } from "effect";

export const CUSTOM_TOOLS_PLUGIN_KEY = "apps";
export const CUSTOM_TOOLS_LABEL = "Custom tools";

export type AppSourceKind = "git" | "local-directory";

export interface SyncDiagnostic {
  readonly stage: "source" | "discover" | "bundle" | "collect" | "project";
  readonly message: string;
  readonly diagnostics?: readonly { readonly path: string; readonly message: string }[];
}

export type SourceStatus =
  | { readonly type: "pending" }
  | {
      readonly type: "published" | "up-to-date";
      readonly at: number;
      readonly tools: readonly string[];
    }
  | { readonly type: "failed"; readonly at: number; readonly errors: readonly SyncDiagnostic[] };

export type AppSourceRecord =
  | {
      readonly slug: string;
      readonly app: string;
      readonly kind: "git";
      readonly config: {
        readonly kind: "git";
        readonly url: string;
        readonly ref?: string;
        readonly tokenProvider?: string;
        readonly tokenItemId?: string;
      };
      readonly sourceRef?: string;
      readonly description?: string;
      readonly status: SourceStatus;
      readonly updatedAt: number;
    }
  | {
      readonly slug: string;
      readonly app: string;
      readonly kind: "local-directory";
      readonly config: { readonly kind: "local-directory"; readonly path: string };
      readonly sourceRef?: string;
      readonly description?: string;
      readonly status: SourceStatus;
      readonly updatedAt: number;
    };

export interface SourcesListResponse {
  readonly sources: readonly AppSourceRecord[];
}

export interface SourceDetailResponse {
  readonly source: AppSourceRecord | null;
}

export type CreateSourceRequest =
  | {
      readonly kind: "git";
      readonly slug?: string;
      readonly app?: string;
      readonly url: string;
      readonly ref?: string;
      readonly token?: string;
    }
  | {
      readonly kind: "local-directory";
      readonly slug?: string;
      readonly app?: string;
      readonly path: string;
    };

export interface CreateSourceResponse {
  readonly source: AppSourceRecord;
}

export type SyncSourceResult =
  | {
      readonly status: "published" | "up-to-date";
      readonly sourceRef: string;
      readonly tools: readonly string[];
      readonly errors?: undefined;
    }
  | {
      readonly status: "failed";
      readonly sourceRef?: string;
      readonly tools: readonly string[];
      readonly errors: readonly SyncDiagnostic[];
    };

export type CustomToolsFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class CustomToolsClientError extends Data.TaggedError("CustomToolsClientError")<{
  readonly message: string;
}> {}

export const slugifyCustomToolsAppName = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

export const validateCustomToolsAppSlug = (value: string): string | null => {
  if (!value.trim()) return "Enter a source name.";
  if (value !== slugifyCustomToolsAppName(value)) {
    return "Use lowercase letters, numbers, and hyphens.";
  }
  return null;
};

export const parseGitSourceUrl = (
  raw: string,
):
  | { readonly ok: true; readonly url: string; readonly name: string }
  | { readonly ok: false; readonly message: string } => {
  const value = raw.trim();
  if (!value) return { ok: false, message: "Enter a Git repository URL." };
  if (!URL.canParse(value)) return { ok: false, message: "Enter an https Git repository URL." };
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, message: "Git repository URLs must use http or https." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, message: "Do not include credentials in the URL. Use the token field." };
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const last = segments.at(-1)?.replace(/\.git$/, "") ?? "";
  if (!last) return { ok: false, message: "Enter a repository URL with a path." };
  parsed.hash = "";
  return { ok: true, url: parsed.toString(), name: last };
};

export const suggestCustomToolsAppName = (urlOrPath: string): string => {
  const parsed = parseGitSourceUrl(urlOrPath);
  if (parsed.ok) return parsed.name;
  const pathParts = urlOrPath.split("/").filter(Boolean);
  return pathParts.at(-1) ?? "";
};

export const validateGitSourceUrl = (url: string): string | null => {
  const parsed = parseGitSourceUrl(url);
  return parsed.ok ? null : parsed.message;
};

const decodeJsonText = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const encodeJsonText = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const responseErrorMessage = (body: unknown, fallback: string): string =>
  isRecord(body) && typeof body.message === "string"
    ? body.message
    : isRecord(body) && typeof body.error === "string"
      ? body.error
      : fallback;

const parseJsonResponseEffect = <A>(
  response: Response,
  fallback: string,
): Effect.Effect<A, CustomToolsClientError> =>
  Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => new CustomToolsClientError({ message: fallback }),
    });
    const body =
      text.length > 0
        ? yield* decodeJsonText(text).pipe(
            Effect.mapError(() => new CustomToolsClientError({ message: fallback })),
          )
        : null;
    if (!response.ok) {
      return yield* new CustomToolsClientError({
        message: responseErrorMessage(body, fallback),
      });
    }
    return body as A;
  });

export const listCustomToolSourcesEffect = (
  fetchImpl: CustomToolsFetch = fetch,
): Effect.Effect<SourcesListResponse, CustomToolsClientError> =>
  Effect.tryPromise({
    try: () => fetchImpl("/api/apps/sources", { credentials: "same-origin" }),
    catch: () => new CustomToolsClientError({ message: "Failed to load custom tools sources." }),
  }).pipe(
    Effect.flatMap((response) =>
      parseJsonResponseEffect<SourcesListResponse>(
        response,
        "Failed to load custom tools sources.",
      ),
    ),
  );

export const listCustomToolSources = (
  fetchImpl: CustomToolsFetch = fetch,
): Promise<SourcesListResponse> => Effect.runPromise(listCustomToolSourcesEffect(fetchImpl));

export const getCustomToolSourceEffect = (
  slug: string,
  fetchImpl: CustomToolsFetch = fetch,
): Effect.Effect<SourceDetailResponse, CustomToolsClientError> =>
  Effect.tryPromise({
    try: () =>
      fetchImpl(`/api/apps/sources/${encodeURIComponent(slug)}`, {
        credentials: "same-origin",
      }),
    catch: () => new CustomToolsClientError({ message: "Failed to load custom tools source." }),
  }).pipe(
    Effect.flatMap((response) =>
      parseJsonResponseEffect<SourceDetailResponse>(
        response,
        "Failed to load custom tools source.",
      ),
    ),
  );

export const createCustomToolSourceEffect = (
  input: CreateSourceRequest,
  fetchImpl: CustomToolsFetch = fetch,
): Effect.Effect<CreateSourceResponse, CustomToolsClientError> =>
  Effect.tryPromise({
    try: () =>
      fetchImpl("/api/apps/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: encodeJsonText(input),
      }),
    catch: () => new CustomToolsClientError({ message: "Failed to create custom tools source." }),
  }).pipe(
    Effect.flatMap((response) =>
      parseJsonResponseEffect<CreateSourceResponse>(
        response,
        "Failed to create custom tools source.",
      ),
    ),
  );

export const syncCustomToolSourceEffect = (
  slug: string,
  fetchImpl: CustomToolsFetch = fetch,
): Effect.Effect<SyncSourceResult, CustomToolsClientError> =>
  Effect.tryPromise({
    try: () =>
      fetchImpl(`/api/apps/sources/${encodeURIComponent(slug)}/sync`, {
        method: "POST",
        credentials: "same-origin",
      }),
    catch: () => new CustomToolsClientError({ message: "Failed to sync custom tools source." }),
  }).pipe(
    Effect.flatMap((response) =>
      parseJsonResponseEffect<SyncSourceResult>(response, "Failed to sync custom tools source."),
    ),
  );

export const removeCustomToolSourceEffect = (
  slug: string,
  fetchImpl: CustomToolsFetch = fetch,
): Effect.Effect<{ readonly removed: boolean }, CustomToolsClientError> =>
  Effect.tryPromise({
    try: () =>
      fetchImpl(`/api/apps/sources/${encodeURIComponent(slug)}`, {
        method: "DELETE",
        credentials: "same-origin",
      }),
    catch: () => new CustomToolsClientError({ message: "Failed to remove custom tools source." }),
  }).pipe(
    Effect.flatMap((response) =>
      parseJsonResponseEffect<{ readonly removed: boolean }>(
        response,
        "Failed to remove custom tools source.",
      ),
    ),
  );

export const syncStatusLabel = (result: SyncSourceResult): string => {
  if (result.status === "published") return `Published ${result.tools.length} tools.`;
  if (result.status === "up-to-date") return "Already up to date.";
  return "Sync failed.";
};

export const formatDiagnostics = (
  errors: readonly SyncDiagnostic[] | undefined,
): readonly string[] =>
  (errors ?? []).flatMap((entry) => {
    const head = `${entry.stage}: ${entry.message}`;
    const details = entry.diagnostics?.map((d) => `${d.path}: ${d.message}`) ?? [];
    return details.length > 0 ? [head, ...details] : [head];
  });

export const formatSyncErrors = (result: SyncSourceResult): readonly string[] =>
  result.status === "failed" ? formatDiagnostics(result.errors) : [];

export const toolDiff = (
  before: readonly string[],
  after: readonly string[],
): { readonly added: readonly string[]; readonly removed: readonly string[] } => {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    added: after.filter((tool) => !beforeSet.has(tool)),
    removed: before.filter((tool) => !afterSet.has(tool)),
  };
};
