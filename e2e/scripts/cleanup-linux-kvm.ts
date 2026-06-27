// Exact-resource recovery for a cancelled desktop KVM job. The driver writes
// this ledger before creating its work directory or invoking virt-install.
// Cleanup validates scope, work root, libvirt URI, and per-process markers,
// then addresses only the recorded host children, domain, and work directory.

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  cleanupLibvirtLinuxKvmFromLedger,
  sweepStaleLibvirtLinuxKvm,
} from "../src/vm/linux-kvm-libvirt";

export const cleanupLinuxKvmLedger = async (input: {
  readonly ledgerPath: string | undefined;
  readonly expectedRepositoryScope: string | undefined;
  readonly expectedRunScope: string | undefined;
  readonly expectedLedgerDirectory?: string;
  readonly expectedWorkRoot?: string;
  readonly expectedLibvirtUri?: string;
  readonly ledgerExists?: (path: string) => boolean;
}) => {
  if (!input.ledgerPath) {
    throw new Error("cleanup-linux-kvm requires a ledger path or E2E_KVM_CLEANUP_LEDGER");
  }
  const ledgerExists = input.ledgerExists ?? existsSync;
  if (!ledgerExists(input.ledgerPath)) {
    return { status: "missing", ledgerPath: input.ledgerPath } as const;
  }
  if (!input.expectedRunScope) {
    throw new Error("cleanup-linux-kvm requires E2E_KVM_RUN_SCOPE when a ledger exists");
  }
  if (!input.expectedRepositoryScope) {
    throw new Error("cleanup-linux-kvm requires E2E_KVM_REPOSITORY_SCOPE when a ledger exists");
  }
  if (!input.expectedLedgerDirectory) {
    throw new Error("cleanup-linux-kvm requires E2E_KVM_LEDGER_DIR when a ledger exists");
  }
  const ledgerPath = resolve(input.ledgerPath);
  const expectedLedgerDirectory = resolve(input.expectedLedgerDirectory);
  if (dirname(ledgerPath) !== expectedLedgerDirectory) {
    throw new Error(
      `cleanup-linux-kvm ledger is outside ${expectedLedgerDirectory}: ${ledgerPath}`,
    );
  }
  const cleaned = await cleanupLibvirtLinuxKvmFromLedger(ledgerPath, {
    expectedRepositoryScope: input.expectedRepositoryScope,
    expectedRunScope: input.expectedRunScope,
    expectedWorkRoot: input.expectedWorkRoot || tmpdir(),
    expectedLibvirtUri: input.expectedLibvirtUri || "qemu:///system",
  });
  return {
    status: "cleaned",
    ledgerPath,
    domainName: cleaned.domainName,
  } as const;
};

export const sweepLinuxKvmRepository = (input: {
  readonly ledgerDirectory: string | undefined;
  readonly repositoryScope: string | undefined;
  readonly staleTtlMs: string | undefined;
  readonly currentLedgerPath?: string;
  readonly expectedWorkRoot?: string;
  readonly expectedLibvirtUri?: string;
}) => {
  if (!input.ledgerDirectory) {
    throw new Error("cleanup-linux-kvm sweep requires E2E_KVM_LEDGER_DIR");
  }
  if (!input.repositoryScope) {
    throw new Error("cleanup-linux-kvm sweep requires E2E_KVM_REPOSITORY_SCOPE");
  }
  const ttlMs = Number(input.staleTtlMs);
  if (!input.staleTtlMs || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error("cleanup-linux-kvm sweep requires a positive E2E_KVM_STALE_TTL_MS");
  }
  return sweepStaleLibvirtLinuxKvm({
    ledgerDirectory: input.ledgerDirectory,
    repositoryScope: input.repositoryScope,
    ttlMs,
    currentLedgerPath: input.currentLedgerPath,
    expectedWorkRoot: input.expectedWorkRoot || tmpdir(),
    expectedLibvirtUri: input.expectedLibvirtUri || "qemu:///system",
  });
};

const main = async () => {
  if (process.argv[2] === "sweep") {
    const result = await sweepLinuxKvmRepository({
      ledgerDirectory: process.env.E2E_KVM_LEDGER_DIR,
      repositoryScope: process.env.E2E_KVM_REPOSITORY_SCOPE,
      staleTtlMs: process.env.E2E_KVM_STALE_TTL_MS,
      currentLedgerPath: process.env.E2E_KVM_CLEANUP_LEDGER,
      expectedWorkRoot: process.env.E2E_KVM_WORK_ROOT,
      expectedLibvirtUri: process.env.E2E_LIBVIRT_URI,
    });
    console.log(
      `cleanup-linux-kvm: scanned=${result.scanned} cleaned=${result.cleaned.length} fresh=${result.preservedFresh.length} active=${result.preservedActive.length} current=${result.preservedCurrent.length}`,
    );
    return;
  }
  const result = await cleanupLinuxKvmLedger({
    ledgerPath: process.argv[2] || process.env.E2E_KVM_CLEANUP_LEDGER,
    expectedLedgerDirectory: process.env.E2E_KVM_LEDGER_DIR,
    expectedRepositoryScope: process.env.E2E_KVM_REPOSITORY_SCOPE,
    expectedRunScope: process.env.E2E_KVM_RUN_SCOPE,
    expectedWorkRoot: process.env.E2E_KVM_WORK_ROOT,
    expectedLibvirtUri: process.env.E2E_LIBVIRT_URI,
  });
  if (result.status === "missing") {
    console.log(`cleanup-linux-kvm: no ledger at ${result.ledgerPath}`);
  } else {
    console.log(`cleanup-linux-kvm: removed ${result.domainName}`);
  }
};

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
