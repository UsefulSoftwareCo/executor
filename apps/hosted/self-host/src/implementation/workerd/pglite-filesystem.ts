/** PostgreSQL filesystem adapter backed by the actor's durable SQLite connection. */
import { BaseFilesystem, ERRNO_CODES, type FsStats } from "@electric-sql/pglite/basefs";
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { Schema } from "effect";
import { posix } from "node:path";

const blockSize = 8192;
const directoryMode = 0o040000;
const fileMode = 0o100000;
const Entry = Schema.Struct({
  inode: Schema.Int,
  path: Schema.NullOr(Schema.String),
  mode: Schema.Int,
  size: Schema.Int,
  atime: Schema.Number,
  mtime: Schema.Number,
  ctime: Schema.Number,
});
type Entry = typeof Entry.Type;
const decodeEntry = Schema.decodeUnknownSync(Entry);
const Block = Schema.Struct({
  data: Schema.declare((value): value is ArrayBuffer => value instanceof ArrayBuffer),
});
const decodeBlock = Schema.decodeUnknownSync(Block);

/** Emscripten's filesystem boundary expects numeric errno in the code field. */
class FilesystemError extends Error {
  constructor(readonly code: number) {
    super("PostgreSQL filesystem operation failed");
  }
}
const fail = (code: number): never => {
  throw new FilesystemError(code);
};
const normalize = (path: string) => posix.resolve("/", path);
const isDirectory = (entry: Entry) => (entry.mode & 0o170000) === directoryMode;
const checkInteger = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) fail(ERRNO_CODES.EINVAL);
};

/**
 * Keep PostgreSQL's file bytes and WAL intact while SQLite owns atomic disk writes.
 * The caller must own the sole PGlite engine for this actor. Descriptors identify
 * inodes, so rename and unlink preserve already-open files. Acknowledged database
 * commits call syncToFs(), which awaits workerd's durable storage barrier.
 */
export class PgliteFilesystem extends BaseFilesystem {
  readonly #storage: DurableObjectStorage;
  readonly #descriptors = new Map<number, number>();
  #nextDescriptor = 3;

