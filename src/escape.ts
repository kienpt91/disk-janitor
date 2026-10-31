// Output hygiene: every string that came from the file system (names, paths, git output)
// is untrusted. These helpers make it safe to print to a terminal, put in a log line or
// hand to an MCP client.

const DISPLAY_OK = /^[\p{L}\p{N}\p{P}\p{S}\p{M}]$/u;

/**
 * Escape a string for display. Printable ASCII and printable non-ASCII letters, digits,
 * punctuation, symbols and marks pass through. Everything else (controls, ANSI/OSC
 * introducers, bidi and zero-width format characters, line separators, lone surrogates,
 * non-ASCII spaces) is rewritten as a visible escape. Backslash is doubled so the output
 * is unambiguous. Output is cut to `maxChars` code points.
 */
export function escapeText(input: string, maxChars = 512, escapeAngle = false): string {
  let out = "";
  let count = 0;
  let total = 0;
  for (const ch of input) {
    total++;
    if (count >= maxChars) continue;
    count++;
    const cp = ch.codePointAt(0) as number;
    if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (escapeAngle && (ch === "<" || ch === ">")) out += `\\x${cp.toString(16).padStart(2, "0")}`;
    else if (cp >= 0x20 && cp <= 0x7e) out += ch;
    else if (cp < 0x100 && !(cp >= 0xa1 && cp !== 0xad)) out += `\\x${cp.toString(16).padStart(2, "0")}`;
    else if (cp > 0x7f && DISPLAY_OK.test(ch)) out += ch;
    else out += `\\u{${cp.toString(16)}}`;
  }
  if (total > maxChars) out += `...[+${total - maxChars} chars]`;
  return out;
}

/** Wrap an untrusted string so a reader (human or model) can tell data from instructions. */
export function frameUntrusted(input: string, maxChars = 512): string {
  return `<untrusted-data>${escapeText(input, maxChars, true)}</untrusted-data>`;
}

// JSON.stringify leaves these alone; they are invisible or reorder text in terminals.
const JSON_UNSAFE = /[\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb]/g;

/** JSON text that is safe to print: control, format and bidi characters become \uXXXX. */
export function safeJson(value: unknown, space?: number): string {
  const text = JSON.stringify(value, null, space);
  return (text ?? "null").replace(JSON_UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
