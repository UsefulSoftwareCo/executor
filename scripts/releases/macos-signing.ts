import { Config, Console, Effect, FileSystem, Option, Path, Redacted, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { fileURLToPath } from "node:url";
import { staple } from "./macos-staple.ts";

export interface MacSigningConfiguration {
  readonly identity: string | null;
  readonly hardenedRuntime?: boolean;
  readonly gatekeeperAssess?: boolean;
  readonly entitlements?: string;
  readonly entitlementsInherit?: string;
  readonly notarize?: boolean;
  readonly signIgnore?: readonly string[];
}

export interface MacSigning {
  readonly summary: string;
  readonly mac: MacSigningConfiguration;
  readonly env: Record<string, string>;
  readonly signDiskImages: boolean;
  readonly finalize: (
    directory: string,
  ) => Effect.Effect<
    void,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  >;
}

export const unsignedMac: MacSigning = {
  summary: "unsigned (development)",
  mac: { identity: null },
  env: { CSC_IDENTITY_AUTO_DISCOVERY: "false" },
  signDiskImages: false,
  finalize: () => Effect.void,
};

const security = "/usr/bin/security";
const notaryProfile = "executor-release";

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
      ChildProcess.make(command, args, { stdout, stderr: "inherit" }),
    );
    if (code !== 0)
      return yield* Effect.die(new Error(`${describe} failed (${command} exited ${code})`));
  });

const userKeychains = Effect.gen(function* () {
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const lines = yield* processes.lines(
    ChildProcess.make(security, ["list-keychains", "-d", "user"]),
  );
  return lines.map((line) => line.trim().replace(/^"|"$/g, "")).filter((line) => line.length > 0);
});

const temporaryKeychain = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-macos-signing-" });
  yield* fs.chmod(directory, 0o700);
  const file = path.join(directory, "release.keychain-db");
  const password = randomHex(24);
  yield* Effect.acquireRelease(
    succeed(security, ["create-keychain", "-p", password, file], "Creating a signing keychain"),
    () =>
      succeed(security, ["delete-keychain", file], "Deleting the signing keychain").pipe(
        Effect.ignore,
      ),
  );
  yield* succeed(security, ["set-keychain-settings", file], "Configuring the signing keychain");
  yield* succeed(security, ["unlock-keychain", "-p", password, file], "Unlocking the keychain");
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

const importIdentity = (keychain: { readonly file: string; readonly password: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const key = yield* Config.Redacted("EXECUTOR_MAC_SIGNING_KEY");
    const certificate = yield* Config.Redacted("EXECUTOR_MAC_SIGNING_CERTIFICATE");
    const transfer = randomHex(24);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const archive = path.join(yield* memoryVolume, "identity.p12");
        yield* fs.writeFile(archive, new Uint8Array(), { mode: 0o600 });
        const exported = yield* processes.exitCode(
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
              "-out",
              archive,
            ],
            {
              env: { EXECUTOR_MAC_PKCS12_PASSWORD: transfer },
              extendEnv: true,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "inherit",
              additionalFds: {
                fd3: { type: "input", stream: pemStream(key) },
                fd4: { type: "input", stream: pemStream(certificate) },
              },
            },
          ),
        );
        if (exported !== 0)
          return yield* Effect.die(
            new Error(`Reading the signing key failed (openssl exited ${exported})`),
          );
        const imported = yield* processes.exitCode(
          ChildProcess.make(
            security,
            [
              "import",
              archive,
              "-k",
              keychain.file,
              "-f",
              "pkcs12",
              "-P",
              transfer,
              "-T",
              "/usr/bin/codesign",
            ],
            { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
          ),
        );
        if (imported !== 0)
          return yield* Effect.die(
            new Error(`Importing the identity failed (security exited ${imported})`),
          );
      }),
    );
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
    return hash;
  });

const memoryVolume = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const name = `executor-signing-${randomHex(8)}`;
  const device = yield* Effect.acquireRelease(
    processes
      .string(ChildProcess.make("/usr/bin/hdiutil", ["attach", "-nomount", "ram://2048"]))
      .pipe(Effect.map((output) => output.trim().split(/\s+/)[0] ?? "")),
    (device) =>
      succeed("/usr/sbin/diskutil", ["eject", device], "Ejecting the signing volume").pipe(
        Effect.ignore,
      ),
  );
  if (!/^\/dev\/disk\d+$/.test(device))
    return yield* Effect.die(new Error("hdiutil did not return a device for the memory volume"));
  yield* succeed(
    "/usr/sbin/diskutil",
    ["eraseVolume", "HFS+", name, device],
    "Preparing the signing volume",
  );
  const directory = `/Volumes/${name}`;
  yield* fs.chmod(directory, 0o700);
  return directory;
});

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
        "inherit",
      );
      yield* staple(image);
    }
  }).pipe(Effect.orDie);

