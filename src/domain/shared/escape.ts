// Output hygiene: every string that came from the file system (names, paths, git output)
// is untrusted. These helpers make it safe to print to a terminal, put in a log line or
// hand to an MCP client.

const DISPLAY_OK = /^[\p{L}\p{N}\p{P}\p{S}\p{M}]$/u;

// Code points that render as nothing (or reorder text) yet fall inside the printable classes above:
// soft hyphen, combining grapheme joiner, Arabic letter mark, Hangul and Khmer fillers, Mongolian
// variation selectors, zero-width and bidi controls, invisible operators, variation selectors, the
// halfwidth Hangul filler, interlinear annotation marks, musical formatting characters and the
// Unicode tag block (usable to smuggle invisible text). They are always escaped.
const HIDDEN =
  /^[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e0fff}]$/u;

function isDisplayable(ch: string): boolean {
  return DISPLAY_OK.test(ch) && !HIDDEN.test(ch);
}

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
    else if (cp > 0x7f && isDisplayable(ch)) out += ch;
    else out += `\\u{${cp.toString(16)}}`;
  }
  if (total > maxChars) out += `...[+${total - maxChars} chars]`;
  return out;
}

/** Wrap an untrusted string so a reader (human or model) can tell data from instructions. */
export function frameUntrusted(input: string, maxChars = 512): string {
  return `<untrusted-data>${escapeText(input, maxChars, true)}</untrusted-data>`;
}

/**
 * JSON text that is safe to print and log: everything outside printable ASCII that is not a
 * displayable letter, digit, punctuation, symbol or mark becomes \uXXXX (surrogate pairs for astral
 * code points), using the same rules as escapeText. The result is valid JSON that parses back to the
 * identical value.
 */
export function safeJson(value: unknown, space?: number): string {
  const text = JSON.stringify(value, null, space);
  return (text ?? "null").replace(/[^\x20-\x7e]/gu, (ch) => {
    if (ch === "\n" || ch === "\r" || ch === "\t") return ch; // whitespace JSON.stringify emits for `space`
    if (isDisplayable(ch)) return ch;
    let out = "";
    for (let i = 0; i < ch.length; i++) out += `\\u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`;
    return out;
  });
}