  constructor(storage: DurableObjectStorage) {
    super();
    this.#storage = storage;
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS executor_pg_files (
        inode INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE,
        mode INTEGER NOT NULL,
        size INTEGER NOT NULL,
        atime REAL NOT NULL,
        mtime REAL NOT NULL,
        ctime REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS executor_pg_blocks (
        inode INTEGER NOT NULL,
        block INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (inode, block)
      );
    `);
    storage.transactionSync(() => {
      // Open descriptors cannot survive actor replacement. Reclaim files unlinked
      // by the previous engine, without touching named PostgreSQL files.
      storage.sql.exec(`DELETE FROM executor_pg_blocks WHERE inode IN
        (SELECT inode FROM executor_pg_files WHERE path IS NULL)`);
      storage.sql.exec("DELETE FROM executor_pg_files WHERE path IS NULL");
      this.mkdir("/", { recursive: true });
    });
  }

  /** Clear an unfinished bootstrap before retrying. Never call this on an opened engine. */
  resetBootstrap(): void {
    if (this.#descriptors.size !== 0) throw new Error("Cannot reset an open PostgreSQL filesystem");
    this.#storage.transactionSync(() => {
      this.#storage.sql.exec("DELETE FROM executor_pg_blocks; DELETE FROM executor_pg_files;");
      this.mkdir("/", { recursive: true });
    });
  }

  #find(path: string): Entry | undefined {
    const row = this.#storage.sql
      .exec("SELECT * FROM executor_pg_files WHERE path = ?", normalize(path))
      .toArray()[0];
    return row === undefined ? undefined : decodeEntry(row);
  }
  #entry(path: string): Entry {
    return this.#find(path) ?? fail(ERRNO_CODES.ENOENT);
  }
  #inode(inode: number): Entry {
    const row = this.#storage.sql
      .exec("SELECT * FROM executor_pg_files WHERE inode = ?", inode)
      .toArray()[0];
    return row === undefined ? fail(ERRNO_CODES.EBADF) : decodeEntry(row);
  }
  #descriptor(descriptor: number): Entry {
    const inode = this.#descriptors.get(descriptor);
    return inode === undefined ? fail(ERRNO_CODES.EBADF) : this.#inode(inode);
  }
  #parent(path: string): void {
    if (!isDirectory(this.#entry(posix.dirname(normalize(path))))) fail(ERRNO_CODES.ENOTDIR);
  }
  #create(path: string, mode: number): Entry {
    const now = Date.now();
    this.#storage.sql.exec(
      "INSERT INTO executor_pg_files(path, mode, size, atime, mtime, ctime) VALUES (?, ?, 0, ?, ?, ?)",
      normalize(path),
      mode,
      now,
      now,
      now,
    );
    return this.#entry(path);
  }
  #bytes(inode: number, block: number): Uint8Array {
    const row = this.#storage.sql
      .exec("SELECT data FROM executor_pg_blocks WHERE inode = ? AND block = ?", inode, block)
      .toArray()[0];
    return row === undefined ? new Uint8Array(blockSize) : new Uint8Array(decodeBlock(row).data);
  }
  #remove(entry: Entry): void {
    if ([...this.#descriptors.values()].includes(entry.inode)) {
      this.#storage.sql.exec(
        "UPDATE executor_pg_files SET path = NULL WHERE inode = ?",
        entry.inode,
      );
    } else {
      this.#storage.sql.exec("DELETE FROM executor_pg_blocks WHERE inode = ?", entry.inode);
      this.#storage.sql.exec("DELETE FROM executor_pg_files WHERE inode = ?", entry.inode);
    }
  }
  #stats(entry: Entry): FsStats {
    return {
      dev: 1,
      ino: entry.inode,
      mode: entry.mode,
      nlink: entry.path === null ? 0 : 1,
      uid: 1000,
      gid: 1000,
      rdev: 0,
      size: entry.size,
      blksize: blockSize,
      blocks: Math.ceil(entry.size / 512),
      atime: entry.atime,
      mtime: entry.mtime,
      ctime: entry.ctime,
    };
  }

  /** Change permission bits without changing the file type. */
  override chmod(path: string, mode: number): void {
    const entry = this.#entry(path);
    this.#storage.sql.exec(
      "UPDATE executor_pg_files SET mode = ?, ctime = ? WHERE inode = ?",
      (entry.mode & 0o170000) | (mode & 0o7777),
      Date.now(),
      entry.inode,
    );
  }
  /** Release a descriptor and reclaim an unlinked inode after its last close. */
  override close(descriptor: number): void {
    const entry = this.#descriptor(descriptor);
    this.#descriptors.delete(descriptor);
    if (entry.path === null) this.#storage.transactionSync(() => this.#remove(entry));
  }
  /** Read metadata through a descriptor, including a renamed or unlinked file. */
  override fstat(descriptor: number): FsStats {
    return this.#stats(this.#descriptor(descriptor));
  }
  /** Read metadata for a named entry. Symbolic links are deliberately unsupported. */
  override lstat(path: string): FsStats {
    return this.#stats(this.#entry(path));
  }

  /** Create a directory; recursive creation accepts only existing directories. */
  override mkdir(path: string, options: { recursive?: boolean; mode?: number } = {}): void {
    const normalized = normalize(path);
    this.#storage.transactionSync(() => {
      const existing = this.#find(normalized);
      if (existing !== undefined) {
        if (!isDirectory(existing)) fail(ERRNO_CODES.ENOTDIR);
        if (!options.recursive) fail(ERRNO_CODES.EEXIST);
        return;
      }
      if (normalized !== "/") {
        if (options.recursive) this.mkdir(posix.dirname(normalized), options);
        this.#parent(normalized);
      }
      this.#create(normalized, directoryMode | (options.mode ?? 0o700));
    });
  }

  /** Open an inode. Emscripten creates and truncates files before its default r+ open. */
  override open(path: string, flags = "r+", mode = 0o600): number {
    return this.#storage.transactionSync(() => {
      let entry = this.#find(path);
      if (entry === undefined) {
        if (!/^[wa]/.test(flags)) return fail(ERRNO_CODES.ENOENT);
        this.#parent(path);
        entry = this.#create(path, fileMode | mode);
      } else if (flags.includes("x")) return fail(ERRNO_CODES.EEXIST);
      if (isDirectory(entry)) return fail(ERRNO_CODES.EISDIR);
      if (flags.startsWith("w")) this.truncate(path, 0);
      const descriptor = this.#nextDescriptor++;
      this.#descriptors.set(descriptor, entry.inode);
      return descriptor;
    });
  }

  /** Return direct children only; SQL glob syntax never interprets a file name. */
  override readdir(path: string): string[] {
    const normalized = normalize(path);
    if (!isDirectory(this.#entry(normalized))) return fail(ERRNO_CODES.ENOTDIR);
    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    return this.#storage.sql
      .exec("SELECT * FROM executor_pg_files WHERE substr(path, 1, ?) = ?", prefix.length, prefix)
      .toArray()
      .map((row) => decodeEntry(row))
      .flatMap((entry) => {
        if (entry.path === null) return [];
        const relative = entry.path.slice(prefix.length);
        return relative.length === 0 || relative.includes("/") ? [] : [relative];
      });
  }

  /** Read sparse file blocks, returning zeroes for holes and stopping at EOF. */
  override read(
    descriptor: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number {
    const entry = this.#descriptor(descriptor);
    for (const value of [offset, length, position]) checkInteger(value);
    if (offset + length > buffer.byteLength) return fail(ERRNO_CODES.EINVAL);
    const count = Math.max(0, Math.min(length, entry.size - position));
    for (let read = 0; read < count;) {
      const location = position + read;
      const within = location % blockSize;
      const size = Math.min(blockSize - within, count - read);
      buffer.set(
        this.#bytes(entry.inode, Math.floor(location / blockSize)).subarray(within, within + size),
        offset + read,
      );
      read += size;
    }
    return count;
  }

  /** Write a range atomically. PGlite's current bridge passes the backing ArrayBuffer. */
  override write(
    descriptor: number,
    input: Uint8Array | ArrayBuffer,
    offset: number,
    length: number,
    position: number,
  ): number {
    const entry = this.#descriptor(descriptor);
    const buffer = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
    for (const value of [offset, length, position, position + length]) checkInteger(value);
    if (offset + length > buffer.byteLength) return fail(ERRNO_CODES.EINVAL);
    if (length === 0) return 0;
    this.#storage.transactionSync(() => {
      for (let written = 0; written < length;) {
        const location = position + written;
        const block = Math.floor(location / blockSize);
        const within = location % blockSize;
        const size = Math.min(blockSize - within, length - written);
        const data = this.#bytes(entry.inode, block);
        data.set(buffer.subarray(offset + written, offset + written + size), within);
        this.#storage.sql.exec(
          "INSERT OR REPLACE INTO executor_pg_blocks VALUES (?, ?, ?)",
          entry.inode,
          block,
          data,
        );
        written += size;
      }
      this.#storage.sql.exec(
        "UPDATE executor_pg_files SET size = max(size, ?), mtime = ?, ctime = ? WHERE inode = ?",
        position + length,
        Date.now(),
        Date.now(),
        entry.inode,
      );
    });
    return length;
  }

  /** Replace a complete file. The descriptor is closed even if a write fails. */
  override writeFile(
    path: string,
    data: string | Uint8Array,
    options: { encoding?: string; mode?: number; flag?: string } = {},
  ): void {
    if (options.encoding !== undefined && !["utf8", "utf-8"].includes(options.encoding))
      fail(ERRNO_CODES.EINVAL);
    this.#storage.transactionSync(() => {
      const buffer = typeof data === "string" ? new TextEncoder().encode(data) : data;
      const descriptor = this.open(path, options.flag ?? "w", options.mode);
      try {
        this.write(
          descriptor,
          buffer,
          0,
          buffer.byteLength,
          options.flag?.startsWith("a") ? this.fstat(descriptor).size : 0,
        );
      } finally {
        this.close(descriptor);
      }
    });
  }

  /** Resize a file, zeroing truncated bytes so later extension cannot reveal old data. */
  override truncate(path: string, length: number): void {
    checkInteger(length);
    const entry = this.#entry(path);
    if (isDirectory(entry)) fail(ERRNO_CODES.EISDIR);
    this.#storage.transactionSync(() => {
      this.#storage.sql.exec(
        "DELETE FROM executor_pg_blocks WHERE inode = ? AND block >= ?",
        entry.inode,
        Math.ceil(length / blockSize),
      );
      if (length % blockSize !== 0 && length < entry.size) {
        const block = Math.floor(length / blockSize);
        const data = this.#bytes(entry.inode, block);
        data.fill(0, length % blockSize);
        this.#storage.sql.exec(
          "INSERT OR REPLACE INTO executor_pg_blocks VALUES (?, ?, ?)",
          entry.inode,
          block,
          data,
        );
      }
      this.#storage.sql.exec(
        "UPDATE executor_pg_files SET size = ?, mtime = ?, ctime = ? WHERE inode = ?",
        length,
        Date.now(),
        Date.now(),
        entry.inode,
      );
    });
  }

  /** Atomically rename a file or subtree while preserving open descriptors. */
  override rename(from: string, to: string): void {
    const source = normalize(from),
      destination = normalize(to);
    if (source === destination) {
      this.#entry(source);
      return;
    }
    if (source === "/" || destination === "/" || destination.startsWith(`${source}/`))
      fail(ERRNO_CODES.EINVAL);
    this.#storage.transactionSync(() => {
      const entry = this.#entry(source);
      this.#parent(destination);
      const existing = this.#find(destination);
      if (existing !== undefined) {
        if (isDirectory(existing) !== isDirectory(entry))
          fail(isDirectory(existing) ? ERRNO_CODES.EISDIR : ERRNO_CODES.ENOTDIR);
        if (isDirectory(existing) && this.readdir(destination).length > 0)
          fail(ERRNO_CODES.ENOTEMPTY);
        this.#remove(existing);
      }
      const prefix = `${source}/`;
      this.#storage.sql.exec(
        "UPDATE executor_pg_files SET path = ? || substr(path, ?), ctime = ? WHERE path = ? OR substr(path, 1, ?) = ?",
        destination,
        source.length + 1,
        Date.now(),
        source,
        prefix.length,
        prefix,
      );
    });
  }

  /** Remove an empty directory. */
  override rmdir(path: string): void {
    const entry = this.#entry(path);
    if (normalize(path) === "/") fail(ERRNO_CODES.EINVAL);
    if (this.readdir(path).length > 0) fail(ERRNO_CODES.ENOTEMPTY);
    this.#storage.transactionSync(() => this.#remove(entry));
  }
  /** Unlink a file; existing descriptors remain usable until closed. */
  override unlink(path: string): void {
    const entry = this.#entry(path);
    if (isDirectory(entry)) fail(ERRNO_CODES.EISDIR);
    this.#storage.transactionSync(() => this.#remove(entry));
  }
  /** Preserve timestamps supplied by PostgreSQL and imported files. */
  override utimes(path: string, atime: number, mtime: number): void {
    const entry = this.#entry(path);
    this.#storage.sql.exec(
      "UPDATE executor_pg_files SET atime = ?, mtime = ?, ctime = ? WHERE inode = ?",
      atime,
      mtime,
      Date.now(),
      entry.inode,
    );
  }
  /** Wait until workerd has persisted all acknowledged PostgreSQL writes. */
  override async syncToFs(): Promise<void> {
    await this.#storage.sync();
  }
}
