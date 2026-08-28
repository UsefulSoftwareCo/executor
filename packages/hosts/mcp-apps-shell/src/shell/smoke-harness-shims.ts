/**
 * Host primitives QuickJS does not have, installed before anything else loads.
 *
 * Its own module, and imported FIRST by the harness entry, because that is the
 * only way to win the ordering race: a bundler hoists every import's
 * initialisation above the importing module's own statements, so React's
 * server renderer would otherwise reach for `MessageChannel` at module scope —
 * while it is still undefined — no matter where the install call sat in the
 * entry file. Side-effect module, imported for its ordering.
 *
 * QuickJS is a bare ECMAScript engine: no `MessageChannel`, `TextEncoder` or
 * `ReadableStream`. React's server renderer reaches for all three. They are
 * shimmed here rather than pulled in as polyfill packages because what is
 * needed is small, exactly specified by one consumer, and better read than
 * audited: every one of them is inert with respect to the outside world.
 *
 * The scheduling shims deliberately collapse onto the microtask queue. A
 * one-shot server render has nothing to yield to, and the host drives the
 * sandbox by draining pending jobs — so making `setTimeout` and
 * `MessageChannel` microtasks means the host needs no bespoke drain hook and
 * the render cannot stall waiting for a timer nobody will fire.
 *
 * Each shim installs only if absent, so this same bundle runs unchanged under a
 * runtime that already has them.
 */

/**
 * The sandbox's global object, as a bag of names.
 *
 * Typed this way on purpose. These shims are deliberately PARTIAL — the slice
 * of each primitive that React's server renderer actually touches, and no more
 * — so checking them against the full DOM/Node declarations would demand
 * `pipeThrough`, `tee`, `__promisify__` and a dozen other members that nothing
 * here calls and that could only be implemented as lies. The honest shape for
 * "install a name on a global that does not have it" is an index signature,
 * and the assertion is contained to this one line rather than sprayed across
 * every install site.
 */
const sandboxGlobal = globalThis as unknown as Record<string, unknown>;

/** Queue a callback as a microtask. The one scheduling primitive everything
 *  else here is built from; QuickJS drains microtasks when the host asks it to. */
const asMicrotask = (callback: () => void): void => {
  void Promise.resolve().then(() => {
    // A throw here would become an unhandled rejection and tell nobody
    // anything: React reports render failures through `onError`, which is what
    // the result is built from.
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: a scheduler callback has no caller to throw to
    try {
      callback();
    } catch {
      /* reported through onError instead */
    }
  });
};

const installSchedulingShims = (): void => {
  if (typeof sandboxGlobal["setTimeout"] === "undefined") {
    // The delay is dropped on purpose. Nothing in a one-shot render should
    // depend on wall-clock ordering, and a real timer would need a real event
    // loop the sandbox does not have.
    sandboxGlobal["setTimeout"] = (callback: () => void): number => {
      asMicrotask(callback);
      return 0;
    };
    sandboxGlobal["clearTimeout"] = (): void => {};
    sandboxGlobal["setInterval"] = (): number => 0;
    sandboxGlobal["clearInterval"] = (): void => {};
  }
  if (typeof sandboxGlobal["setImmediate"] === "undefined") {
    sandboxGlobal["setImmediate"] = (callback: () => void): number => {
      asMicrotask(callback);
      return 0;
    };
  }
  if (typeof sandboxGlobal["queueMicrotask"] === "undefined") {
    sandboxGlobal["queueMicrotask"] = asMicrotask;
  }
  if (typeof sandboxGlobal["MessageChannel"] === "undefined") {
    // React's scheduler uses a MessageChannel to yield between units of work.
    // Delivering on the microtask queue keeps that loop running without a task
    // queue behind it.
    sandboxGlobal["MessageChannel"] = class {
      readonly port1: { onmessage: ((event: { data: unknown }) => void) | null; close: () => void };
      readonly port2: { postMessage: (data: unknown) => void; close: () => void };
      constructor() {
        let onmessage: ((event: { data: unknown }) => void) | null = null;
        this.port1 = {
          get onmessage() {
            return onmessage;
          },
          set onmessage(handler) {
            onmessage = handler;
          },
          close: () => {},
        };
        this.port2 = {
          postMessage: (data: unknown) => {
            asMicrotask(() => onmessage?.({ data }));
          },
          close: () => {},
        };
      }
    };
  }
};

