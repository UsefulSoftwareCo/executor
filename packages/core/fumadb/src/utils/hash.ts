/**
 * @returns 64-bit integer as hex string
 */
export function hashString(str: string) {
  let hash1 = 0xdeadbeefn; // First 32-bit seed
  let hash2 = 0x41c6ce57n; // Second 32-bit seed
  const prime = 0x1000193n; // Large prime for multiplication
  const mask = 0xffffffffn; // 32-bit mask

  for (let i = 0; i < str.length; i++) {
    const char = BigInt(str.charCodeAt(i));
    // Update hash1: multiply by prime, add character, and rotate
    hash1 = (hash1 * prime) ^ char;
    hash1 = ((hash1 << 5n) | (hash1 >> 27n)) & mask; // Rotate left 5 bits
    // Update hash2: XOR with character and multiply by prime
    hash2 = (hash2 ^ char) * prime;
    hash2 = ((hash2 << 7n) | (hash2 >> 25n)) & mask; // Rotate left 7 bits
  }

  // Combine both hashes into a 64-bit result
  const combined = (hash1 << 32n) | hash2;
  return combined.toString(16).padStart(16, "0");
}
