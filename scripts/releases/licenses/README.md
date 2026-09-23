# Bundled Git

Executor bundles Git through dugite 3.2.3 (MIT) and its pinned dugite-native
v2.53.0-4 distributions (GPL-2.0). Upstream code is unmodified. The runtime retains
dugite's license and the native distribution's third-party notices.

Windows x64 also includes `git-http-backend.exe` from the matching official
Git-for-Windows package. The build verifies the installed Git, source archive,
and helper hashes before packaging. The source archive retains an older filename,
but its Git executable is byte-identical to the pinned MinGit 2.53.0.windows.4.
The companion Git-for-Windows source tree covers this unmodified helper too.

Build scripts and dependency/source revisions:
https://github.com/desktop/dugite-native/tree/v2.53.0-4

Run `node scripts/releases/git-sources.ts` to prepare a checksum-verified source
archive in `.local/releases/sources/`. It includes the exact POSIX Git source,
patched Windows Git source and native build scripts. Publish it alongside the
binary archives; a repository link alone is not the source artifact.

The additional MinGit components still need a source/license review before public
Windows distribution. See [source archive contents](git-sources.md). The build workflow retains these materials with its artifacts. Publication must
copy them to the public versioned release beside the binaries.
