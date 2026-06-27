const SAFE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const TARGET_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;
// Normal scenario slugs are lowercase. Direct KVM runs retain ISO 8601's T
// and Z markers, so permit those two uppercase characters without widening
// the publication namespace to arbitrary mixed-case names.
const RUN_SEGMENT = /^[a-z0-9][a-z0-9TZ-]*$/;
const SYNTHETIC_VISUAL_DATA_CLASSIFICATION = "synthetic-only";
const STATIC_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".svg",
  ".ttf",
  ".webmanifest",
  ".woff",
  ".woff2",
]);

export type PublishedArtifactKind = "static" | "json" | "text" | "binary";

export interface PublishedArtifact {
  readonly kind: PublishedArtifactKind;
  readonly mime: string;
  readonly unredactedVisual?: boolean;
}

export interface PublicationOptions {
  /** Playwright traces contain raw cookies and request bodies. Safe default: omit them. */
  readonly includeRawTrace?: boolean;
  /** Sanitizer-only inventory used to remove artifact references to files denied in this pass. */
  readonly availableArtifacts?: ReadonlySet<string>;
}

export interface SanitizationOptions {
  /** Known CI canaries or credentials that must be removed regardless of context. */
  readonly secrets?: ReadonlyArray<string>;
}

export interface EvidencePublicationMetadata {
  readonly schemaVersion: 1;
  readonly sanitizedAt: number;
  readonly status: "passed" | "failed";
  readonly sanitizer: {
    readonly source: "e2e/scripts/sanitize-evidence.ts";
    readonly policyVersion: 1;
    readonly sourceRevision?: string;
  };
  readonly policy: {
    readonly unknownArtifacts: "removed";
    readonly textAndJson: "redacted";
    readonly binaryVisuals: "unredacted-synthetic-only";
    readonly binarySecretDetection: "byte-canary-only";
  };
  readonly runtime: {
    readonly name: string;
    readonly version: string;
    readonly platform: string;
    readonly arch: string;
  };
  readonly stats: {
    readonly removed: number;
    readonly redacted: number;
    readonly retained: number;
    readonly canariesChecked: number;
  };
  readonly binaryArtifacts: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<string>;
}

/** A result claim only. Publication also requires matching central lane provenance. */
export const syntheticVisualEvidenceDeclaration = {
  dataClassification: SYNTHETIC_VISUAL_DATA_CLASSIFICATION,
} as const;

const extensionOf = (name: string): string => {
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index).toLowerCase();
};

const staticArtifact = (name: string): PublishedArtifact | undefined => {
  const extension = extensionOf(name);
  if (!STATIC_EXTENSIONS.has(extension)) return undefined;
  const mime: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ttf": "font/ttf",
    ".webmanifest": "application/manifest+json",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  };
  const contentType = mime[extension];
  return contentType ? { kind: "static", mime: contentType } : undefined;
};

const runArtifact = (name: string, options: PublicationOptions): PublishedArtifact | undefined => {
  if (
    name === "result.json" ||
    name === "skipped.json" ||
    name === "traces.json" ||
    name === "timeline.json" ||
    name === "evidence.json" ||
    name === "lane-provenance.json" ||
    /^[a-z0-9][a-z0-9-]*(?:-events|-ledger|-metadata|-traces)\.json$/.test(name)
  ) {
    return { kind: "json", mime: "application/json; charset=utf-8" };
  }
  if (name === "test.ts") return { kind: "text", mime: "text/plain; charset=utf-8" };
  if (name === "terminal.cast") {
    return { kind: "text", mime: "application/x-asciicast; charset=utf-8" };
  }
  if (/^[a-z0-9][a-z0-9-]*\.log$/.test(name)) {
    return { kind: "text", mime: "text/plain; charset=utf-8" };
  }
  if (
    name === "failure.png" ||
    name === "renderer-after-settings-click.png" ||
    /^\d{2,4}-[a-z0-9][a-z0-9-]*\.png$/.test(name)
  ) {
    return { kind: "binary", mime: "image/png", unredactedVisual: true };
  }
  if (name === "session.mp4" || name === "film.mp4") {
    return { kind: "binary", mime: "video/mp4", unredactedVisual: true };
  }
  if (name === "session.webm") {
    return { kind: "binary", mime: "video/webm", unredactedVisual: true };
  }
  if (name === "trace.zip" && options.includeRawTrace) {
    return { kind: "binary", mime: "application/zip" };
  }
  return undefined;
};

/**
 * Classify one path relative to e2e/runs. Anything not returned here is
 * private, including CLI homes, MCP configs, telemetry databases, temp dirs,
 * source maps, and raw Playwright traces by default.
 */
export const publishedArtifactFor = (
  relativePath: string,
  options: PublicationOptions = {},
): PublishedArtifact | undefined => {
  const parts = relativePath.split("/").filter(Boolean);
  if (parts.some((part) => !SAFE_SEGMENT.test(part))) return undefined;

  if (parts.length === 1) {
    if (parts[0] === "index.html") return staticArtifact(parts[0]);
    if (parts[0] === "manifest.json" || parts[0] === "publication.json") {
      return { kind: "json", mime: "application/json; charset=utf-8" };
    }
    return undefined;
  }

  if (parts[0] === "assets") {
    if (parts.length !== 2) return undefined;
    return staticArtifact(parts[1] ?? "");
  }

  if (parts[0] === "trace-viewer") {
    if (parts.length > 3 || parts.slice(1).some((part) => !SAFE_SEGMENT.test(part))) {
      return undefined;
    }
    return staticArtifact(parts.at(-1) ?? "");
  }

  if (parts.length !== 3) return undefined;
  const [target, slug, name] = parts;
  if (!target || !slug || !name || !TARGET_SEGMENT.test(target) || !RUN_SEGMENT.test(slug)) {
    return undefined;
  }
  return runArtifact(name, options);
};

