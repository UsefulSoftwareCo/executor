// ec2 provider: ephemeral guests on AWS EC2 for the cross-OS supervised-daemon
// e2e where tart can't run (Windows; optionally Linux). Mirrors tart.ts — launch
// a fresh instance, drive over SSH (key-based; PowerShell on Windows), REBOOT for
// real, tear down.
//
// Credentials are NEVER embedded here: the `aws` CLI uses the ambient sign-in
// (`aws configure` / env). Every instance is tagged `executor-e2e` and always
// terminated on discard; the security group is scoped to this host's egress IP.
//
// Reboot is gated on a real boot-time change (Windows `LastBootUpTime`), not mere
// SSH reachability — an orderly shutdown keeps the daemon serving for several
// seconds, so "SSH answered" alone can false-pass a reboot that never happened.

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  type SshResult,
  sleep,
  type VmArch,
  type VmHandle,
  type VmOs,
  type VmProvider,
} from "./types";
import { ec2ResourceTags, ec2TagSpecifications, type Ec2ResourceTag } from "./ec2-lifecycle";
import { resolveVmRunMetadata } from "./run-scope";

const execFileP = promisify(execFile);

const AWS = process.env.E2E_AWS_BIN ?? "aws";
const REGION = process.env.E2E_EC2_REGION ?? "us-west-2";
const INSTANCE_TYPE = process.env.E2E_EC2_INSTANCE_TYPE ?? "t3.medium";
const TAG = "executor-e2e";

type AsyncFinalizer = () => Promise<void> | void;

