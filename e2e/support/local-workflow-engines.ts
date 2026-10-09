/**
 * A dedicated local product process and a view of the workflow engines its workerd holds.
 *
 * Local and desktop run every workflow run as its own Engine durable object in the product's
 * workerd process. A loaded engine keeps its SQLite database open; the namespace's own
 * metadata database stays open while the process runs.
 */
import { Effect, FileSystem, Option, Path, Redacted, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { startManagedServer } from "./managed-server.ts";
import { driver, Target } from "./platform.ts";
import { freePort } from "./ports.ts";

/** The engine namespace's storage directory below the product's data directory. */
const engineDirectory = ["data", "workerd", "workflows", "executor-app-workflows"];

/** Start a local product with its own data, so its engines are the only ones counted. */
export const startLocalProduct = (environment: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const target = yield* Target;
    const directory = yield* fs.makeTempDirectory({
      directory: target.directory,
      prefix: "engines-",
    });
    const port = yield* freePort;
    const server = yield* startManagedServer(
      {
        ...target,
        directory,
        metadata: { ...target.metadata, origin: `http://127.0.0.1:${port}`, target: "local" },
      },
      "product",
      environment,
    );
    const request = (method: "GET" | "POST", route: string, data?: unknown) =>
      driver(`${method} ${route}`, (signal) =>
        fetch(`${server.origin}${route}`, {
          method,
          signal,
          headers: {
            authorization: `Bearer ${Redacted.value(target.apiKey)}`,
            "content-type": "application/json",
          },
          ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        }),
      ).pipe(
        Effect.flatMap((response) =>
          driver(`read ${route}`, () => response.text()).pipe(
            Effect.map((text) => ({ status: response.status, text })),
          ),
        ),
      );
    const json = <S extends Schema.Top>(
      schema: S,
      method: "GET" | "POST",
      route: string,
      data?: unknown,
    ) =>
      request(method, route, data).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(response.text)
            : Effect.fail(new Error(`${route}: HTTP ${response.status} ${response.text}`)),
        ),
      );
    return { directory: yield* fs.realPath(directory), json };
  });

/** Files each process holds open, and its executable when the platform reports it. */
type OpenFiles = ReadonlyMap<
  string,
  { readonly names: Set<string>; executable?: string | undefined }
>;

/** Every file workerd processes hold open, read with lsof. */
const openFilesFromLsof = Effect.gen(function* () {
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  // -F prints one field per line: p<pid>, f<descriptor>, n<name>.
  const output = yield* processes.string(
    ChildProcess.make("lsof", ["-n", "-P", "-w", "-F", "pfn", "-c", "workerd"]),
  );
  const byProcess = new Map<string, { names: Set<string>; executable?: string }>();
  let current: { names: Set<string>; executable?: string } | undefined;
  let descriptor = "";
  for (const line of output.split("\n")) {
    const value = line.slice(1);
    if (line.startsWith("p")) {
      current = { names: new Set() };
      byProcess.set(value, current);
    } else if (line.startsWith("f")) descriptor = value;
    else if (line.startsWith("n") && current !== undefined) {
      if (/^\d+$/.test(descriptor)) current.names.add(value);
      if (descriptor === "txt" && path.basename(value) === "workerd") current.executable = value;
    }
  }
  return byProcess satisfies OpenFiles;
});

/**
 * Windows has no lsof. Windows reports which processes hold a file open, whatever share mode
 * they opened it with, through `FileProcessIdsUsingFile`; this asks it about each of `files`.
 * The Restart Manager asks the same question but refuses paths longer than 260 characters,
 * which engine databases below the test directory exceed.
 */
