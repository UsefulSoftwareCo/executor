# Executor 2 beta

Install with `npm i -g executor@beta`. Requires Node 24.14 or newer.
Run `executor` to start the server and open the dashboard. Use `executor serve`
for headless operation and `executor pair` to get a new browser connection link.

The package includes the dashboard, framework, runtime compiler, pinned Bun,
Git, and the Motel collector. It does not need a source checkout, Bun, or
1Password on the user machine. Native runtimes are selected by npm for macOS
(Apple Silicon and Intel), Linux (arm64 and x64), and Windows (x64).

Beta uses `~/.executor/v2/cli` for its data. This path stays the same at the
stable release. It is separate from Executor 1 data. Do not run two servers
against the same directory. `EXECUTOR_DATA_DIR` selects another directory and
`EXECUTOR_PORT` changes the default port of 4312.

On first launch, Executor saves its API and encryption keys in the OS credential
store: macOS Keychain, Windows Credential Manager, or Linux Secret Service.
Linux requires a persistent Secret Service such as GNOME Keyring. There is no
plaintext or in-memory fallback. A locked, unavailable, missing or invalid
credential stops startup; existing installations never receive replacement keys.

Back up the data directory, including `installation.json`, and the matching OS
credential (`com.usefulsoftware.executor.v2`, account ID from that file).
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
bun run release:cli
bun run release:wrapper
```

Native artifacts are under `.local/releases/<version>-<platform>-<arch>/`.
The npm launcher is under `.local/releases/<version>/wrapper/` and uses exact
native version aliases. These build commands do not publish anything.
The native package bundles the CLI and desktop server together. The app compiler
and framework are prepared for workerd at build time. Native libraries, Git,
Motel and authoring references remain included. No runtime download is needed.
Each compressed native archive must fit within 180 MiB before publication.
This is a release budget with margin, not a documented npm registry limit.
External source maps stay in the separate CI artifact for release diagnostics.

The prepared packages retain dependency licenses. Public releases also include
checksum-pinned source archives for the bundled Git distribution.

## macOS signing

`node scripts/releases/desktop.ts <version>` is unsigned by default, which is a
development build: Gatekeeper rejects it until someone overrides it by hand.
Add `--sign` to sign with a Developer ID Application identity, or `--notarize`
to sign and submit the result to Apple. Both modes keep electron-builder's
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
