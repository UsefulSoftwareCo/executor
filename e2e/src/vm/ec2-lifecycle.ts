import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Schema } from "effect";

import { requireEc2CleanupOwner, type VmRunMetadata } from "./run-scope";
import { sleep } from "./types";

const execFileP = promisify(execFile);

export const EC2_MANAGED_TAG = "executor-e2e:managed";
export const EC2_REPOSITORY_TAG = "executor-e2e:repository";
export const EC2_RUN_ID_TAG = "executor-e2e:run-id";
export const EC2_RUN_ATTEMPT_TAG = "executor-e2e:run-attempt";
export const EC2_RUN_SCOPE_TAG = "executor-e2e:run-scope";
export const EC2_CREATED_AT_TAG = "executor-e2e:created-at";
export const EC2_EXPIRES_AT_TAG = "executor-e2e:expires-at";

const AwsTag = Schema.Struct({
  Key: Schema.String,
  Value: Schema.String,
});
const AwsInstance = Schema.Struct({
  InstanceId: Schema.String,
  Tags: Schema.Array(AwsTag),
});
const AwsInstances = Schema.Struct({
  Reservations: Schema.Array(Schema.Struct({ Instances: Schema.Array(AwsInstance) })),
});
const AwsKeyPair = Schema.Struct({
  KeyPairId: Schema.String,
  Tags: Schema.Array(AwsTag),
});
const AwsKeyPairs = Schema.Struct({
  KeyPairs: Schema.Array(AwsKeyPair),
});
const AwsSecurityGroup = Schema.Struct({
  GroupId: Schema.String,
  Tags: Schema.Array(AwsTag),
});
const AwsSecurityGroups = Schema.Struct({
  SecurityGroups: Schema.Array(AwsSecurityGroup),
});
const decodeAwsInstances = Schema.decodeUnknownSync(Schema.fromJsonString(AwsInstances));
const decodeAwsKeyPairs = Schema.decodeUnknownSync(Schema.fromJsonString(AwsKeyPairs));
const decodeAwsSecurityGroups = Schema.decodeUnknownSync(Schema.fromJsonString(AwsSecurityGroups));

export type Ec2ResourceTag = typeof AwsTag.Type;
export type Ec2ResourceKind = "instance" | "key-pair" | "security-group";

export interface TaggedEc2Resource {
  readonly id: string;
  readonly kind: Ec2ResourceKind;
  readonly tags: Readonly<Record<string, string>>;
}

export type Ec2AwsRunner = (args: readonly string[]) => Promise<string>;

const region = (environment: Readonly<Record<string, string | undefined>>) =>
  environment.E2E_EC2_REGION?.trim() || "us-west-2";

const defaultAwsRunner =
  (environment: Readonly<Record<string, string | undefined>>): Ec2AwsRunner =>
  async (args) => {
    const executable = environment.E2E_AWS_BIN?.trim() || "aws";
    const { stdout } = await execFileP(
      executable,
      ["--region", region(environment), "--output", "json", ...args],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout;
  };

export const ec2ResourceTags = (
  metadata: VmRunMetadata,
  name: string,
): readonly Ec2ResourceTag[] => [
  { Key: "Name", Value: name },
  { Key: "purpose", Value: "e2e" },
  { Key: EC2_MANAGED_TAG, Value: "true" },
  { Key: EC2_REPOSITORY_TAG, Value: metadata.repository },
  { Key: EC2_RUN_ID_TAG, Value: metadata.runId },
  { Key: EC2_RUN_ATTEMPT_TAG, Value: metadata.runAttempt },
  { Key: EC2_RUN_SCOPE_TAG, Value: metadata.scope },
  { Key: EC2_CREATED_AT_TAG, Value: metadata.createdAt },
  { Key: EC2_EXPIRES_AT_TAG, Value: metadata.expiresAt },
];

export const ec2TagSpecifications = (
  resourceType: Ec2ResourceKind,
  tags: readonly Ec2ResourceTag[],
) => JSON.stringify([{ ResourceType: resourceType, Tags: tags }]);

const tagsByKey = (tags: readonly Ec2ResourceTag[]) =>
  Object.fromEntries(tags.map((tag) => [tag.Key, tag.Value]));

export const decodeTaggedEc2Instances = (json: string) =>
  decodeAwsInstances(json).Reservations.flatMap((reservation) =>
    reservation.Instances.map((instance) => ({
      id: instance.InstanceId,
      kind: "instance" as const,
      tags: tagsByKey(instance.Tags),
    })),
  );

export const decodeTaggedEc2KeyPairs = (json: string) =>
  decodeAwsKeyPairs(json).KeyPairs.map((keyPair) => ({
    id: keyPair.KeyPairId,
    kind: "key-pair" as const,
    tags: tagsByKey(keyPair.Tags),
  }));

export const decodeTaggedEc2SecurityGroups = (json: string) =>
  decodeAwsSecurityGroups(json).SecurityGroups.map((securityGroup) => ({
    id: securityGroup.GroupId,
    kind: "security-group" as const,
    tags: tagsByKey(securityGroup.Tags),
  }));

const hasManagedRepository = (resource: TaggedEc2Resource, repository: string) =>
  resource.tags[EC2_MANAGED_TAG] === "true" && resource.tags[EC2_REPOSITORY_TAG] === repository;

export const selectCurrentEc2Resources = (
  resources: readonly TaggedEc2Resource[],
  owner: ReturnType<typeof requireEc2CleanupOwner>,
) =>
  resources.filter(
    (resource) =>
      hasManagedRepository(resource, owner.repository) &&
      resource.tags[EC2_RUN_ID_TAG] === owner.runId &&
      resource.tags[EC2_RUN_ATTEMPT_TAG] === owner.runAttempt &&
      resource.tags[EC2_RUN_SCOPE_TAG] === owner.scope,
  );

export const selectExpiredEc2Resources = (
  resources: readonly TaggedEc2Resource[],
  repository: string,
  minimumAgeHours: number,
  now = Date.now(),
) => {
  if (!Number.isFinite(minimumAgeHours) || minimumAgeHours <= 0) {
    throw new Error("minimumAgeHours must be greater than zero");
  }
  const minimumAgeMs = minimumAgeHours * 60 * 60 * 1_000;
  return resources.filter((resource) => {
    if (!hasManagedRepository(resource, repository)) return false;
    const createdAt = Date.parse(resource.tags[EC2_CREATED_AT_TAG] ?? "");
    const expiresAt = Date.parse(resource.tags[EC2_EXPIRES_AT_TAG] ?? "");
    if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) return false;
    if (createdAt > expiresAt || createdAt > now) return false;
    return expiresAt <= now && now - createdAt >= minimumAgeMs;
  });
};