const windowsHolders = `$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;
public static class FileUsers {
  [StructLayout(LayoutKind.Sequential)] struct IoStatus { public IntPtr Status; public IntPtr Information; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationFile(SafeFileHandle file, out IoStatus status, IntPtr info, uint length, int infoClass);
  public static long[] Holders(string file) {
    // Attribute access with every share mode never conflicts with the holder's own handle.
    using (var handle = CreateFileW(@"\\\\?\\" + file, 0x80, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if (handle.IsInvalid) {
        int error = Marshal.GetLastWin32Error();
        if (error == 2) return new long[0];
        throw new Exception("CreateFile " + error + " " + file);
      }
      for (int size = 4096; ; size *= 2) {
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
          IoStatus status;
          // 47 is FileProcessIdsUsingFile; 0xC0000004 means the buffer is too small.
          int code = NtQueryInformationFile(handle, out status, buffer, (uint)size, 47);
          if (code == unchecked((int)0xC0000004)) continue;
          if (code != 0) throw new Exception("NtQueryInformationFile 0x" + code.ToString("X") + " " + file);
          long count = Marshal.ReadIntPtr(buffer).ToInt64();
          var ids = new long[count];
          for (int i = 0; i < count; i++) ids[i] = Marshal.ReadIntPtr(buffer, IntPtr.Size * (i + 1)).ToInt64();
          return ids;
        } finally { Marshal.FreeHGlobal(buffer); }
      }
    }
  }
}
"@
$names = @{}
foreach ($file in (ConvertFrom-Json $env:ENGINE_FILES)) {
  foreach ($id in [FileUsers]::Holders($file)) {
    if (-not $names.ContainsKey($id)) { $names[$id] = New-Object System.Collections.Generic.List[string] }
    $names[$id].Add($file)
  }
}
$held = @(foreach ($id in $names.Keys) {
  # Another holder, such as a scanner, may exit or deny access before its path is read.
  $executable = $null
  try { $executable = (Get-Process -Id $id -ErrorAction Stop).Path } catch {}
  @{ pid = [string]$id; executable = $executable; names = @($names[$id]) }
})
ConvertTo-Json -Compress -Depth 4 -InputObject $held
`;

const WindowsHolders = Schema.Array(
  Schema.Struct({
    pid: Schema.String,
    executable: Schema.NullOr(Schema.String),
    names: Schema.Array(Schema.String),
  }),
);

/** The processes holding each of `files` open, read from Windows. */
const openFilesFromWindows = (files: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* processes.spawn(
          ChildProcess.make(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-EncodedCommand",
              Buffer.from(windowsHolders, "utf16le").toString("base64"),
            ],
            // The list goes through the environment, which has room for many long paths.
            { env: { ENGINE_FILES: JSON.stringify(files) }, extendEnv: true },
          ),
        );
        return yield* Effect.all(
          {
            stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
            stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
            exitCode: child.exitCode,
          },
          { concurrency: "unbounded" },
        );
      }),
    );
    // A failed query must not read as no process holding the namespace.
    if (result.exitCode !== 0)
      return yield* Effect.fail(
        new Error(`Open file query exited ${result.exitCode}: ${result.stderr.trim()}`),
      );
    const held = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(WindowsHolders))(
      result.stdout,
    );
    return new Map(
      held.map((entry) => [
        entry.pid,
        { names: new Set(entry.names), executable: entry.executable ?? undefined },
      ]),
    ) satisfies OpenFiles;
  });

/**
 * The workerd process that serves `directory`'s workflow engines: its executable and the
 * engine databases it holds open. Fails when no workerd holds the namespace's metadata
 * database, so a missing process or a missing inspector can never read as zero engines.
 */
export const workflowEngines = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const namespace = path.join(directory, ...engineDirectory);
    const metadata = path.join(namespace, "metadata.sqlite");
    const databases = (yield* fs.readDirectory(namespace))
      .filter((name) => name.endsWith(".sqlite"))
      .map((name) => path.join(namespace, name));
    const open =
      process.platform === "win32"
        ? yield* openFilesFromWindows(databases)
        : yield* openFilesFromLsof;
    const holder = [...open.values()].find((entry) => entry.names.has(metadata));
    if (holder === undefined)
      return yield* Effect.fail(new Error(`No workerd process holds ${metadata}`));
    return {
      executable: Option.fromNullishOr(holder.executable),
      loaded: [...holder.names].filter(
        (name) => path.dirname(name) === namespace && name.endsWith(".sqlite") && name !== metadata,
      ).length,
    };
  });
