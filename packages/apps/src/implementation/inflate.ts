/**
 * Minimal zlib (RFC 1950) and DEFLATE (RFC 1951) decoder. Git packfiles concatenate zlib streams
 * without lengths, so readers must know where each stream ends. Platform decompression streams do
 * not report that, so this decoder returns the offset after the stream's Adler-32 checksum.
 */

/** The stream is malformed. */
export class InflateError extends Error {}
/** The decoded stream would exceed the caller's limit. */
export class InflateLimitExceeded extends Error {}

interface Huffman {
  readonly counts: Uint16Array;
  readonly symbols: Uint16Array;
}

const huffman = (lengths: ArrayLike<number>, offset: number, count: number): Huffman => {
  const counts = new Uint16Array(16);
  const symbols = new Uint16Array(count);
  for (let index = 0; index < count; index++) counts[lengths[offset + index]!]!++;
  counts[0] = 0;
  const offsets = new Uint16Array(16);
  for (let length = 1; length < 16; length++)
    offsets[length] = offsets[length - 1]! + counts[length - 1]!;
  for (let index = 0; index < count; index++) {
    const length = lengths[offset + index]!;
    if (length !== 0) symbols[offsets[length]!++] = index;
  }
  return { counts, symbols };
};

const lengthBase = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
];
const lengthExtra = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const distanceBase = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const distanceExtra = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
const codeLengthOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

const fixedLengths = new Uint8Array(288 + 30);
fixedLengths.fill(8, 0, 144);
fixedLengths.fill(9, 144, 256);
fixedLengths.fill(7, 256, 280);
fixedLengths.fill(8, 280, 288);
fixedLengths.fill(5, 288, 318);
const fixedLiteral = huffman(fixedLengths, 0, 288);
const fixedDistance = huffman(fixedLengths, 288, 30);

/** Decode one zlib stream starting at `start`, returning its bytes and the offset after it. */
export const inflateZlib = (
  input: Uint8Array,
  start: number,
  limit: number,
): { readonly data: Uint8Array; readonly end: number } => {
  if (start + 2 > input.byteLength) throw new InflateError("truncated header");
  const cmf = input[start]!;
  const flags = input[start + 1]!;
  if ((cmf & 0x0f) !== 8 || ((cmf << 8) | flags) % 31 !== 0 || flags & 0x20)
    throw new InflateError("invalid zlib header");

  let position = start + 2;
  let bitBuffer = 0;
  let bitCount = 0;
  let output = new Uint8Array(Math.min(limit, 1024));
  let length = 0;

  const bits = (count: number) => {
    while (bitCount < count) {
      if (position >= input.byteLength) throw new InflateError("truncated stream");
      bitBuffer |= input[position++]! << bitCount;
      bitCount += 8;
    }
    const value = bitBuffer & ((1 << count) - 1);
    bitBuffer >>>= count;
    bitCount -= count;
    return value;
  };
  const decode = ({ counts, symbols }: Huffman) => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let bitLength = 1; bitLength < 16; bitLength++) {
      code |= bits(1);
      const count = counts[bitLength]!;
      if (code - count < first) return symbols[index + (code - first)]!;
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new InflateError("invalid code");
  };
  const reserve = (extra: number) => {
    if (length + extra > limit) throw new InflateLimitExceeded();
    if (length + extra <= output.byteLength) return;
    const next = new Uint8Array(Math.min(limit, Math.max(output.byteLength * 2, length + extra)));
    next.set(output.subarray(0, length));
    output = next;
  };

  const codes = (literal: Huffman, distance: Huffman) => {
    for (;;) {
      const symbol = decode(literal);
      if (symbol < 256) {
        reserve(1);
        output[length++] = symbol;
      } else if (symbol === 256) {
        return;
      } else {
        const lengthIndex = symbol - 257;
        if (lengthIndex >= 29) throw new InflateError("invalid length symbol");
        const size = lengthBase[lengthIndex]! + bits(lengthExtra[lengthIndex]!);
        const distanceIndex = decode(distance);
        if (distanceIndex >= 30) throw new InflateError("invalid distance symbol");
        const back = distanceBase[distanceIndex]! + bits(distanceExtra[distanceIndex]!);
        if (back > length) throw new InflateError("distance too far back");
        reserve(size);
        for (let copied = 0; copied < size; copied++, length++)
          output[length] = output[length - back]!;
      }
    }
  };

  let last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuffer = 0;
      bitCount = 0;
      if (position + 4 > input.byteLength) throw new InflateError("truncated stored block");
      const size = input[position]! | (input[position + 1]! << 8);
      const complement = input[position + 2]! | (input[position + 3]! << 8);
      if ((size ^ 0xffff) !== complement) throw new InflateError("invalid stored block");
      position += 4;
      if (position + size > input.byteLength) throw new InflateError("truncated stored block");
      reserve(size);
      output.set(input.subarray(position, position + size), length);
      length += size;
      position += size;
    } else if (type === 1) {
      codes(fixedLiteral, fixedDistance);
    } else if (type === 2) {
      const literalCount = bits(5) + 257;
      const distanceCount = bits(5) + 1;
      const codeLengthCount = bits(4) + 4;
      const codeLengths = new Uint8Array(19);
      for (let index = 0; index < codeLengthCount; index++)
        codeLengths[codeLengthOrder[index]!] = bits(3);
      const codeLengthCode = huffman(codeLengths, 0, 19);
      const lengths = new Uint8Array(literalCount + distanceCount);
      for (let index = 0; index < lengths.byteLength;) {
        const symbol = decode(codeLengthCode);
        if (symbol < 16) {
          lengths[index++] = symbol;
          continue;
        }
        let repeat: number;
        let value = 0;
        if (symbol === 16) {
          if (index === 0) throw new InflateError("repeat without length");
          value = lengths[index - 1]!;
          repeat = 3 + bits(2);
        } else if (symbol === 17) repeat = 3 + bits(3);
        else repeat = 11 + bits(7);
        if (index + repeat > lengths.byteLength) throw new InflateError("too many lengths");
        lengths.fill(value, index, index + repeat);
        index += repeat;
      }
      codes(huffman(lengths, 0, literalCount), huffman(lengths, literalCount, distanceCount));
    } else {
      throw new InflateError("invalid block type");
    }
  }

  // The Adler-32 trailer starts at the next byte boundary; unused bits belong to the last byte read.
  if (position + 4 > input.byteLength) throw new InflateError("truncated checksum");
  const data = output.subarray(0, length);
  let a = 1;
  let b = 0;
  for (let index = 0; index < data.byteLength; index++) {
    a = (a + data[index]!) % 65521;
    b = (b + a) % 65521;
  }
  const expected =
    ((input[position]! << 24) |
      (input[position + 1]! << 16) |
      (input[position + 2]! << 8) |
      input[position + 3]!) >>>
    0;
  if (((b << 16) | a) >>> 0 !== expected) throw new InflateError("checksum mismatch");
  return { data, end: position + 4 };
};
