/** Choose one macOS signing identity per build; no signing secret reaches persistent storage. */
import { Config, Effect, FileSystem, Path, Redacted, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

/** The macOS section electron-builder needs for the chosen signing mode. */
export interface MacSigningConfiguration {
  readonly identity: string | null;
  readonly hardenedRuntime?: boolean;
  readonly gatekeeperAssess?: boolean;
  readonly entitlements?: string;
  readonly entitlementsInherit?: string;
  readonly notarize?: boolean;
  readonly signIgnore?: readonly string[];
}

/** One build's signing decision: the configuration and the environment it runs under. */
export interface MacSigning {
  readonly summary: string;
  readonly mac: MacSigningConfiguration;
  readonly env: Record<string, string>;
  /** Whether electron-builder should sign the disk images it assembles. */
  readonly signDiskImages: boolean;
  /** Work on the finished artifacts that electron-builder cannot do itself. */
  readonly finalize: (
    directory: string,
  ) => Effect.Effect<
    void,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  >;
}

/**
 * A deliberately unsigned build for development. Gatekeeper rejects the result
 * until someone overrides it by hand, so this is never a distributable artifact.
 */
export const unsignedMac: MacSigning = {
  summary: "unsigned (development)",
  mac: { identity: null },
  // Without this electron-builder signs with whatever identity the default
  // keychain happens to hold. An unsigned build must stay unsigned.
  env: { CSC_IDENTITY_AUTO_DISCOVERY: "false" },
  signDiskImages: false,
  finalize: () => Effect.void,
};

const security = "/usr/bin/security";
const notaryProfile = "executor-release";

/**
 * electron-builder signs every file it reads as binary, so a build otherwise
 * spends most of its signing time on Chromium's resource packs, the tarballs
 * the embedded database ships and similar payloads. None of these formats can
 * hold Mach-O code, and the bundle seal still covers them, so skipping them
 * leaves every executable, framework, dylib and native addon signed.
 */
const unsignableFormats = "\\.(pak|gz|wasm|woff2|nib|icns|png|gif|json|asar)$";

const randomHex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

const pemStream = (pem: Redacted.Redacted<string>) =>
  Stream.make(new TextEncoder().encode(`${Redacted.value(pem).trimEnd()}\n`));

const succeed = (
  command: string,
  args: readonly string[],
  describe: string,
  stdout: "ignore" | "inherit" = "ignore",
) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const code = yield* processes.exitCode(
      // Keychain commands print item attribute dumps nobody reads, so they stay
      // quiet. Failures go to stderr, and the exit code below is what actually
      // decides the outcome.
      ChildProcess.make(command, args, { stdout, stderr: "inherit" }),
    );
    if (code !== 0) yield* Effect.die(new Error(`${describe} failed (${command} exited ${code})`));
  });

/** The user search list, quoted one keychain per line by `security`. */
const userKeychains = Effect.gen(function* () {
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const lines = yield* processes.lines(
    ChildProcess.make(security, ["list-keychains", "-d", "user"]),
  );
  return lines.map((line) => line.trim().replace(/^"|"$/g, "")).filter((line) => line.length > 0);
});

/**
 * Hold the identity in a keychain of this build's own, deleted when the scope
 * closes. The default keychain keeps the identities it already had, and the
 * search list it belongs to is restored entry for entry when the build ends.
 */
const temporaryKeychain = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-macos-signing-" });
  yield* fs.chmod(directory, 0o700);
  const file = path.join(directory, "release.keychain-db");
  // Only this process ever needs the password, so it lives for one build.
  const password = randomHex(24);
  yield* Effect.acquireRelease(
    succeed(security, ["create-keychain", "-p", password, file], "Creating a signing keychain"),
    () =>
      succeed(security, ["delete-keychain", file], "Deleting the signing keychain").pipe(
        Effect.ignore,
      ),
  );
  // The default settings lock the keychain after five minutes, part-way through
  // a long build. An unlocked keychain is acceptable because it is this
  // build's own and is deleted with the scope.
  yield* succeed(security, ["set-keychain-settings", file], "Configuring the signing keychain");
  yield* succeed(security, ["unlock-keychain", "-p", password, file], "Unlocking the keychain");
  // codesign resolves an identity only from a keychain on the search list;
  // passing --keychain on its own finds nothing. Put this build's keychain in
  // front of the existing ones and then put the list back as it was. Two
  // signing builds at once would fight over this list, so run them one by one.
  const existing = yield* userKeychains;
  yield* Effect.acquireRelease(
    succeed(
      security,
      ["list-keychains", "-d", "user", "-s", file, ...existing],
      "Adding the signing keychain to the search list",
    ),
    () =>
      succeed(
        security,
        ["list-keychains", "-d", "user", "-s", ...existing],
        "Restoring the keychain search list",
      ).pipe(Effect.ignore),
  );
  return { directory, file, password };
});

