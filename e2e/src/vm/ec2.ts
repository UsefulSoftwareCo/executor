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

import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
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

const execFileP = promisify(execFile);

const REGION = process.env.E2E_EC2_REGION ?? "us-west-2";
const INSTANCE_TYPE = process.env.E2E_EC2_INSTANCE_TYPE ?? "t3.medium";
const TAG = "executor-e2e";

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
  const { stdout } = await execFileP("aws", ["--region", REGION, "--output", "text", ...args], {
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

const defaultSubnet = async (): Promise<string> => {
  const vpc = await aws([
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
    `Name=vpc-id,Values=${vpc}`,
    "Name=default-for-az,Values=true",
    "--query",
    "Subnets[0].SubnetId",
  ]);
  return subnet && subnet !== "None"
    ? subnet
    : aws([
        "ec2",
        "describe-subnets",
        "--filters",
        `Name=vpc-id,Values=${vpc}`,
        "--query",
        "Subnets[0].SubnetId",
      ]);
};

/** Create (idempotently) a security group allowing inbound SSH from this host. */
const ensureSecurityGroup = async (myIp: string): Promise<string> => {
  const name = `${TAG}-sg`;
  let sg = await aws([
    "ec2",
    "describe-security-groups",
    "--filters",
    `Name=group-name,Values=${name}`,
    "--query",
    "SecurityGroups[0].GroupId",
  ]).catch(() => "");
  if (!sg || sg === "None") {
    sg = await aws([
      "ec2",
      "create-security-group",
      "--group-name",
      name,
      "--description",
      "executor e2e ephemeral guests (SSH from CI host)",
      "--query",
      "GroupId",
    ]);
  }
  // Authorize this host's IP for SSH; ignore "already exists".
  await aws([
    "ec2",
    "authorize-security-group-ingress",
    "--group-id",
    sg,
    "--protocol",
    "tcp",
    "--port",
    "22",
    "--cidr",
    `${myIp}/32`,
  ]).catch(() => undefined);
  return sg;
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
    const user = guestUser(os);
    // A throwaway SSH keypair, authorized via user-data (no EC2 key pair needed —
    // we drive over OpenSSH key auth, not the Windows password).
    const keyDir = mkdtempSync(join(tmpdir(), "executor-ec2-"));
    const keyPath = join(keyDir, "id");
    await execFileP("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-f", keyPath]);
    chmodSync(keyPath, 0o600);
    const publicKey = (await execFileP("ssh-keygen", ["-y", "-f", keyPath])).stdout.trim();

    const [myIp, ami, subnet] = await Promise.all([egressIp(), latestAmi(os), defaultSubnet()]);
    const sg = await ensureSecurityGroup(myIp);
    const userData = os === "windows" ? windowsUserData(publicKey) : linuxUserData(publicKey);
    const userDataFile = join(keyDir, "user-data.txt");
    writeFileSync(userDataFile, userData);

    const instanceId = await aws([
      "ec2",
      "run-instances",
      "--image-id",
      ami,
      "--instance-type",
      INSTANCE_TYPE,
      "--count",
      "1",
      "--security-group-ids",
      sg,
      "--subnet-id",
      subnet,
      "--associate-public-ip-address",
      "--instance-initiated-shutdown-behavior",
      "terminate",
      "--user-data",
      `file://${userDataFile}`,
      "--tag-specifications",
      `ResourceType=instance,Tags=[{Key=Name,Value=${TAG}-${os}},{Key=purpose,Value=e2e}]`,
      "--query",
      "Instances[0].InstanceId",
    ]);

    let ip = "";
    const tunnelClosers: Array<() => void> = [];

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
        if ((await ssh("echo up").catch(() => ({ code: 1 }) as SshResult)).code !== 0) return;
        await sleep(3000);
      }
      // never observed down — caller's boot-time check is the backstop.
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
        await ssh(os === "windows" ? "Restart-Computer -Force" : "sudo reboot").catch(
          () => undefined,
        );
        await waitSshDown();
        if (!(await waitSshUp(60))) throw new Error(`ec2 ${os}: SSH did not return after reboot`);
        const after = await bootTime();
        if (before && after && before === after) {
          throw new Error(
            `ec2 ${os}: boot time unchanged after reboot — the guest never actually rebooted`,
          );
        }
      },
      tunnel: async (guestPort) => {
        const localPort = await freePort();
        let closed = false;
        let child: ReturnType<typeof import("node:child_process").spawn> | undefined;
        const { spawn } = await import("node:child_process");
        const spawnOnce = (): void => {
          child = spawn(
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
          child.on("exit", () => {
            if (!closed) setTimeout(spawnOnce, 2000);
          });
        };
        spawnOnce();
        const close = (): void => {
          closed = true;
          child?.kill();
        };
        tunnelClosers.push(close);
        await waitLocalPort(localPort);
        return { localPort, close };
      },
      discard: async () => {
        for (const close of tunnelClosers) close();
        await aws(["ec2", "terminate-instances", "--instance-ids", instanceId]).catch(
          () => undefined,
        );
      },
    };

    // Wait for a public IP, then for OpenSSH (Windows boot + FoD install ≈ 2-4 min).
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
    if (!ip) {
      await handle.discard();
      throw new Error(`ec2 ${os}: no public IP within 300s`);
    }
    if (!(await waitSshUp(60))) {
      await handle.discard();
      throw new Error(`ec2 ${os}: SSH never came up`);
    }
    return handle;
  },
});