export const developerIdMac = (options: {
  readonly entitlements: string;
  readonly notarize: boolean;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (process.platform !== "darwin")
      return yield* Effect.die(new Error("Signing a macOS build requires macOS"));
    if (!(yield* fs.exists(options.entitlements)))
      return yield* Effect.die(new Error(`Missing entitlements file ${options.entitlements}`));
    const keychain = yield* temporaryKeychain;
    const identity = yield* importIdentity(keychain);
    if (options.notarize) yield* storeNotaryCredentials(keychain);
    return {
      summary: options.notarize ? "Developer ID, notarized" : "Developer ID, not notarized",
      mac: {
        identity,
        hardenedRuntime: true,
        gatekeeperAssess: false,
        entitlements: options.entitlements,
        entitlementsInherit: options.entitlements,
        notarize: options.notarize,
        signIgnore: [unsignableFormats],
      },
      env: {
        CSC_KEYCHAIN: keychain.file,
        CSC_IDENTITY_AUTO_DISCOVERY: "false",
        ...(options.notarize
          ? {
              APPLE_KEYCHAIN: keychain.file,
              APPLE_KEYCHAIN_PROFILE: notaryProfile,
              EXECUTOR_STAPLE_SCRIPT: fileURLToPath(new URL("./staple.ts", import.meta.url)),
            }
          : {}),
      },
      signDiskImages: true,
      finalize: (directory) =>
        options.notarize ? notarizeDiskImages(keychain, directory) : Effect.void,
    } satisfies MacSigning;
  });

const machOMagic = new Set([
  "feedface",
  "feedfacf",
  "cefaedfe",
  "cffaedfe",
  "cafebabe",
  "bebafeca",
]);

export const standaloneIdentifier = "com.usefulsoftware.executor.v2.cli";

export const signStandaloneMac = (
  install: string,
  executable: string,
  options: {
    readonly entitlements: string;
    readonly notarize: boolean;
    readonly submission?: string;
  },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      if (process.platform !== "darwin")
        return yield* Effect.die(new Error("Signing a macOS build requires macOS"));
      const keychain = yield* temporaryKeychain;
      const identity = yield* importIdentity(keychain);
      const files: Array<{ readonly file: string; readonly executable: boolean }> = [];
      for (const relative of yield* fs.readDirectory(install, { recursive: true })) {
        const file = path.join(install, relative);
        const info = yield* fs.stat(file);
        if (info.type !== "File" || file === executable) continue;
        const head = yield* Effect.scoped(
          Effect.flatMap(fs.open(file), (handle) => handle.readAlloc(4)),
        );
        if (Option.isNone(head) || head.value.length < 4) continue;
        if (!machOMagic.has(Buffer.from(head.value).toString("hex"))) continue;
        files.push({
          file,
          executable: (info.mode & 0o111) !== 0 && !/\.(node|dylib|so)$/u.test(file),
        });
      }
      files.sort(
        (left, right) => right.file.split(path.sep).length - left.file.split(path.sep).length,
      );
      const sign = (file: string, extra: ReadonlyArray<string>) =>
        succeed(
          "/usr/bin/codesign",
          [
            "--force",
            "--sign",
            identity,
            "--keychain",
            keychain.file,
            "--options",
            "runtime",
            "--timestamp",
            ...extra,
            file,
          ],
          `Signing ${path.relative(install, file)}`,
        );
      for (const entry of files)
        yield* sign(entry.file, entry.executable ? ["--entitlements", options.entitlements] : []);
      yield* sign(executable, [
        "--identifier",
        standaloneIdentifier,
        "--entitlements",
        options.entitlements,
      ]);
      for (const file of [executable, ...files.map((entry) => entry.file)])
        yield* succeed(
          "/usr/bin/codesign",
          ["--verify", "--strict", file],
          `Verifying ${path.relative(install, file)}`,
        );
      yield* Console.log(`Signed ${files.length + 1} Mach-O files in ${install}`);
      if (!options.notarize) return;
      yield* storeNotaryCredentials(keychain);
      const archive = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "executor-notarize-" }),
        "executor.zip",
      );
      yield* succeed(
        "/usr/bin/ditto",
        ["-c", "-k", "--keepParent", install, archive],
        "Archiving the install for notarization",
      );
      const report = yield* processes.string(
        ChildProcess.make("/usr/bin/xcrun", [
          "notarytool",
          "submit",
          archive,
          "--keychain-profile",
          notaryProfile,
          "--keychain",
          keychain.file,
          ...(options.submission === undefined ? ["--wait"] : []),
          "--output-format",
          "json",
        ]),
      );
      yield* Console.log(`Notarization: ${report.trim()}`);
      if (options.submission !== undefined) {
        const id = /"id"\s*:\s*"([0-9a-f-]+)"/u.exec(report)?.[1];
        if (id === undefined)
          return yield* Effect.die(new Error("Apple returned no notarization submission id"));
        yield* fs.writeFileString(options.submission, id);
        return;
      }
      const status = /"status"\s*:\s*"([^"]+)"/u.exec(report)?.[1];
      if (status !== "Accepted")
        return yield* Effect.die(new Error(`Apple did not accept the install: ${status}`));
    }),
  ).pipe(Effect.orDie);

export const waitForNotarization = (file: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      if (process.platform !== "darwin")
        return yield* Effect.die(new Error("Notarization runs on macOS"));
      const id = (yield* fs.readFileString(file)).trim();
      if (!/^[0-9a-f-]+$/u.test(id))
        return yield* Effect.die(new Error(`${file} holds no notarization submission id`));
      const keychain = yield* temporaryKeychain;
      yield* storeNotaryCredentials(keychain);
      const report = yield* processes.string(
        ChildProcess.make("/usr/bin/xcrun", [
          "notarytool",
          "wait",
          id,
          "--keychain-profile",
          notaryProfile,
          "--keychain",
          keychain.file,
          "--output-format",
          "json",
        ]),
      );
      yield* Console.log(`Notarization: ${report.trim()}`);
      const status = /"status"\s*:\s*"([^"]+)"/u.exec(report)?.[1];
      if (status !== "Accepted")
        return yield* Effect.die(new Error(`Apple did not accept the install: ${status}`));
    }),
  ).pipe(Effect.orDie);