/**
 * Convert the PEM pair into a PKCS#12 stream and import it. Both PEMs reach
 * `openssl` through private file descriptors and the PKCS#12 only ever exists
 * as a pipe between the two processes.
 */
const importIdentity = (keychain: { readonly file: string; readonly password: string }) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const key = yield* Config.Redacted("EXECUTOR_MAC_SIGNING_KEY");
    const certificate = yield* Config.Redacted("EXECUTOR_MAC_SIGNING_CERTIFICATE");
    // This password only protects the PKCS#12 while it is in flight between the
    // two processes below. `security import` takes it as an argument and has no
    // other input for it.
    const transfer = randomHex(24);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const openssl = yield* processes.spawn(
          ChildProcess.make(
            "/usr/bin/openssl",
            [
              "pkcs12",
              "-export",
              "-inkey",
              "/dev/fd/3",
              "-in",
              "/dev/fd/4",
              "-passout",
              "env:EXECUTOR_MAC_PKCS12_PASSWORD",
              "-name",
              "executor-developer-id",
            ],
            {
              env: { EXECUTOR_MAC_PKCS12_PASSWORD: transfer },
              extendEnv: true,
              stdin: "ignore",
              stdout: "pipe",
              stderr: "inherit",
              additionalFds: {
                fd3: { type: "input", stream: pemStream(key) },
                fd4: { type: "input", stream: pemStream(certificate) },
              },
            },
          ),
        );
        const imported = yield* processes.exitCode(
          ChildProcess.make(
            security,
            [
              "import",
              "/dev/stdin",
              "-k",
              keychain.file,
              "-f",
              "pkcs12",
              "-P",
              transfer,
              "-T",
              "/usr/bin/codesign",
            ],
            { stdin: openssl.stdout, stdout: "inherit", stderr: "inherit" },
          ),
        );
        const exported = yield* openssl.exitCode;
        if (exported !== 0)
          yield* Effect.die(
            new Error(`Reading the signing key failed (openssl exited ${exported})`),
          );
        if (imported !== 0)
          yield* Effect.die(
            new Error(`Importing the identity failed (security exited ${imported})`),
          );
      }),
    );
    // codesign runs as a separate process and would otherwise prompt for access
    // to the imported key.
    yield* succeed(
      security,
      [
        "set-key-partition-list",
        "-S",
        "apple-tool:,apple:,codesign:",
        "-s",
        "-k",
        keychain.password,
        keychain.file,
      ],
      "Allowing codesign to use the identity",
    );
    const lines = yield* processes.lines(
      ChildProcess.make(security, ["find-identity", "-v", "-p", "codesigning", keychain.file]),
    );
    const hashes = lines.flatMap((line) => {
      const match = /^\s*\d+\)\s+([0-9A-F]{40})\s/.exec(line);
      return match === null ? [] : match.slice(1, 2);
    });
    const [hash, ...extra] = hashes;
    if (hash === undefined || extra.length > 0)
      return yield* Effect.die(
        new Error(
          `Expected exactly one valid signing identity in the build keychain, found ${hashes.length}`,
        ),
      );
    // electron-builder matches the qualifier against a `security find-identity`
    // line, so the fingerprint identifies the certificate without repeating its
    // name and without the prefix electron-builder rejects.
    return hash;
  });

/**
 * notarytool opens its App Store Connect key only as a seekable file: a pipe on
 * stdin, on /dev/fd/3 and from process substitution were each refused. Give it
 * one on a volume that lives in memory, so the key never reaches persistent
 * storage, and take the volume away again as soon as it has been read.
 */
