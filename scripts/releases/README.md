# Executor 2 beta

Install with npm, `npm i -g executor@beta --include=optional`, on Node 14.18
or newer. Without Node, run `curl -fsSL https://executor.sh/docs/install.sh | sh`
on macOS or Linux, or `irm https://executor.sh/docs/install.ps1 | iex` in
PowerShell on Windows. Each release also attaches its archives and `SHA256SUMS`.
Run `executor` to start the server and open the dashboard. It checks npm daily
for a newer release and suggests `executor upgrade`; set `EXECUTOR_NO_UPDATE_CHECK=1` to skip it. Use `executor serve`
for headless operation and `executor pair` to get a new browser connection link.
`executor upgrade` installs the newest release on your channel the way Executor
was installed: an install-script copy downloads and checks the release and keeps
the previous version for `executor upgrade --rollback`; an npm, pnpm, Bun or
Yarn install runs its package manager. Restart a running server afterwards.

Executor is one executable, built with Bun, with the files it runs or reads
beside it: the dashboard, the app framework and compiler references, workerd,
Git, the native credential-store binding and the Motel collector. It needs no
source checkout, Node, Bun or 1Password on the user machine. The `executor` npm
package is a launcher that starts the executable from the platform package npm
installs as an optional dependency, for macOS (Apple Silicon and Intel), Linux
(arm64 and x64, glibc) and Windows (x64). The same archive is the release
download the install scripts and Homebrew use.

Beta uses `~/.executor/v2/cli` for its data. This path stays the same at the
stable release. It is separate from Executor 1 data. Do not run two servers
against the same directory. `EXECUTOR_DATA_DIR` selects another directory and
`EXECUTOR_PORT` changes the default port of 4312.

On first launch, Executor saves its API and encryption keys in the OS credential
store: macOS Keychain, Windows Credential Manager, or Linux Secret Service.
Linux uses a persistent Secret Service such as GNOME Keyring. If there is no
store on a directory's first start, the keys are saved to `keys.json` in the
data directory (mode `0600`) and the path is printed to stderr. If a store exists
but access is denied or it is locked, startup stops without a key file and the
next start asks again. Over SSH, unlock the store first, or set
`EXECUTOR_KEY_STORAGE=file` before a directory's first start to use `keys.json`
(`os` requires the store instead). A directory that already uses the OS store stops when it
is locked or unavailable. A missing or
invalid credential or key file stops startup; existing installations never
receive replacement keys.

Back up the data directory, including `installation.json` and any `keys.json`,
and the matching OS credential (`com.usefulsoftware.executor.v2`, account ID
from that file) when the directory uses one.
Copying only the data directory to another machine is not enough to recover it.
For a new headless install, supply both `EXECUTOR_API_KEY` (32+ characters) and
`EXECUTOR_ENCRYPTION_KEY` (64 hexadecimal characters) through a secret manager.
Those supplied keys are never saved by Executor. Keep them with your backups.
A directory keeps its chosen key source across upgrades; changing it requires
an explicit transfer. Uninstalling the program does not delete your data or keys.

## Build for review

The version in `apps/cli/package.json` is the release source of truth.
`scripts/releases/config.ts` derives the channel, platform packages, download
names and image tags from it. `2.0.0-beta.N` publishes to `beta`; a stable
version publishes to `latest` only through an explicitly selected stable release.

```sh
bun install --frozen-lockfile
EXECUTOR_BUN_RUNTIME=/path/to/locked-down/bun bun run release:cli
bun run release:wrapper
```

Native artifacts are under `.local/releases/<version>-<platform>-<arch>/`.
`release:cli` bundles the runtime twice. `package/` holds the JavaScript runtime
the desktop app runs with its own Node. `standalone/` holds the release install:
the `executor` executable (`bun build --compile`) and the files beside it, which
`executor-<version>-<platform>-<arch>.tgz` packs as the platform's npm package
and release archive. The executable takes `runtime/cli.mjs` in its install
directory as every module's location, so resources, `require` and
`import.meta.resolve` find the same files beside it as from the npm package,
through any launcher symlink. Packages that must stay on disk load from
`runtime/node_modules`; Git is in `runtime/git`.
The npm launcher is under `.local/releases/<version>/wrapper/` and uses exact
native version aliases. These build commands do not publish anything.
The app compiler and framework are prepared for workerd at build time. No
runtime download is needed. Each compressed native archive must fit within
180 MiB before publication. This is a release budget with margin, not a
documented npm registry limit. External source maps stay in the separate CI
artifact for release diagnostics.

