/**
 * JSON text, or a JavaScript module whose only non-ASCII characters are inside JSON strings, with
 * every character outside ASCII written as a `\u` escape. It parses or evaluates to the same values.
 *
 * A JavaScript engine stores a string with any character beyond Latin-1 at two bytes per
 * character, and every string built from it keeps that width even once its text is ASCII. One
 * such character anywhere in a large app's source, such as a curly quote in an OpenAPI description
 * or a non-Latin name, would double the memory every Worker uses to hold it. The escaped text is
 * decoded from bytes, so it is stored at one byte per character.
 */
export const asciiJson = (text: string) => {
  let wide = 0;
  for (let at = 0; at < text.length; at++) if (text.charCodeAt(at) > 0x7f) wide++;
  if (wide === 0) return text;
  // Each UTF-16 code unit, a surrogate half included, becomes `\uXXXX` in place.
  const bytes = new Uint8Array(text.length + wide * 5);
  let out = 0;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if (code <= 0x7f) {
      bytes[out++] = code;
      continue;
    }
    bytes[out++] = 0x5c;
    bytes[out++] = 0x75;
    for (const digit of code.toString(16).padStart(4, "0")) bytes[out++] = digit.charCodeAt(0);
  }
  return new TextDecoder().decode(bytes);
};
