#!/usr/bin/env bash
# Prepares a GitHub-hosted Ubuntu 24.04 runner to build the patched Bun
# runtime for one target, the way Bun's own release CI does:
#   - LLVM 23.1 from apt.llvm.org (the series scripts/build/ci-images/spec.ts pins)
#   - the pinned nightly Rust toolchain plus the target's std
#   - for linux targets, the ubuntu:20.04 glibc sysroot with gcc-13
#     libstdc++ (spec.ts glibcSysroot), so the
#     binary needs glibc 2.17 like the official release, not the runner's
#     glibc
# darwin targets fetch the macOS SDK from Apple's CDN and windows targets
# fetch the MSVC/Windows SDK with xwin during configure (--ci=on).
#
# Usage: setup-linux.sh <target> <bun-source-dir>
# Appends PATH entries to $GITHUB_PATH and variables to $GITHUB_ENV.
set -euo pipefail

target="$1"
src="$(cd "$2" && pwd)"

case "$target" in
  linux-x64) rust_target=x86_64-unknown-linux-gnu sysroot_arch=x86_64 ;;
  linux-arm64) rust_target=aarch64-unknown-linux-gnu sysroot_arch=aarch64 ;;
  darwin-x64) rust_target=x86_64-apple-darwin sysroot_arch= ;;
  darwin-arm64) rust_target=aarch64-apple-darwin sysroot_arch= ;;
  windows-x64) rust_target=x86_64-pc-windows-msvc sysroot_arch= ;;
  *) echo "unknown target: $target" >&2; exit 1 ;;
esac

export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends \
  ca-certificates curl wget gnupg lsb-release software-properties-common \
  cmake ninja-build pkg-config golang ruby perl python3 make \
  automake autoconf libtool nasm xz-utils unzip zip jq skopeo \
  binutils-x86-64-linux-gnu binutils-aarch64-linux-gnu

# LLVM 23 (clang, lld incl. ld64.lld and lld-link, llvm-strip, dsymutil).
llvm_script="$(mktemp)"
curl -fsSL https://apt.llvm.org/llvm.sh -o "$llvm_script"
sudo bash "$llvm_script" 23 all
sudo apt-get install -y --no-install-recommends llvm-23-tools
echo "/usr/lib/llvm-23/bin" >> "$GITHUB_PATH"
/usr/lib/llvm-23/bin/clang --version | head -1

# Rust: the toolchain pinned in the Bun checkout's rust-toolchain.toml.
if ! command -v rustup >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --default-toolchain none
  echo "$HOME/.cargo/bin" >> "$GITHUB_PATH"
  export PATH="$HOME/.cargo/bin:$PATH"
fi
cd "$src"
rustup toolchain install # reads rust-toolchain.toml
rustup component add rust-src
rustup target add "$rust_target"
cd - >/dev/null

if [ -z "$sysroot_arch" ]; then
  exit 0
fi

# glibc sysroot: ubuntu:20.04 rootfs + focal libc6/libc6-dev + gcc-13 libstdc++.
case "$sysroot_arch" in
  x86_64) sysroot=/opt/linux-sysroot-glibc deb_arch=amd64 apt_base=http://archive.ubuntu.com/ubuntu ;;
  aarch64) sysroot=/opt/linux-sysroot-glibc-arm64 deb_arch=arm64 apt_base=http://ports.ubuntu.com/ubuntu-ports ;;
esac
tmp="$(mktemp -d)"
sudo rm -rf "$sysroot"
sudo mkdir -p "$sysroot"

skopeo copy --override-arch "$deb_arch" docker://docker.io/library/ubuntu:20.04 "dir:$tmp/img"
for digest in $(jq -r '.layers[].digest' "$tmp/img/manifest.json" | sed 's/^sha256://'); do
  sudo tar -xzf "$tmp/img/$digest" -C "$sysroot" 2>/dev/null || true
done

curl -fsSL "$apt_base/dists/focal-updates/main/binary-$deb_arch/Packages.gz" -o "$tmp/updates.gz"
curl -fsSL "$apt_base/dists/focal/main/binary-$deb_arch/Packages.gz" -o "$tmp/release.gz"
gzip -dc "$tmp/updates.gz" "$tmp/release.gz" > "$tmp/Packages"
for pkg in libc6 libc6-dev linux-libc-dev libcrypt1 libcrypt-dev; do
  path="$(awk -v p="$pkg" '$1=="Package:"&&$2==p{f=1} f&&$1=="Filename:"{print $2; exit}' "$tmp/Packages")"
  curl -fsSL "$apt_base/$path" -o "$tmp/$pkg.deb"
  sudo dpkg-deb -x "$tmp/$pkg.deb" "$sysroot"
done

# Keep absolute symlinks inside the sysroot.
sudo find "$sysroot" -type l -print0 | while IFS= read -r -d '' link; do
  dest="$(readlink "$link")"
  case "$dest" in /*) sudo ln -sfn "$sysroot$dest" "$link" ;; esac
done
triple="$sysroot_arch-linux-gnu"
if [ ! -e "$sysroot/lib/$triple/libc.so.6" ]; then
  sudo mkdir -p "$sysroot/lib"
  sudo ln -sfn "../usr/lib/$triple" "$sysroot/lib/$triple"
fi
if [ "$sysroot_arch" = x86_64 ] && [ ! -e "$sysroot/lib64" ]; then
  sudo ln -sfn "usr/lib/$triple" "$sysroot/lib64"
fi

curl -fsSL "https://github.com/oven-sh/WebKit/releases/download/gcc-13-focal-debs/gcc-13-focal-$deb_arch.tar.gz" -o "$tmp/gcc13.tar.gz"
mkdir -p "$tmp/gcc13"
tar -xzf "$tmp/gcc13.tar.gz" -C "$tmp/gcc13"
for deb in "$tmp"/gcc13/*.deb; do
  sudo dpkg-deb -x "$deb" "$sysroot"
done
test -d "$sysroot/usr/include/c++/13"
rm -rf "$tmp"
echo "LINUX_GLIBC_SYSROOT=$sysroot" >> "$GITHUB_ENV"
