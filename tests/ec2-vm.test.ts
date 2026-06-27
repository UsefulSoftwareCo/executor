import { describe, expect, it } from "@effect/vitest";
import { Data, Effect } from "effect";

import { createEc2FinalizerStack, ec2ResourceNames, ec2RunInstancesArgs } from "../e2e/src/vm/ec2";
import {
  EC2_CREATED_AT_TAG,
  EC2_EXPIRES_AT_TAG,
  EC2_MANAGED_TAG,
  EC2_REPOSITORY_TAG,
  EC2_RUN_ATTEMPT_TAG,
  EC2_RUN_ID_TAG,
  EC2_RUN_SCOPE_TAG,
  cleanupCurrentEc2Resources,
  ec2ResourceTags,
  selectCurrentEc2Resources,
  selectExpiredEc2Resources,
  type TaggedEc2Resource,
} from "../e2e/src/vm/ec2-lifecycle";
import { requireEc2CleanupOwner, resolveVmRunMetadata } from "../e2e/src/vm/run-scope";

class SimulatedCleanupFailure extends Data.TaggedError("SimulatedCleanupFailure")<{
  readonly resource: string;
}> {}

describe("EC2 VM resources", () => {
  it("runs cleanup in dependency-safe reverse order exactly once", async () => {
    const order: string[] = [];
    const finalizers = createEc2FinalizerStack();
    finalizers.add("local key directory", () => {
      order.push("local");
    });
    finalizers.add("EC2 key pair", () => {
      order.push("key");
    });
    finalizers.add("EC2 security group", () => {
      order.push("security-group");
    });
    finalizers.add("EC2 instance", () => {
      order.push("instance");
    });

    await finalizers.run();
    await finalizers.run();

    expect(order).toEqual(["instance", "security-group", "key", "local"]);
  });

  it("continues cleanup after an individual finalizer fails", async () => {
    const order: string[] = [];
    const finalizers = createEc2FinalizerStack();
    finalizers.add("local key directory", () => {
      order.push("local");
    });
    finalizers.add("EC2 key pair", () => {
      order.push("key");
      return Effect.runPromise(
        Effect.fail(new SimulatedCleanupFailure({ resource: "EC2 key pair" })),
      );
    });
    finalizers.add("EC2 instance", () => {
      order.push("instance");
    });

    await expect(finalizers.run()).rejects.toThrow("EC2 cleanup was incomplete");
    expect(order).toEqual(["instance", "key", "local"]);
  });

  it("hardens instance metadata and encrypts the disposable root volume", () => {
    const metadata = resolveVmRunMetadata(
      {
        E2E_VM_RUN_SCOPE: "run-123-attempt-2-windows",
        GITHUB_REPOSITORY: "example/executor",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_RUN_ID: "123",
      },
      Date.parse("2026-06-26T00:00:00.000Z"),
    );
    const args = ec2RunInstancesArgs({
      ami: "ami-test",
      instanceType: "t3.medium",
      keyPairName: "executor-e2e-key-run",
      rootDeviceName: "/dev/sda1",
      securityGroupId: "sg-test",
      subnetId: "subnet-test",
      tags: ec2ResourceTags(metadata, "executor-e2e-run"),
      userDataFile: "/tmp/user-data.txt",
    });

    expect(args).toContain("--key-name");
    expect(args).toContain("executor-e2e-key-run");
    expect(args).toContain(
      "HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=1,InstanceMetadataTags=disabled",
    );
    expect(args).toContain(
      '[{"DeviceName":"/dev/sda1","Ebs":{"DeleteOnTermination":true,"Encrypted":true,"VolumeType":"gp3"}}]',
    );
    const tagSpecification = args.at(args.indexOf("--tag-specifications") + 1) ?? "";
    expect(tagSpecification).toContain('"Key":"executor-e2e:run-scope"');
    expect(tagSpecification).toContain('"Value":"run-123-attempt-2-windows"');
    expect(tagSpecification).toContain('"Key":"executor-e2e:created-at"');
    expect(tagSpecification).toContain('"Key":"executor-e2e:expires-at"');
    expect(metadata.expiresAt).toBe("2026-06-26T06:00:00.000Z");
  });

  it("derives distinct per-run key and security-group names", () => {
    expect(ec2ResourceNames("run-one")).toEqual({
      instance: "executor-e2e-run-one",
      keyPair: "executor-e2e-key-run-one",
      securityGroup: "executor-e2e-sg-run-one",
    });
    expect(ec2ResourceNames("run-two")).toEqual({
      instance: "executor-e2e-run-two",
      keyPair: "executor-e2e-key-run-two",
      securityGroup: "executor-e2e-sg-run-two",
    });
  });

  it("selects only the exact current run and matrix scope", () => {
    const environment = {
      E2E_VM_RUN_SCOPE: "windows-leg",
      GITHUB_REPOSITORY: "example/executor",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_RUN_ID: "123",
    };
    const owner = requireEc2CleanupOwner(environment);
    const owned = taggedResource("instance", "i-owned", {
      [EC2_MANAGED_TAG]: "true",
      [EC2_REPOSITORY_TAG]: "example/executor",
      [EC2_RUN_ATTEMPT_TAG]: "2",
      [EC2_RUN_ID_TAG]: "123",
      [EC2_RUN_SCOPE_TAG]: "windows-leg",
    });
    const sibling = taggedResource("instance", "i-sibling", {
      ...owned.tags,
      [EC2_RUN_SCOPE_TAG]: "linux-leg",
    });
    const earlierAttempt = taggedResource("security-group", "sg-old", {
      ...owned.tags,
      [EC2_RUN_ATTEMPT_TAG]: "1",
    });

    expect(selectCurrentEc2Resources([owned, sibling, earlierAttempt], owner)).toEqual([owned]);
  });

  it("sweeps only expired, old-enough resources carrying exact repository ownership", () => {
    const now = Date.parse("2026-06-26T12:00:00.000Z");
    const tags = {
      [EC2_MANAGED_TAG]: "true",
      [EC2_REPOSITORY_TAG]: "example/executor",
      [EC2_CREATED_AT_TAG]: "2026-06-26T00:00:00.000Z",
      [EC2_EXPIRES_AT_TAG]: "2026-06-26T06:00:00.000Z",
    };
    const expired = taggedResource("instance", "i-expired", tags);
    const young = taggedResource("instance", "i-young", {
      ...tags,
      [EC2_CREATED_AT_TAG]: "2026-06-26T11:00:00.000Z",
    });
    const unexpired = taggedResource("key-pair", "key-future", {
      ...tags,
      [EC2_EXPIRES_AT_TAG]: "2026-06-26T18:00:00.000Z",
    });
    const anotherRepository = taggedResource("security-group", "sg-other", {
      ...tags,
      [EC2_REPOSITORY_TAG]: "someone-else/executor",
    });
    const unmanaged = taggedResource("instance", "i-unmanaged", {
      ...tags,
      [EC2_MANAGED_TAG]: "false",
    });
    const invalidDeadline = taggedResource("instance", "i-invalid", {
      ...tags,
      [EC2_EXPIRES_AT_TAG]: "not-a-date",
    });

    expect(
      selectExpiredEc2Resources(
        [expired, young, unexpired, anotherRepository, unmanaged, invalidDeadline],
        "example/executor",
        6,
        now,
      ),
    ).toEqual([expired]);
  });

  it("runs exact-scope EC2 cleanup in dependency order", async () => {
    const environment = {
      E2E_VM_RUN_SCOPE: "windows-leg",
      GITHUB_REPOSITORY: "example/executor",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_RUN_ID: "123",
    };
    const tags = [
      { Key: EC2_MANAGED_TAG, Value: "true" },
      { Key: EC2_REPOSITORY_TAG, Value: "example/executor" },
      { Key: EC2_RUN_ATTEMPT_TAG, Value: "2" },
      { Key: EC2_RUN_ID_TAG, Value: "123" },
      { Key: EC2_RUN_SCOPE_TAG, Value: "windows-leg" },
    ];
    const calls: string[][] = [];
    const runner = async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[1] === "describe-instances") {
        return JSON.stringify({
          Reservations: [{ Instances: [{ InstanceId: "i-owned", Tags: tags }] }],
        });
      }
      if (args[1] === "describe-key-pairs") {
        return JSON.stringify({ KeyPairs: [{ KeyPairId: "key-owned", Tags: tags }] });
      }
      if (args[1] === "describe-security-groups") {
        return JSON.stringify({ SecurityGroups: [{ GroupId: "sg-owned", Tags: tags }] });
      }
      return "{}";
    };

    const result = await cleanupCurrentEc2Resources({ environment, runner, wait: async () => {} });

    expect(result).toEqual({ deleted: 3, scope: "windows-leg" });
    expect(calls.map((args) => args.slice(0, 2))).toEqual([
      ["ec2", "describe-instances"],
      ["ec2", "describe-key-pairs"],
      ["ec2", "describe-security-groups"],
      ["ec2", "terminate-instances"],
      ["ec2", "wait"],
      ["ec2", "delete-security-group"],
      ["ec2", "delete-key-pair"],
    ]);
  });

  it("fails closed when EC2 cleanup ownership is incomplete", async () => {
    await expect(
      cleanupCurrentEc2Resources({
        environment: { E2E_VM_RUN_SCOPE: "windows-leg" },
        runner: async () => "{}",
      }),
    ).rejects.toThrow("EC2 cleanup requires");
  });
});

const taggedResource = (
  kind: TaggedEc2Resource["kind"],
  id: string,
  tags: Readonly<Record<string, string>>,
) => ({
  id,
  kind,
  tags,
});