const memoryVolume = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const name = `executor-notary-${randomHex(8)}`;
  const device = yield* Effect.acquireRelease(
    processes
      .string(ChildProcess.make("/usr/bin/hdiutil", ["attach", "-nomount", "ram://2048"]))
      .pipe(Effect.map((output) => output.trim().split(/\s+/)[0] ?? "")),
    (device) =>
      // Ejecting unmounts the volume and releases the memory behind it.
      succeed("/usr/sbin/diskutil", ["eject", device], "Ejecting the notarization volume").pipe(
        Effect.ignore,
      ),
  );
  if (!/^\/dev\/disk\d+$/.test(device))
    return yield* Effect.die(new Error("hdiutil did not return a device for the memory volume"));
  yield* succeed(
    "/usr/sbin/diskutil",
    ["eraseVolume", "HFS+", name, device],
    "Preparing the notarization volume",
  );
  const directory = `/Volumes/${name}`;
  yield* fs.chmod(directory, 0o700);
  return directory;
});

/** Store the App Store Connect key as a notarytool profile in the build keychain. */
const storeNotaryCredentials = (keychain: { readonly file: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const key = yield* Config.Redacted("EXECUTOR_MAC_NOTARY_KEY");
    const keyId = yield* Config.String("EXECUTOR_MAC_NOTARY_KEY_ID");
    const issuer = yield* Config.String("EXECUTOR_MAC_NOTARY_ISSUER");
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = path.join(yield* memoryVolume, "key.p8");
        yield* fs.writeFileString(file, `${Redacted.value(key).trimEnd()}\n`, { mode: 0o600 });
        yield* succeed(
          "/usr/bin/xcrun",
          [
            "notarytool",
            "store-credentials",
            notaryProfile,
            "--key",
            file,
            "--key-id",
            keyId,
            "--issuer",
            issuer,
            "--keychain",
            keychain.file,
          ],
          "Storing the notarization credentials",
        );
      }),
    );
  });

/**
 * electron-builder notarizes the application it signs, but a disk image is a
 * separate distributable that Apple has never seen: Gatekeeper reads the image
 * itself when someone opens a download, not the bundle inside it. Submit each
 * image once it exists and staple the ticket so the image validates offline.
 */
const notarizeDiskImages = (keychain: { readonly file: string }, directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const names = yield* fs.readDirectory(directory);
    for (const name of names.filter((entry) => entry.endsWith(".dmg"))) {
      const image = path.join(directory, name);
      yield* succeed(
        "/usr/bin/xcrun",
        [
          "notarytool",
          "submit",
          image,
          "--keychain-profile",
          notaryProfile,
          "--keychain",
          keychain.file,
          "--wait",
        ],
        `Notarizing ${name}`,
        // The submission id belongs in the build log; it identifies the job to
        // Apple and is not a credential.
        "inherit",
      );
      yield* succeed("/usr/bin/xcrun", ["stapler", "staple", image], `Stapling ${name}`);
    }
    // Reading the directory and spawning are infrastructure, not a signing
    // decision; a failure here ends the build the same way `succeed` does.
  }).pipe(Effect.orDie);

/** Acquire signing credentials for one build; use its configuration and finalizer within this scope. */
export const developerIdMac = (options: {
  readonly entitlements: string;
  readonly notarize: boolean;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (process.platform !== "darwin")
      yield* Effect.die(new Error("Signing a macOS build requires macOS"));
    if (!(yield* fs.exists(options.entitlements)))
      yield* Effect.die(new Error(`Missing entitlements file ${options.entitlements}`));
    const keychain = yield* temporaryKeychain;
    const identity = yield* importIdentity(keychain);
    if (options.notarize) yield* storeNotaryCredentials(keychain);
    return {
      summary: options.notarize ? "Developer ID, notarized" : "Developer ID, not notarized",
      mac: {
        identity,
        hardenedRuntime: true,
        // Assessing an app Apple has not seen yet always fails; stapling is
        // what proves the result, and the build verifies that separately.
        gatekeeperAssess: false,
        entitlements: options.entitlements,
        entitlementsInherit: options.entitlements,
        notarize: options.notarize,
        signIgnore: [unsignableFormats],
      },
      env: {
        CSC_KEYCHAIN: keychain.file,
        // The identity is explicit, so nothing may be discovered.
        CSC_IDENTITY_AUTO_DISCOVERY: "false",
        ...(options.notarize
          ? { APPLE_KEYCHAIN: keychain.file, APPLE_KEYCHAIN_PROFILE: notaryProfile }
          : {}),
      },
      signDiskImages: true,
      finalize: (directory) =>
        options.notarize ? notarizeDiskImages(keychain, directory) : Effect.void,
    } satisfies MacSigning;
  });