export const createEc2FinalizerStack = () => {
  const finalizers: Array<{ readonly label: string; readonly run: AsyncFinalizer }> = [];
  let finished = false;

  const add = (label: string, run: AsyncFinalizer) => {
    if (finished) throw new Error(`cannot register ${label} after EC2 cleanup`);
    finalizers.push({ label, run });
  };

  const run = async () => {
    if (finished) return;
    finished = true;
    const failures: unknown[] = [];
    for (const finalizer of finalizers.reverse()) {
      try {
        await finalizer.run();
      } catch (error) {
        failures.push(new AggregateError([error], `EC2 cleanup failed: ${finalizer.label}`));
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "EC2 cleanup was incomplete");
  };

  return { add, run };
};

export const ec2ResourceNames = (
  seed = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`,
) => {
  const safeSeed = seed.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 96);
  return {
    instance: `${TAG}-${safeSeed}`,
    keyPair: `${TAG}-key-${safeSeed}`,
    securityGroup: `${TAG}-sg-${safeSeed}`,
  };
};

const SSH_OPTS = [
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=10",
  "-o",
  "LogLevel=ERROR",
];

const guestUser = (os: VmOs): string =>
  os === "windows" ? "Administrator" : (process.env.E2E_EC2_LINUX_USER ?? "ubuntu");

/**
 * Reboot an EC2 guest by address, statelessly (no live handle) — the mirror of
 * tart's sshRebootGuest, for the worker-side `restart()`. The connection drops
 * mid-call, so errors are swallowed; the caller's down-gate + up-poll confirm
 * the real reboot.
 */
export const ec2RebootGuest = async (
  host: string,
  keyPath: string,
  os: VmOs = "windows",
): Promise<void> => {
  const cmd = os === "windows" ? "Restart-Computer -Force" : "sudo reboot";
  await execFileP("ssh", ["-i", keyPath, ...SSH_OPTS, `${guestUser(os)}@${host}`, cmd]).catch(
    () => undefined,
  );
};

const aws = async (args: ReadonlyArray<string>): Promise<string> => {
  const { stdout } = await execFileP(AWS, ["--region", REGION, "--output", "text", ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trim();
};

/** This host's public egress IP, for the inbound-SSH security-group rule. */
const egressIp = async (): Promise<string> => {
  const { stdout } = await execFileP("curl", [
    "-s",
    "--max-time",
    "10",
    "https://checkip.amazonaws.com",
  ]);
  return stdout.trim();
};

/** Latest AWS-published base AMI for the guest OS (resolve dynamically — ids rotate). */
const latestAmi = async (os: VmOs): Promise<string> => {
  if (os === "windows") {
    const viaSsm = await aws([
      "ssm",
      "get-parameters",
      "--names",
      "/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base",
      "--query",
      "Parameters[0].Value",
    ]).catch(() => "");
    if (viaSsm && viaSsm !== "None") return viaSsm;
    return aws([
      "ec2",
      "describe-images",
      "--owners",
      "amazon",
      "--filters",
      "Name=name,Values=Windows_Server-2022-English-Full-Base-*",
      "Name=state,Values=available",
      "--query",
      "reverse(sort_by(Images,&CreationDate))[0].ImageId",
    ]);
  }
  return aws([
    "ssm",
    "get-parameters",
    "--names",
    "/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id",
    "--query",
    "Parameters[0].Value",
  ]);
};

const defaultNetwork = async () => {
  const vpcId = await aws([
    "ec2",
    "describe-vpcs",
    "--filters",
    "Name=isDefault,Values=true",
    "--query",
    "Vpcs[0].VpcId",
  ]);
  const subnet = await aws([
    "ec2",
    "describe-subnets",
    "--filters",
    `Name=vpc-id,Values=${vpcId}`,
    "Name=default-for-az,Values=true",
    "--query",
    "Subnets[0].SubnetId",
  ]);
  const subnetId =
    subnet && subnet !== "None"
      ? subnet
      : await aws([
          "ec2",
          "describe-subnets",
          "--filters",
          `Name=vpc-id,Values=${vpcId}`,
          "--query",
          "Subnets[0].SubnetId",
        ]);
  return { subnetId, vpcId };
};

/** Create a security group used only by one provisioned guest. */
const createSecurityGroup = (vpcId: string, name: string, tags: readonly Ec2ResourceTag[]) =>
  aws([
    "ec2",
    "create-security-group",
    "--group-name",
    name,
    "--description",
    "executor e2e ephemeral guest SSH",
    "--vpc-id",
    vpcId,
    "--tag-specifications",
    ec2TagSpecifications("security-group", tags),
    "--query",
    "GroupId",
  ]);

const authorizeSecurityGroup = (myIp: string, securityGroupId: string) =>
  aws([
    "ec2",
    "authorize-security-group-ingress",
    "--group-id",
    securityGroupId,
    "--protocol",
    "tcp",
    "--port",
    "22",
    "--cidr",
    `${myIp}/32`,
  ]);

const deleteSecurityGroup = async (securityGroupId: string) => {
  let lastFailure: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await aws(["ec2", "delete-security-group", "--group-id", securityGroupId]);
      return;
    } catch (error) {
      lastFailure = error;
      if (attempt < 5) await sleep(2_000);
    }
  }
  throw lastFailure;
};

/** PowerShell user-data: enable OpenSSH, default the shell to PowerShell, and
 * authorize our public key for the Administrator account. */
const windowsUserData = (publicKey: string): string =>
  [
    "<powershell>",
    "Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0",
    "Set-Service -Name sshd -StartupType Automatic",
    "Start-Service sshd",
    "New-ItemProperty -Path 'HKLM:\\SOFTWARE\\OpenSSH' -Name DefaultShell -Value 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -PropertyType String -Force",
    "New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -ErrorAction SilentlyContinue",
    "$akf = 'C:\\ProgramData\\ssh\\administrators_authorized_keys'",
    `Set-Content -Path $akf -Value '${publicKey}'`,
    "icacls $akf /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F'",
    "</powershell>",
  ].join("\n");

const linuxUserData = (publicKey: string): string =>
  ["#cloud-config", "ssh_authorized_keys:", `  - ${publicKey}`].join("\n");

const rootDeviceName = (ami: string) =>
  aws(["ec2", "describe-images", "--image-ids", ami, "--query", "Images[0].RootDeviceName"]);

export const ec2RunInstancesArgs = (options: {
  readonly ami: string;
  readonly instanceType: string;
  readonly keyPairName: string;
  readonly rootDeviceName: string;
  readonly securityGroupId: string;
  readonly subnetId: string;
  readonly tags: readonly Ec2ResourceTag[];
  readonly userDataFile: string;
}) => [
  "ec2",
  "run-instances",
  "--image-id",
  options.ami,
  "--instance-type",
  options.instanceType,
  "--count",
  "1",
  "--key-name",
  options.keyPairName,
  "--security-group-ids",
  options.securityGroupId,
  "--subnet-id",
  options.subnetId,
  "--associate-public-ip-address",
  "--instance-initiated-shutdown-behavior",
  "terminate",
  "--metadata-options",
  "HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=1,InstanceMetadataTags=disabled",
  "--block-device-mappings",
  JSON.stringify([
    {
      DeviceName: options.rootDeviceName,
      Ebs: { DeleteOnTermination: true, Encrypted: true, VolumeType: "gp3" },
    },
  ]),
  "--user-data",
  `file://${options.userDataFile}`,
  "--tag-specifications",
  ec2TagSpecifications("instance", options.tags),
  "--query",
  "Instances[0].InstanceId",
];

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });

