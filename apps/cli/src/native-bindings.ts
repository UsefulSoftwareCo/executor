// ---------------------------------------------------------------------------
// Native-binding bootstrap for the `bun build --compile` binary.
//
// `bun --compile` bundles JS into bunfs but does NOT include `.node` native
// addons, so a dynamic `require('@libsql/<platform>')` / keyring walk inside
// the binary fails. build.ts copies each platform's `.node` next to the
// executable (`libsql.node`, `keyring.node`); here we publish their on-disk
// paths via env vars the loaders read.
//
// This MUST be the FIRST import in main.ts. ES modules evaluate every import
// before the importer's own body, and libSQL resolves its native addon EAGERLY
// at module load (`const {...} = requireNative()` in `libsql/index.js`). So the
// env var has to be set as a side effect of an import that is ordered before
// the `@executor-js/local` → `@libsql/client` graph — setting it in main.ts's
// body would run too late, after libSQL had already tried (and failed) to load.
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const execDir = dirname(process.execPath);

// libSQL: our `libsql` patch reads EXECUTOR_LIBSQL_NATIVE_PATH and loads the
// colocated binding directly, before its (in-bunfs, doomed) platform-package walk.
const libsqlNodeOnDisk = join(execDir, "libsql.node");
if (
  typeof Bun !== "undefined" &&
  !process.env.EXECUTOR_LIBSQL_NATIVE_PATH &&
  existsSync(libsqlNodeOnDisk)
) {
  process.env.EXECUTOR_LIBSQL_NATIVE_PATH = libsqlNodeOnDisk;
}

// keyring: the keychain plugin reads EXECUTOR_KEYRING_NATIVE_PATH (lazily, but
// set here alongside libSQL so all native colocation lives in one place). We
// can't use NAPI_RS_NATIVE_LIBRARY_PATH — @napi-rs/keyring 1.2.0's env-var
// branch assigns to a local that gets overwritten before the binding returns.
const keyringNodeOnDisk = join(execDir, "keyring.node");
if (
  typeof Bun !== "undefined" &&
  !process.env.EXECUTOR_KEYRING_NATIVE_PATH &&
  existsSync(keyringNodeOnDisk)
) {
  process.env.EXECUTOR_KEYRING_NATIVE_PATH = keyringNodeOnDisk;
}
