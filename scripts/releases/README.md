# Executor 2 beta

Install with npm, `npm i -g executor@beta`, on Node 14.18 or newer. Without Node, run `curl -fsSL https://executor.sh/docs/install.sh | sh`
on macOS or Linux, or `irm https://executor.sh/docs/install.ps1 | iex` in
PowerShell on Windows. Each release also attaches its archives and `SHA256SUMS`.
Run `executor` to start the background Executor, or join the one already
running, and open the dashboard. The background Executor keeps running until
`executor service stop`; nothing starts it with the OS. `executor` checks npm
daily for a newer release and suggests `executor upgrade`; set
`EXECUTOR_NO_UPDATE_CHECK=1` to skip it. Use `executor service start` to start it
without a browser, `executor serve` to run it in the foreground, and
`executor service pair` to get a new browser connection link.
`executor upgrade` installs the newest release on your channel the way Executor
was installed: an install-script copy downloads and checks the release and keeps
the previous version for `executor upgrade --rollback`; an npm, pnpm, Bun or
Yarn install runs its package manager. Either way it stops the background
Executor before replacing its files and starts it again on the new version; a
release from before the background service, which a rollback can return to, has
no `executor service`, so run `executor serve` there instead.

Executor is one executable, built with Bun, with the files it runs or reads
beside it: the dashboard, the app framework and compiler references, workerd,
Git, the native credential-store binding and the telemetry collector with its viewer. It needs no
source checkout, Node, Bun or 1Password on the user machine. The `executor` npm
package is a launcher. The first time a version starts, it downloads that
release's archive for the platform, for macOS (Apple Silicon and Intel), Linux
(arm64 and x64, glibc) or Windows (x64), from the public GitHub release, checks it
against the SHA-256 the package records, and keeps it in
`~/.executor/v2/launcher/<version>` with the version before it. The same archive
is the release download the install scripts and Homebrew use.
`EXECUTOR_DOWNLOAD_URL` names a mirror of the releases for all of them.

Beta uses `~/.executor/v2/cli` for its data. This path stays the same at the
stable release. It is separate from Executor 1 data. One server runs per data
directory; its `.server.lock` stops a second. `EXECUTOR_DATA_DIR` selects another
directory, and `EXECUTOR_PORT` or `executor service set port` changes the default
port of 4312. The desktop app uses the same directory and background Executor.
Its first launch moves the data of a desktop release from before the background
service into that directory, once. CLI data already there moves to
`~/.executor/v2/backups/cli-data-<time>`, which the desktop app names; nothing
is merged or deleted. The CLI's settings carry over, except its port and the
`env` variables that belong to its data.

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
`executor-<version>-<platform>-<arch>.tgz` packs as the platform's release
archive. The executable takes `runtime/cli.mjs` in its install directory as
every module's location, so resources, `require` and `import.meta.resolve` find
the same files beside it wherever the archive is unpacked, through any launcher
symlink. Packages that must stay on disk load from
`runtime/node_modules`; Git is in `runtime/git`.
The npm launcher is under `.local/releases/<version>/wrapper/`. Its
package.json records the SHA-256 of each platform archive found under
`.local/releases/<version>-<platform>-<arch>/`, or under the directory
`release:wrapper` is given; publishing requires all five. The runtimes are never
published to npm. Through 2.0.0-beta.36 each was published as a version of the
`executor` package, such as `2.0.0-beta.36-win32-x64`, which semver ranks above
the launcher, so a range update such as `bun update -g` replaced the launcher
with a runtime. Those versions are deprecated so package managers skip them.
These build commands do not publish anything.
The app compiler and framework are prepared for workerd at build time, so the
executable downloads nothing more. Most of each archive is the executable,
workerd and the bundled Git, which keeps only what the runtime runs (`keptGit`
in `runtime-bundle.ts`).
External source maps stay in the separate CI artifact for release diagnostics.

Stock Bun lets any local process run its own code inside a compiled executable,
through `BUN_OPTIONS`, `BUN_BE_BUN`, `BUN_INSPECT` and similar variables that
Bun reads before the executable's first line. The release executable is built
on a Bun runtime patched to ignore them, from
[`bun-runtime/`](bun-runtime/README.md). `EXECUTOR_BUN_RUNTIME` names it; CI and
publishing builds refuse stock Bun, and a local build without it prints that it
is a development build. The release workflow fetches the runtime from the
`bun-runtime-<bun version>-<patch hash>` release, building it first when the
patch changed.

A pull request that changes the lockdown patch has no runtime release yet, so CI's
`release-local` lane (both its jobs) fails and names the command that builds one from its branch:
`gh workflow run bun-runtime.yml --ref <branch> -f publish=true`, which anyone with
write access can run. The release is named by the Bun version and the patch hash
only, so main's runs, publishing ones included, use it from then on. If the
branch's build scripts (`scripts/releases/bun-runtime/`) change after that build
and before merge, delete that release before merging, and the push to main builds
it again from main's scripts. Keying the release name on a hash of the whole
`scripts/releases/bun-runtime/` directory, not the patch alone, would make this
automatic; it is not done yet.

The Rust telemetry collector is built by `packages/telemetry/scripts/build-collector.ts` (see the
crate's README). The release workflow's `collector` job builds each target once per run from the
`collector_matrix` that `workflow.ts` writes: the targets the run's packaging jobs (`local`,
`local-macos-arm64`, `checks`, `cli`, `recovery`) run on, after any narrowing, so Linux x64 only
in a check and none in a build of only the image, whose `releases` gate then expects the
`collector` job skipped. It always builds; no release run restores or saves it. The packaging jobs do not
`need` it: each waits for its own target's collector job with `collector-job.ts` and then
downloads the build into `packages/telemetry/dist/collector/` before "Package the CLI runtime".
`collector-job.ts` and the Deploy workflow's `apps-job.ts` share `job-wait.ts`, which follows one
job of the run through the jobs API, fails as soon as that job ends without success or an answer
leaves doubt, and fails at its deadline in elapsed time otherwise.

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