const installTextCodecShims = (): void => {
  if (typeof sandboxGlobal["TextEncoder"] === "undefined") {
    sandboxGlobal["TextEncoder"] = class {
      readonly encoding = "utf-8";
      encode(input = ""): Uint8Array {
        const source = String(input);
        const bytes: number[] = [];
        for (let index = 0; index < source.length; index += 1) {
          const code = source.charCodeAt(index);
          if (code < 0x80) {
            bytes.push(code);
          } else if (code < 0x800) {
            bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
          } else if (code >= 0xd800 && code < 0xdc00 && index + 1 < source.length) {
            // Surrogate pair -> one code point.
            const low = source.charCodeAt(index + 1);
            index += 1;
            const point = ((code - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
            bytes.push(
              0xf0 | (point >> 18),
              0x80 | ((point >> 12) & 0x3f),
              0x80 | ((point >> 6) & 0x3f),
              0x80 | (point & 0x3f),
            );
          } else {
            bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
          }
        }
        return new Uint8Array(bytes);
      }
      encodeInto(source: string, destination: Uint8Array): { read: number; written: number } {
        const encoded = this.encode(source);
        const written = Math.min(encoded.length, destination.length);
        destination.set(encoded.subarray(0, written));
        return { read: source.length, written };
      }
    };
  }
  if (typeof sandboxGlobal["TextDecoder"] === "undefined") {
    // The rendered bytes are discarded, so this only has to be faithful enough
    // that React's own encode/decode round-trip does not corrupt a message.
    sandboxGlobal["TextDecoder"] = class {
      readonly encoding = "utf-8";
      decode(input?: ArrayBufferView | ArrayBuffer): string {
        if (!input) return "";
        const bytes =
          input instanceof Uint8Array
            ? input
            : new Uint8Array(
                input instanceof ArrayBuffer ? input : (input as ArrayBufferView).buffer,
              );
        let out = "";
        let index = 0;
        while (index < bytes.length) {
          const byte = bytes[index] ?? 0;
          index += 1;
          if (byte < 0x80) {
            out += String.fromCharCode(byte);
          } else if (byte < 0xe0) {
            out += String.fromCharCode(((byte & 0x1f) << 6) | ((bytes[index] ?? 0) & 0x3f));
            index += 1;
          } else if (byte < 0xf0) {
            out += String.fromCharCode(
              ((byte & 0x0f) << 12) |
                (((bytes[index] ?? 0) & 0x3f) << 6) |
                ((bytes[index + 1] ?? 0) & 0x3f),
            );
            index += 2;
          } else {
            const point =
              (((byte & 0x07) << 18) |
                (((bytes[index] ?? 0) & 0x3f) << 12) |
                (((bytes[index + 1] ?? 0) & 0x3f) << 6) |
                ((bytes[index + 2] ?? 0) & 0x3f)) -
              0x10000;
            index += 3;
            out += String.fromCharCode(0xd800 + (point >> 10), 0xdc00 + (point & 0x3ff));
          }
        }
        return out;
      }
    };
  }
};

/**
 * The slice of `ReadableStream` `renderToReadableStream` actually uses.
 *
 * `renderToReadableStream` is the only server entry that reports a COMPONENT
 * STACK (see `smoke-render.ts`), and it constructs a stream to do it — so the
 * type has to exist even though every byte it produces is thrown away. Only
 * `start`/`pull` and a reader are needed; there is no backpressure to model
 * because the consumer reads as fast as the producer writes.
 */
const installStreamShim = (): void => {
  if (typeof sandboxGlobal["ReadableStream"] !== "undefined") return;

  type Source = {
    start?: (controller: unknown) => unknown;
    pull?: (controller: unknown) => unknown;
    cancel?: (reason?: unknown) => unknown;
  };

  sandboxGlobal["ReadableStream"] = class {
    #chunks: unknown[] = [];
    #closed = false;
    #error: unknown;
    #source: Source;
    #started: Promise<unknown>;
    #controller: {
      desiredSize: number | null;
      enqueue: (chunk: unknown) => void;
      close: () => void;
      error: (reason: unknown) => void;
    };

    constructor(source: Source = {}) {
      this.#source = source;
      const self = this;
      this.#controller = {
        get desiredSize() {
          return self.#closed ? null : 1;
        },
        enqueue: (chunk) => {
          self.#chunks.push(chunk);
        },
        close: () => {
          self.#closed = true;
        },
        error: (reason) => {
          self.#error = reason;
          self.#closed = true;
        },
      };
      this.#started = Promise.resolve(source.start?.(this.#controller));
    }

    getReader() {
      const take = async (): Promise<{ done: boolean; value: unknown }> => {
        await this.#started;
        if (this.#error !== undefined) throw this.#error;
        if (this.#chunks.length > 0) return { done: false, value: this.#chunks.shift() };
        if (this.#closed) return { done: true, value: undefined };
        await Promise.resolve(this.#source.pull?.(this.#controller));
        if (this.#error !== undefined) throw this.#error;
        if (this.#chunks.length > 0) return { done: false, value: this.#chunks.shift() };
        return { done: true, value: undefined };
      };
      return {
        read: take,
        cancel: async (reason?: unknown) => {
          this.#closed = true;
          await Promise.resolve(this.#source.cancel?.(reason));
        },
        releaseLock: () => {},
      };
    }

    cancel(reason?: unknown) {
      return this.getReader().cancel(reason);
    }
  };
};

installSchedulingShims();
installTextCodecShims();
installStreamShim();
