/**
 * A random UUID v4 for browser code. Browsers expose `crypto.randomUUID` only in secure contexts,
 * and a self-hosted dashboard may be served over plain HTTP on a LAN address, where it is missing.
 * `getRandomValues` exists in every context, so this is the one path everywhere.
 */
export const randomUuid = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte, index) => {
    const value = index === 6 ? (byte & 0x0f) | 0x40 : index === 8 ? (byte & 0x3f) | 0x80 : byte;
    const separator = [4, 6, 8, 10].includes(index) ? "-" : "";
    return separator + value.toString(16).padStart(2, "0");
  }).join("");
