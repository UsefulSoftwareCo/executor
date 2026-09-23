# Sources for bundled Git

This archive accompanies Executor's binaries using dugite 3.2.3 and
dugite-native v2.53.0-4. `manifest.json` records repository URLs, exact source
revisions and SHA-256 checksums. Each nested source archive is unmodified.

- `dugite-native.tar.gz`: the packaging scripts, platform build configuration,
  dependency versions/checksums, resources and upstream notices.
- `git.tar.gz`: Git v2.53.0, at the exact submodule revision used for macOS/Linux.
- `git-for-windows.tar.gz`: the patched Git v2.53.0.windows.4 source used by MinGit.
- `git-lfs.tar.gz`: the Git LFS 3.7.1 source used by the bundled helper.
- `git-lfs-modules/`: the 37 pinned Go module source archives, including the
  MPL-licensed `go-uuid` dependency. Their Go module checksums were verified
  against Git LFS's `go.sum`; the manifest also pins each archive's SHA-256.
- `windows/`: 55 source archives covering all 64 distinct packages listed in the
  pinned Windows x64 bundle's `etc/package-versions.txt`, including MSYS and MinGW
  libraries. The manifest maps each package/version to its archive and checksum.

To inspect the macOS/Linux build, extract `dugite-native.tar.gz`, then extract
`git.tar.gz` into its `git/` directory with `--strip-components=1`. The native
project's `script/build-macos.sh`, `script/build-ubuntu.sh`, `.github/workflows/`
and `docs/` describe its build flags and required platform toolchains. Executor
does not modify the upstream Git source. Git's `COPYING` is included in each
Git source tree and the binary package includes `licenses/git-GPL-2.0.txt`.

The native project also bundles Git LFS and Git Credential Manager. Their
versions and binary checksums are recorded in its `dependencies.json`.
`git-lfs-notices.txt` adds Git LFS's license, Go runtime license and the notices
from its pinned Go modules. Git Credential Manager's license and third-party
notices remain in the distributed Git tree.

Windows is a separate build: dugite repackages MinGit rather than compiling the
POSIX source. Its source packages retain upstream code, patches, `PKGBUILD` recipes
and package metadata. Git Credential Manager is supplied as its own source
repository archive. Use a Git for Windows SDK/MSYS2 environment to build these
packages; this archive is not a replacement toolchain. Some sources contain Git
object databases, as supplied by upstream, rather than checked-out files.

These pins cover Windows x64, the Windows architecture in Executor's release
matrix. They are tied to the binary archive's SHA-256, not just its version label.
The Git package's historical `2.52.0.1-1` filename is retained: the archive from
the `v2.53.0.windows.4` release contains that release's actual Git source.

Publish the source archive and its checksum alongside every binary release that
uses this Git version. A new dugite/native version requires a source-pin update.
