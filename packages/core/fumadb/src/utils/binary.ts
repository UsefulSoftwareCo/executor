export function bigintToUint8Array(bigint: bigint) {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setBigInt64(0, bigint, false);
  return bytes;
}

export function uint8ArrayToBigInt(arr: Uint8Array) {
  // Convert Uint8Array to hex string
  const hex = Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return BigInt(`0x${hex}`);
}

export function stringToUint8Array(str: string) {
  const encoder = new TextEncoder();
  return encoder.encode(str);
}

export function uint8ArrayToString(arr: Uint8Array) {
  const decoder = new TextDecoder();
  return decoder.decode(arr);
}

export function booleanToUint8Array(bool: boolean) {
  return new Uint8Array([bool ? 1 : 0]);
}

export function uint8ArrayToBoolean(arr: Uint8Array) {
  return arr[0] !== 0;
}

export function numberToUint8Array(num: number) {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setFloat64(0, num, false);
  return bytes;
}

export function uint8ArrayToNumber(arr: Uint8Array) {
  const view = new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
  return view.getFloat64(0, false);
}
