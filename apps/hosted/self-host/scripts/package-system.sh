#!/bin/sh
# Package the native Git server and startup tools, without Debian's Perl tooling.
set -eu

mkdir -p /runtime/usr/bin /runtime/usr/lib/git-core /runtime/usr/local/bin \
  /runtime/bin /runtime/etc /runtime/app/data /runtime/app/motel-data /runtime/home/executor

# Keep GNU utility behavior for volume setup and the Docker release checks.
for executable in /bin/dash /usr/bin/cat /usr/bin/chmod /usr/bin/chown /usr/bin/id /usr/bin/mkdir /usr/bin/rm /usr/bin/stat /usr/bin/git /usr/lib/git-core/git-http-backend; do
  cp --parents --dereference "$executable" /runtime
  dependencies=$(ldd "$executable")
  case "$dependencies" in
    *"not found"*) echo "Missing shared library for $executable" >&2; exit 1 ;;
  esac
  for library in $(printf '%s\n' "$dependencies" | awk '$2 == "=>" { print $3 } $1 ~ /^\// { print $1 }'); do
    cp --parents --dereference "$library" /runtime
  done
done

# gosu is static. Git's other required commands are built into the main executable.
cp /usr/sbin/gosu /runtime/usr/bin/gosu
ln -s dash /runtime/bin/sh
ln -s ../../bin/git /runtime/usr/lib/git-core/git
ln -s git /runtime/usr/lib/git-core/git-upload-pack
ln -s git /runtime/usr/lib/git-core/git-receive-pack

# Preserve the existing volume identity and root-start/privilege-drop behavior.
printf 'root:x:0:0:root:/root:/bin/sh\nexecutor:x:1000:1000:Executor:/home/executor:/bin/sh\n' > /runtime/etc/passwd
printf 'root:x:0:\nexecutor:x:1000:\n' > /runtime/etc/group
chown 1000:1000 /runtime/app/data /runtime/app/motel-data /runtime/home/executor
chmod 700 /runtime/app/data /runtime/app/motel-data

# Keep attribution and exact package versions for the copied system components.
set -- git gosu dash coreutils libc6 libpcre2-8-0 zlib1g libselinux1
for package in "$@"; do
  cp --parents --dereference "/usr/share/doc/$package/copyright" /runtime
done
cp --parents -r /usr/share/common-licenses /runtime
dpkg-query -W -f='${Package}\t${Version}\n' "$@" > /runtime/usr/share/runtime-system-packages.txt