const listManagedResources = async (
  repository: string,
  runner: Ec2AwsRunner,
  exactTags: ReadonlyArray<{ readonly key: string; readonly value: string }> = [],
) => {
  const filters = [
    { Name: `tag:${EC2_MANAGED_TAG}`, Values: ["true"] },
    { Name: `tag:${EC2_REPOSITORY_TAG}`, Values: [repository] },
    ...exactTags.map(({ key, value }) => ({ Name: `tag:${key}`, Values: [value] })),
  ];
  const filterJson = JSON.stringify(filters);
  const [instances, keyPairs, securityGroups] = await Promise.all([
    runner(["ec2", "describe-instances", "--filters", filterJson]),
    runner(["ec2", "describe-key-pairs", "--filters", filterJson]),
    runner(["ec2", "describe-security-groups", "--filters", filterJson]),
  ]);
  return [
    ...decodeTaggedEc2Instances(instances),
    ...decodeTaggedEc2KeyPairs(keyPairs),
    ...decodeTaggedEc2SecurityGroups(securityGroups),
  ];
};

const deleteSecurityGroup = async (
  id: string,
  runner: Ec2AwsRunner,
  wait: (ms: number) => Promise<void>,
) => {
  let lastFailure: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await runner(["ec2", "delete-security-group", "--group-id", id]);
      return;
    } catch (error) {
      lastFailure = error;
      if (attempt < 5) await wait(2_000);
    }
  }
  throw lastFailure;
};

const deleteResources = async (
  resources: readonly TaggedEc2Resource[],
  runner: Ec2AwsRunner,
  wait: (ms: number) => Promise<void>,
) => {
  const failures: unknown[] = [];
  const instanceIds = resources
    .filter((resource) => resource.kind === "instance")
    .map((resource) => resource.id);
  if (instanceIds.length > 0) {
    try {
      await runner(["ec2", "terminate-instances", "--instance-ids", ...instanceIds]);
      await runner(["ec2", "wait", "instance-terminated", "--instance-ids", ...instanceIds]);
    } catch (error) {
      failures.push(new AggregateError([error], "EC2 instance cleanup failed"));
    }
  }

  for (const resource of resources.filter(({ kind }) => kind === "security-group")) {
    try {
      await deleteSecurityGroup(resource.id, runner, wait);
    } catch (error) {
      failures.push(
        new AggregateError([error], `EC2 security-group cleanup failed: ${resource.id}`),
      );
    }
  }

  for (const resource of resources.filter(({ kind }) => kind === "key-pair")) {
    try {
      await runner(["ec2", "delete-key-pair", "--key-pair-id", resource.id]);
    } catch (error) {
      failures.push(new AggregateError([error], `EC2 key-pair cleanup failed: ${resource.id}`));
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "EC2 cleanup was incomplete");
  }
};

export const cleanupCurrentEc2Resources = async (options?: {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly runner?: Ec2AwsRunner;
  readonly wait?: (ms: number) => Promise<void>;
}) => {
  const environment = options?.environment ?? process.env;
  const owner = requireEc2CleanupOwner(environment);
  const runner = options?.runner ?? defaultAwsRunner(environment);
  const resources = await listManagedResources(owner.repository, runner, [
    { key: EC2_RUN_ID_TAG, value: owner.runId },
    { key: EC2_RUN_ATTEMPT_TAG, value: owner.runAttempt },
    { key: EC2_RUN_SCOPE_TAG, value: owner.scope },
  ]);
  const selected = selectCurrentEc2Resources(resources, owner);
  await deleteResources(selected, runner, options?.wait ?? sleep);
  return { deleted: selected.length, scope: owner.scope };
};

export const sweepExpiredEc2Resources = async (options: {
  readonly minimumAgeHours: number;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly now?: number;
  readonly runner?: Ec2AwsRunner;
  readonly wait?: (ms: number) => Promise<void>;
}) => {
  const environment = options.environment ?? process.env;
  const owner = requireEc2CleanupOwner(environment);
  const runner = options.runner ?? defaultAwsRunner(environment);
  const resources = await listManagedResources(owner.repository, runner);
  const selected = selectExpiredEc2Resources(
    resources,
    owner.repository,
    options.minimumAgeHours,
    options.now,
  );
  await deleteResources(selected, runner, options.wait ?? sleep);
  return { deleted: selected.length, repository: owner.repository };
};
