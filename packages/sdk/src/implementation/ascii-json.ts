export const asciiJson = (text: string) => {
  let wide = 0;
  for (let at = 0; at < text.length; at++) if (text.charCodeAt(at) > 0x7f) wide++;
  if (wide === 0) return text;
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
