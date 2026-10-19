// Secrets edited with their values in clear: the YAML of `kubectl get -o yaml`, whose text values move from
// `data` (base64) to `stringData`. Saving sends that YAML as is: the API server encodes stringData into data.
// Binary values (not UTF-8) stay in `data`.

const DATA_BLOCK = /^data:[ \t]*(\{\})?[ \t]*\n((?:[ \t]+.*(?:\n|$))*)/m;
const ENTRY = /^ {2}("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s:'"][^:]*):(?: (.*))?$/;
const PLAIN_KEY = /^[A-Za-z_.][-._A-Za-z0-9]*$/;
/** Keys a YAML 1.1 parser (kubectl) would read as booleans or null. */
const RESERVED = /^(y|yes|n|no|true|false|on|off|null|~)$/i;

export const DECODED_COMMENT = "# Decoded values (stringData). Saving replaces the Secret: the API server encodes them into data again.";

function unquote(s: string): string {
  if (s.startsWith('"')) return JSON.parse(s);
  if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s.trim();
}

/** Control characters other than tabs and line breaks: the mark of binary data. */
function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) return true;
  }
  return false;
}

/** The UTF-8 text of a base64 value, or undefined when it is binary. */
function decodeText(b64: string): string | undefined {
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return hasControl(text) ? undefined : text;
  } catch {
    return undefined;
  }
}

function key(k: string): string {
  return PLAIN_KEY.test(k) && !RESERVED.test(k) ? k : JSON.stringify(k);
}

/** A value of stringData: a block literal for multi-line text, a double-quoted (JSON) string otherwise. */
function entry(k: string, value: string): string[] {
  const literal = value.includes("\n") && !value.includes("\r") && /^\S/.test(value);
  if (!literal) return [`  ${key(k)}: ${JSON.stringify(value)}`];
  const trailing = value.length - value.replace(/\n+$/, "").length;
  const chomping = trailing === 0 ? "|-" : trailing === 1 ? "|" : "|+";
  const body = value.slice(0, value.length - trailing).split("\n");
  return [
    `  ${key(k)}: ${chomping}`,
    ...body.map((line) => (line ? `    ${line}` : "")),
    ...Array.from({ length: Math.max(0, trailing - 1) }, () => ""),
  ];
}

/** Moves the text values of a Secret to stringData; throws when its data block is not in the expected format. */
export function decodeSecretYaml(yaml: string): string {
  const m = DATA_BLOCK.exec(yaml);
  if (!m) return yaml;
  const text: string[] = [];
  const binary: string[] = [];
  for (const line of m[2].split("\n").filter((l) => l.trim())) {
    const e = ENTRY.exec(line);
    if (!e) throw new Error(`Unexpected line in the data of the Secret: ${line.trim().slice(0, 40)}`);
    const name = unquote(e[1]);
    const b64 = unquote(e[2] ?? "");
    const value = decodeText(b64);
    if (value === undefined) binary.push(`  ${key(name)}: ${b64}`);
    else text.push(...entry(name, value));
  }
  const block = [
    DECODED_COMMENT,
    text.length ? "stringData:" : "stringData: {}",
    ...text,
    ...(binary.length ? ["data:", ...binary] : []),
  ].join("\n");
  const rest = yaml.slice(m.index + m[0].length);
  return `${yaml.slice(0, m.index)}${block}\n${rest}`;
}