const waitLocalPort = async (port: number, attempts = 40): Promise<void> => {
  for (let i = 0; i < attempts; i++) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ host: "127.0.0.1", port }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => resolve(false));
      sock.setTimeout(1000, () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await sleep(500);
  }
  throw new Error(`tunnel local port ${port} never came up`);
};

export const ec2Vm = (os: VmOs, arch: VmArch = "x64"): VmProvider => ({
  os,
  provision: async () => {
    const finalizers = createEc2FinalizerStack();
    try {
      const user = guestUser(os);
      const metadata = resolveVmRunMetadata();
      const names = ec2ResourceNames(
        `${metadata.scopeSlug}-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`,
      );
      const keyDir = mkdtempSync(join(tmpdir(), "executor-ec2-"));
      finalizers.add("local key directory", () => rmSync(keyDir, { force: true, recursive: true }));

      const [myIp, ami, network] = await Promise.all([egressIp(), latestAmi(os), defaultNetwork()]);

      const keyMaterial = await aws([
        "ec2",
        "create-key-pair",
        "--key-name",
        names.keyPair,
        "--key-type",
        "rsa",
        "--key-format",
        "pem",
        "--tag-specifications",
        ec2TagSpecifications("key-pair", ec2ResourceTags(metadata, names.keyPair)),
        "--query",
        "KeyMaterial",
      ]);
      finalizers.add("EC2 key pair", () =>
        aws(["ec2", "delete-key-pair", "--key-name", names.keyPair]).then(() => undefined),
      );

      const keyPath = join(keyDir, "id.pem");
      writeFileSync(keyPath, `${keyMaterial}\n`, { mode: 0o600 });
      chmodSync(keyPath, 0o600);
      const publicKey = (await execFileP("ssh-keygen", ["-y", "-f", keyPath])).stdout.trim();

      const securityGroupId = await createSecurityGroup(
        network.vpcId,
        names.securityGroup,
        ec2ResourceTags(metadata, names.securityGroup),
      );
      finalizers.add("EC2 security group", () => deleteSecurityGroup(securityGroupId));
      await authorizeSecurityGroup(myIp, securityGroupId);

      const userData = os === "windows" ? windowsUserData(publicKey) : linuxUserData(publicKey);
      const userDataFile = join(keyDir, "user-data.txt");
      writeFileSync(userDataFile, userData);
      const rootDevice = await rootDeviceName(ami);
      if (!rootDevice || rootDevice === "None") {
        throw new Error(`ec2 ${os}: AMI ${ami} has no root device mapping`);
      }

      const instanceId = await aws(
        ec2RunInstancesArgs({
          ami,
          instanceType: INSTANCE_TYPE,
          keyPairName: names.keyPair,
          rootDeviceName: rootDevice,
          securityGroupId,
          subnetId: network.subnetId,
          tags: ec2ResourceTags(metadata, `${names.instance}-${os}`),
          userDataFile,
        }),
      );
      finalizers.add("EC2 instance", async () => {
        await aws(["ec2", "terminate-instances", "--instance-ids", instanceId]);
        await aws(["ec2", "wait", "instance-terminated", "--instance-ids", instanceId]);
      });

      let ip = "";
      const tunnelClosers = new Set<() => void>();
      finalizers.add("SSH tunnels", () => {
        for (const close of tunnelClosers) close();
        tunnelClosers.clear();
      });

      const ssh = async (command: string): Promise<SshResult> => {
        try {
          const { stdout, stderr } = await execFileP(
            "ssh",
            ["-i", keyPath, ...SSH_OPTS, `${user}@${ip}`, command],
            { maxBuffer: 64 * 1024 * 1024 },
          );
          return { stdout, stderr, code: 0 };
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string; code?: number };
          return {
            stdout: e.stdout ?? "",
            stderr: e.stderr ?? "",
            code: typeof e.code === "number" ? e.code : 1,
          };
        }
      };

      const waitSshUp = async (attempts: number): Promise<boolean> => {
        for (let i = 0; i < attempts; i++) {
          if ((await ssh(os === "windows" ? "echo ok" : "true")).code === 0) return true;
          await sleep(5000);
        }
        return false;
      };

      const waitSshDown = async (attempts = 40): Promise<void> => {
        for (let i = 0; i < attempts; i++) {
          if ((await ssh("echo up")).code !== 0) return;
          await sleep(3000);
        }
        // never observed down, the boot-time check is the backstop.
      };

      const bootTime = async (): Promise<string> =>
        os === "windows"
          ? (
              await ssh("(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToString('o')")
            ).stdout.trim()
          : (await ssh("cat /proc/sys/kernel/random/boot_id")).stdout.trim();

      const handle: VmHandle = {
        os,
        arch,
        sshKeyPath: keyPath,
        get host() {
          return ip;
        },
        ssh,
        push: async (localPath, remotePath) => {
          await execFileP("scp", [
            "-i",
            keyPath,
            "-r",
            ...SSH_OPTS,
            localPath,
            `${user}@${ip}:${remotePath}`,
          ]);
        },
        reboot: async () => {
          const before = await bootTime();
          await ssh(os === "windows" ? "Restart-Computer -Force" : "sudo reboot");
          await waitSshDown();
          if (!(await waitSshUp(60))) throw new Error(`ec2 ${os}: SSH did not return after reboot`);
          const after = await bootTime();
          if (before && after && before === after) {
            throw new Error(
              `ec2 ${os}: boot time unchanged after reboot, the guest never actually rebooted`,
            );
          }
        },
        tunnel: async (guestPort) => {
          const localPort = await freePort();
          let child: ReturnType<typeof spawn> | undefined;
          let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
          let closed = false;

          const spawnOnce = () => {
            if (closed || child) return;
            const spawned = spawn(
              "ssh",
              [
                "-i",
                keyPath,
                ...SSH_OPTS,
                "-N",
                "-L",
                `${localPort}:127.0.0.1:${guestPort}`,
                `${user}@${ip}`,
              ],
              { stdio: "ignore" },
            );
            child = spawned;
            let settled = false;
            const onStopped = () => {
              if (settled) return;
              settled = true;
              if (child === spawned) child = undefined;
              if (!closed && !reconnectTimer) {
                reconnectTimer = setTimeout(() => {
                  reconnectTimer = undefined;
                  spawnOnce();
                }, 2_000);
              }
            };
            spawned.on("error", onStopped);
            spawned.on("exit", onStopped);
          };

          const close = () => {
            if (closed) return;
            closed = true;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = undefined;
            const active = child;
            child = undefined;
            active?.kill();
            tunnelClosers.delete(close);
          };

          tunnelClosers.add(close);
          spawnOnce();
          try {
            await waitLocalPort(localPort);
          } catch (error) {
            close();
            throw error;
          }
          return { localPort, close };
        },
        discard: finalizers.run,
      };

      // Wait for a public IP, then for OpenSSH. Windows can need several minutes
      // while its first-boot feature installation enables the SSH server.
      for (let i = 0; i < 60; i++) {
        const got = await aws([
          "ec2",
          "describe-instances",
          "--instance-ids",
          instanceId,
          "--query",
          "Reservations[0].Instances[0].PublicIpAddress",
        ]).catch(() => "");
        if (got && got !== "None") {
          ip = got;
          break;
        }
        await sleep(5000);
      }
      if (!ip) throw new Error(`ec2 ${os}: no public IP within 300s`);
      if (!(await waitSshUp(60))) throw new Error(`ec2 ${os}: SSH never came up`);
      return handle;
    } catch (error) {
      try {
        await finalizers.run();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `ec2 ${os}: provisioning failed and cleanup was incomplete`,
        );
      }
      throw error;
    }
  },
});