/** Directories that may contain allowlisted publication files. */
export const isPublishedDirectory = (relativePath: string): boolean => {
  const parts = relativePath.split("/").filter(Boolean);
  if (parts.length === 0) return true;
  if (parts.some((part) => !SAFE_SEGMENT.test(part))) return false;
  if (parts[0] === "assets") return parts.length === 1;
  if (parts[0] === "trace-viewer") return parts.length <= 2;
  if (parts.length === 1) return TARGET_SEGMENT.test(parts[0] ?? "");
  return (
    parts.length === 2 && TARGET_SEGMENT.test(parts[0] ?? "") && RUN_SEGMENT.test(parts[1] ?? "")
  );
};

const SENSITIVE_KEY =
  /authorization|cookie|password|passphrase|secret|token|api.?key|credential|private.?key|client.?secret|code.?verifier/i;
const SENSITIVE_EXACT_KEY = /^(?:code|email|state)$/i;
const SENSITIVE_QUERY_KEY =
  /^(?:_?token|access_token|refresh_token|id_token|authorization|code|code_verifier|cookie|credential|password|secret|session|state)$/i;

const replaceKnownSecrets = (text: string, secrets: ReadonlyArray<string>): string => {
  let sanitized = text;
  for (const secret of secrets) {
    if (secret.length >= 4) sanitized = sanitized.split(secret).join("[REDACTED]");
  }
  return sanitized;
};

/** Redact credentials and local usernames from a string while preserving its shape. */
export const sanitizePublishedText = (text: string, options: SanitizationOptions = {}): string => {
  const secrets = options.secrets ?? [];
  return replaceKnownSecrets(text, secrets)
    .replace(
      /([?&](?:_?token|access_token|refresh_token|id_token|authorization|code|code_verifier|cookie|credential|password|secret|session|state)=)[^&#\s"'<>]*/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(\b(?:authorization|proxy-authorization|cookie|set-cookie)\b\s*[:=]\s*)[^\r\n]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(\b(?:_?token|access_token|refresh_token|id_token|authorization|cookie|password|passphrase|secret|api[-_]?key|credential|private[-_]?key|client[-_]?secret|code[-_]?verifier)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
    .replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, "$1[REDACTED]@")
    .replace(/\/(home|Users)\/[^/\s"']+/g, "/$1/[USER]")
    .replace(/\b[A-Za-z]:\\Users\\[^\\\s"']+/gi, "[DRIVE]:\\Users\\[USER]");
};

export const sanitizePublishedUrl = (input: string, options: SanitizationOptions = {}): string => {
  const knownSecretsRemoved = replaceKnownSecrets(input, options.secrets ?? []);
  try {
    const url = new URL(knownSecretsRemoved);
    if (url.username || url.password) {
      url.username = "[REDACTED]";
      url.password = "";
    }
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, "[REDACTED]");
    }
    if (url.hash.includes("=")) {
      const fragment = new URLSearchParams(url.hash.slice(1));
      for (const key of [...fragment.keys()]) {
        if (SENSITIVE_QUERY_KEY.test(key)) fragment.set(key, "[REDACTED]");
      }
      url.hash = fragment.toString();
    }
    return sanitizePublishedText(url.toString(), options);
  } catch {
    return sanitizePublishedText(knownSecretsRemoved, options);
  }
};

const sensitiveKey = (key: string): boolean =>
  SENSITIVE_KEY.test(key) || SENSITIVE_EXACT_KEY.test(key);

/** Reusable recursive redactor for OTLP exports and other JSON evidence. */
export const sanitizePublishedValue = (
  value: unknown,
  options: SanitizationOptions = {},
): unknown => {
  if (typeof value === "string") return sanitizePublishedText(value, options);
  if (Array.isArray(value)) return value.map((entry) => sanitizePublishedValue(entry, options));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      sensitiveKey(key) ? "[REDACTED]" : sanitizePublishedValue(entry, options),
    ]),
  );
};

export const publishedArtifactNames = (
  names: ReadonlyArray<string>,
  options: PublicationOptions = {},
): string[] =>
  names.filter(
    (name) =>
      runArtifact(name, options) !== undefined &&
      name !== "result.json" &&
      (options.availableArtifacts === undefined || options.availableArtifacts.has(name)),
  );

/** Parse, redact, and normalize one JSON publication artifact. */
export const sanitizePublishedJson = (
  relativePath: string,
  contents: string,
  publication: PublicationOptions = {},
  sanitization: SanitizationOptions = {},
): string => {
  const parsed: unknown = JSON.parse(contents);
  const sanitized = sanitizePublishedValue(parsed, sanitization);
  if (
    relativePath.endsWith("/result.json") &&
    typeof sanitized === "object" &&
    sanitized !== null &&
    "artifacts" in sanitized &&
    Array.isArray(sanitized.artifacts)
  ) {
    const artifacts = sanitized.artifacts.filter(
      (entry): entry is string => typeof entry === "string",
    );
    return JSON.stringify(
      { ...sanitized, artifacts: publishedArtifactNames(artifacts, publication) },
      null,
      1,
    );
  }
  return JSON.stringify(sanitized, null, 1);
};

/** Asciinema is JSON Lines, so redact values without corrupting its framing. */
export const sanitizePublishedCast = (
  contents: string,
  options: SanitizationOptions = {},
): string =>
  contents
    .split("\n")
    .map((line) => {
      if (line === "") return line;
      try {
        return JSON.stringify(sanitizePublishedValue(JSON.parse(line), options));
      } catch {
        return sanitizePublishedText(line, options);
      }
    })
    .join("\n");