Stock Bun lets any local process run its own code inside a compiled executable,
through `BUN_OPTIONS`, `BUN_BE_BUN`, `BUN_INSPECT` and similar variables that
Bun reads before the executable's first line. The release executable is built
on a Bun runtime patched to ignore them, from
[`bun-runtime/`](bun-runtime/README.md). `EXECUTOR_BUN_RUNTIME` names it; CI and
publishing builds refuse stock Bun, and a local build without it prints that it
is a development build. The release workflow fetches the runtime from the
`bun-runtime-<bun version>-<patch hash>` release, building it first when the
patch changed.

The install scripts are `apps/docs/public/install.sh` and `install.ps1`, served
at `https://executor.sh/docs/`. The publish job writes the Homebrew formula
(`scripts/releases/homebrew.ts`) to the tap named by the `HOMEBREW_TAP`
repository variable once it is set.

The prepared packages retain dependency licenses. Public releases also include
checksum-pinned source archives for the bundled Git distribution.

## macOS signing

`node scripts/releases/desktop.ts <version>` and `node scripts/releases/package.ts`
are unsigned by default, which is a development build: Gatekeeper rejects it
until someone overrides it by hand.
Add `--sign` to sign with a Developer ID Application identity, or `--notarize`
to sign and submit the result to Apple. A publishing build of the CLI on macOS
(`EXECUTOR_RELEASE_PUBLISH=true`) fails unless it notarizes. For the CLI, every
Mach-O file in the install is signed with the hardened runtime, the executable
last as `com.usefulsoftware.executor.v2.cli` with
`entitlements.standalone.plist`: JIT for Bun and workerd, and library validation
left on, so it loads only libraries signed with the same identity. The whole
install is notarized as one archive; a bare executable cannot hold a stapled
ticket, so Gatekeeper checks it online. Both modes keep electron-builder's
identity auto-discovery off, so a build never picks up a stray keychain identity.

Signing accepts these environment variables and keeps plaintext keys off ordinary disk:

| Variable                           | Contents                                             |
| ---------------------------------- | ---------------------------------------------------- |
| `EXECUTOR_MAC_SIGNING_KEY`         | Developer ID Application private key, PEM            |
| `EXECUTOR_MAC_SIGNING_CERTIFICATE` | The matching certificate, PEM                        |
| `EXECUTOR_MAC_NOTARY_KEY`          | App Store Connect API key, `.p8` (`--notarize` only) |
| `EXECUTOR_MAC_NOTARY_KEY_ID`       | That key's identifier (`--notarize` only)            |
| `EXECUTOR_MAC_NOTARY_ISSUER`       | That key's issuer identifier (`--notarize` only)     |

Supply them from a secret manager rather than a shell profile, for example
`agent-vault run --env 'EXECUTOR_MAC_SIGNING_KEY=op://…' -- node scripts/releases/desktop.ts …`.
No plaintext key is written to ordinary disk. The build assembles a PKCS#12 in a pipe
and imports it into a temporary keychain of its own, which it deletes when the
build ends. `notarytool` accepts its key only as a seekable file, so that key is
written to a volume held in memory and the volume is ejected as soon as the
credentials are in the keychain.

Signing needs its keychain on the user search list, because `codesign` resolves
an identity from the search list rather than from `--keychain` alone. The build
puts its own keychain in front of the existing entries and restores the list
when it finishes. Your login keychain and the identities in it are never
modified, and a build never signs with an identity it did not import. Run
signing builds one at a time, since they share that list.

Notarizing a build covers both the application and its DMG installer. The ZIP
contains the stapled application. DMG update metadata is disabled because
stapling changes the image after packaging; macOS updater payloads use the ZIP.
Rebuilding the same version replaces that version's generated desktop output.
Use a new version to retain earlier installers.
