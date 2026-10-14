#!/bin/sh
# Install Executor on macOS or Linux, with no Node.js needed:
#
#   curl -fsSL https://executor.sh/docs/install.sh | sh
#   curl -fsSL https://executor.sh/docs/install.sh | sh -s -- 2.0.0-beta.16
#
# It downloads the release archive for this machine from the public GitHub release, checks it
# against the release's SHA256SUMS, unpacks it into ~/.executor/v2/runtime/versions/<version>,
# points ~/.executor/v2/runtime/current at it and links ~/.local/bin/executor to
# current/executor. The version it replaces stays as `previous`, so `executor upgrade --rollback`
# can switch back. Your shell profile is never edited: if ~/.local/bin is not on PATH, the script
# prints the line to add.
#
# Settings: EXECUTOR_VERSION (or the first argument), EXECUTOR_INSTALL_DIR (default
# ~/.executor/v2/runtime), EXECUTOR_BIN_DIR (default ~/.local/bin), EXECUTOR_DOWNLOAD_URL and
# EXECUTOR_NPM_REGISTRY for mirrors.
set -eu

repository=UsefulSoftwareCo/executor
download="${EXECUTOR_DOWNLOAD_URL:-https://github.com/$repository/releases/download}"
download="${download%/}"
registry="${EXECUTOR_NPM_REGISTRY:-https://registry.npmjs.org}"
registry="${registry%/}"
root="${EXECUTOR_INSTALL_DIR:-$HOME/.executor/v2/runtime}"
bin="${EXECUTOR_BIN_DIR:-$HOME/.local/bin}"
version="${1:-${EXECUTOR_VERSION:-}}"
version="${version#v}"

fail() {
  printf 'executor install: %s\n' "$*" >&2
  exit 1
}

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error --location --retry 3 --output "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget --quiet --tries=3 --output-document="$2" "$1"
  else
    fail "curl or wget is needed to download Executor."
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    fail "sha256sum or shasum is needed to check the download."
  fi
}

case "$(uname -s)" in
  Darwin) platform=darwin ;;
  Linux) platform=linux ;;
  *) fail "this script installs on macOS and Linux. On Windows, run: irm https://executor.sh/docs/install.ps1 | iex" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "Executor has no build for $(uname -m)." ;;
esac
# A shell under Rosetta reports x86_64 on Apple silicon; the native build is faster.
if [ "$platform" = darwin ] && [ "$arch" = x64 ] &&
  [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi
# The Linux builds need glibc, as Executor's bundled workerd and Git do.
if [ "$platform" = linux ] && { [ -f /etc/alpine-release ] || ldd --version 2>&1 | grep -qi musl; }; then
  fail "Executor needs a glibc Linux; musl distributions such as Alpine are not supported."
fi

temporary="$(mktemp -d "${TMPDIR:-/tmp}/executor-install.XXXXXX")"
trap 'rm -rf "$temporary"' EXIT INT TERM

if [ -z "$version" ]; then
  # npm's dist-tags name the current releases. `latest` still names Executor 1 until Executor 2
  # is stable, so it is used only once it names a version 2 release.
  fetch "$registry/-/package/executor/dist-tags" "$temporary/tags.json" ||
    fail "could not read the current release from $registry."
  tags="$(tr -d ' \n\r\t' < "$temporary/tags.json")"
  latest="$(printf '%s' "$tags" | sed -n 's/.*"latest":"\([^"]*\)".*/\1/p')"
  beta="$(printf '%s' "$tags" | sed -n 's/.*"beta":"\([^"]*\)".*/\1/p')"
  case "$latest" in
    2.*) version="$latest" ;;
    *) version="$beta" ;;
  esac
  [ -n "$version" ] || fail "$registry lists no Executor 2 release."
fi
case "$version" in
  *[!0-9A-Za-z.-]* | "") fail "$version is not an Executor version." ;;
esac

file="executor-$version-$platform-$arch.tgz"
base="$download/executor@$version"
printf 'Downloading Executor %s for %s/%s\n' "$version" "$platform" "$arch"
fetch "$base/SHA256SUMS" "$temporary/SHA256SUMS" ||
  fail "could not download SHA256SUMS for $version from $base."
expected="$(sed -n "s|^\([0-9a-f]\{64\}\) [ *]\(\./\)\{0,1\}$file\$|\1|p" "$temporary/SHA256SUMS" | head -n 1)"
[ -n "$expected" ] || fail "release $version has no $file."
fetch "$base/$file" "$temporary/$file" || fail "could not download $file from $base."
actual="$(sha256 "$temporary/$file")"
[ "$actual" = "$expected" ] ||
  fail "$file does not match the release's SHA256SUMS (expected $expected, got $actual). Nothing was installed."

mkdir -p "$temporary/unpacked" "$root/versions"
tar -xzf "$temporary/$file" -C "$temporary/unpacked"
reported="$("$temporary/unpacked/package/executor" --version 2>/dev/null || true)"
[ "$reported" = "executor v$version" ] ||
  fail "the downloaded Executor did not start on this machine. Nothing was installed."

# The version directory is complete before anything points at it.
staged="$root/versions/.$version.$$"
rm -rf "$staged"
mv "$temporary/unpacked/package" "$staged"
rm -rf "$root/versions/$version"
mv "$staged" "$root/versions/$version"

replaced=""
if [ -L "$root/current" ]; then
  replaced="$(basename "$(readlink "$root/current")")"
fi
ln -sfn "versions/$version" "$root/current"
if [ -n "$replaced" ] && [ "$replaced" != "$version" ] && [ -d "$root/versions/$replaced" ]; then
  ln -sfn "versions/$replaced" "$root/previous"
fi
# Keep only the current and previous versions.
kept_previous=""
if [ -L "$root/previous" ]; then kept_previous="$(basename "$(readlink "$root/previous")")"; fi
for directory in "$root/versions"/*; do
  name="$(basename "$directory")"
  if [ "$name" != "$version" ] && [ "$name" != "$kept_previous" ]; then rm -rf "$directory"; fi
done

mkdir -p "$bin"
ln -sfn "$root/current/executor" "$bin/executor"

printf 'Installed Executor %s in %s\n' "$version" "$root/versions/$version"
if [ -n "$replaced" ] && [ "$replaced" != "$version" ]; then
  printf 'Executor %s stays installed: run executor upgrade --rollback to switch back.\n' "$replaced"
fi
case ":$PATH:" in
  *":$bin:"*) printf 'Run: executor\n' ;;
  *)
    printf '\n%s is not on your PATH. Add it, then open a new terminal:\n' "$bin"
    case "$(basename "${SHELL:-sh}")" in
      fish) printf '  fish_add_path %s\n' "$bin" ;;
      zsh) printf "  echo 'export PATH=\"%s:\$PATH\"' >> ~/.zshrc\n" "$bin" ;;
      bash) printf "  echo 'export PATH=\"%s:\$PATH\"' >> ~/.bashrc\n" "$bin" ;;
      *) printf "  export PATH=\"%s:\$PATH\"\n" "$bin" ;;
    esac
    printf 'Or run it now: %s\n' "$bin/executor"
    ;;
esac
