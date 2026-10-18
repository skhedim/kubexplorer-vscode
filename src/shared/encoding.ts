/** Decodes a base64 value as UTF-8 (Secret data). Works in Node.js and in browsers. */
export function decodeBase64(b64: string): string {
  const binary = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}
