import { createHash, randomUUID } from "node:crypto";

const DEFAULT_TTL_HOURS = 6;
const MAX_TTL_HOURS = 7 * 24;

type Environment = Readonly<Record<string, string | undefined>>;

const nonempty = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const ttlHours = (environment: Environment) => {
  const raw = nonempty(environment.E2E_VM_TTL_HOURS);
  if (!raw) return DEFAULT_TTL_HOURS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TTL_HOURS) {
    throw new Error(`E2E_VM_TTL_HOURS must be greater than 0 and at most ${MAX_TTL_HOURS}`);
  }
  return value;
};

export const vmRunScopeSlug = (scope: string) => {
  const readable = scope
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 36);
  const digest = createHash("sha256").update(scope).digest("hex").slice(0, 12);
  return `${readable || "scope"}-${digest}`;
};

export const resolveVmRunMetadata = (environment: Environment = process.env, now = Date.now()) => {
  const explicitScope = nonempty(environment.E2E_VM_RUN_SCOPE);
  if (environment.GITHUB_ACTIONS === "true" && !explicitScope) {
    throw new Error("E2E_VM_RUN_SCOPE is required for VM provisioning in GitHub Actions");
  }

  const scope =
    explicitScope ?? `local-${process.pid}-${now}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const createdAt = new Date(now);
  const expiresAt = new Date(now + ttlHours(environment) * 60 * 60 * 1_000);
  return {
    scope,
    scopeSlug: vmRunScopeSlug(scope),
    repository: nonempty(environment.GITHUB_REPOSITORY) ?? "local",
    runId: nonempty(environment.GITHUB_RUN_ID) ?? "local",
    runAttempt: nonempty(environment.GITHUB_RUN_ATTEMPT) ?? "local",
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
};

export type VmRunMetadata = ReturnType<typeof resolveVmRunMetadata>;

export const requireVmCleanupScope = (environment: Environment = process.env) => {
  const scope = nonempty(environment.E2E_VM_RUN_SCOPE);
  if (!scope) throw new Error("E2E_VM_RUN_SCOPE is required for VM cleanup");
  return { scope, scopeSlug: vmRunScopeSlug(scope) };
};

export const requireEc2CleanupOwner = (environment: Environment = process.env) => {
  const { scope, scopeSlug } = requireVmCleanupScope(environment);
  const repository = nonempty(environment.GITHUB_REPOSITORY);
  const runId = nonempty(environment.GITHUB_RUN_ID);
  const runAttempt = nonempty(environment.GITHUB_RUN_ATTEMPT);
  if (!repository || !runId || !runAttempt) {
    throw new Error(
      "EC2 cleanup requires GITHUB_REPOSITORY, GITHUB_RUN_ID, and GITHUB_RUN_ATTEMPT",
    );
  }
  return { repository, runAttempt, runId, scope, scopeSlug };
};
