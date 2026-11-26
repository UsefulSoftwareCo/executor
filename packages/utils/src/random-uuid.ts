export const randomUuid = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte, index) => {
    const value = index === 6 ? (byte & 0x0f) | 0x40 : index === 8 ? (byte & 0x3f) | 0x80 : byte;
    const separator = [4, 6, 8, 10].includes(index) ? "-" : "";
    return separator + value.toString(16).padStart(2, "0");
  }).join("");
