/**
 * Trimming a model's raw continuation into a suggestion (WP40, for WP43's
 * model provider). Pure, in this order:
 * 1. cut at the first line break or end-of-text, FIM pad or file-separator token;
 * 2. drop an overlap with the start of the suffix (`ld}` when `}` follows the caret);
 * 3. cut before `\begin` or `\end`, so no environment is left open;
 * 4. keep braces and brackets balanced: never below depth 0 except one closer
 *    of a group opened before the caret (when the suffix does not start with
 *    it), and back to the last point at depth 0;
 * 5. keep the number of unescaped `$` even;
 * 6. stop after the first sentence end, keeping the punctuation;
 * 7. trim trailing spaces; drop it with fewer than 2 non-space characters or
 *    when it repeats the 20 characters before the caret; cap at 80 characters.
 */

export const STOP_TOKENS: readonly string[] = ['<|endoftext|>', '<|fim_pad|>', '<|file_sep|>', '<|fim_prefix|>', '<|fim_suffix|>', '<|fim_middle|>', '<|end_of_text|>'];
export const MAX_SUGGESTION = 80;

const OPEN: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
const CLOSE: Record<string, string> = { '}': '{', ']': '[', ')': '(' };

/** Whether the character at `i` is escaped by an odd run of backslashes. */
function escaped(s: string, i: number): boolean {
  let n = 0;
  for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) n++;
  return n % 2 === 1;
}

/** The openers left unclosed at the end of `prefix`, innermost last. */
function openGroups(prefix: string): string[] {
  const stack: string[] = [];
  for (let i = 0; i < prefix.length; i++) {
    const c = prefix[i];
    if (c === '\n') continue;
    if (OPEN[c] && !escaped(prefix, i)) stack.push(c);
    else if (CLOSE[c] && !escaped(prefix, i)) {
      const at = stack.lastIndexOf(CLOSE[c]);
      if (at >= 0) stack.length = at;
    }
  }
  return stack;
}

export function postprocess(raw: string, prefix: string, suffix: string, stops: readonly string[] = STOP_TOKENS): string | null {
  // 1
  let t = raw;
  let cut = t.indexOf('\n');
  for (const s of stops) {
    const i = t.indexOf(s);
    if (i >= 0 && (cut < 0 || i < cut)) cut = i;
  }
  if (cut >= 0) t = t.slice(0, cut);
  // 2
  const after = suffix.split('\n', 1)[0];
  for (let k = Math.min(t.length, after.length); k >= 1; k--) {
    const part = after.slice(0, k);
    if (t.endsWith(part) && (k >= 3 || /[^A-Za-z\s]/.test(part))) {
      t = t.slice(0, t.length - k);
      break;
    }
  }
  // 3
  const env = t.search(/\\(?:begin|end)\b/);
  if (env >= 0) t = t.slice(0, env);
  // 4
  const outer = openGroups(prefix);
  const stack: string[] = [];
  let zero = 0;
  let end = t.length;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (OPEN[c] && !escaped(t, i)) stack.push(c);
    else if (CLOSE[c] && !escaped(t, i)) {
      if (stack.length) {
        if (stack[stack.length - 1] !== CLOSE[c]) { end = zero; break; }
        stack.pop();
      } else {
        const closesOuter = outer.length > 0 && outer[outer.length - 1] === CLOSE[c] && !after.startsWith(c);
        end = closesOuter ? i + 1 : i;
        zero = end;
        break;
      }
    }
    if (!stack.length) zero = i + 1;
  }
  if (stack.length) t = t.slice(0, zero).replace(/\\[A-Za-z@]*\*?\s*$/, ''); // no command left without its argument
  else t = t.slice(0, end);
  // 5
  const dollars: number[] = [];
  for (let i = 0; i < t.length; i++) if (t[i] === '$' && !escaped(t, i)) dollars.push(i);
  if (dollars.length % 2 === 1) t = t.slice(0, dollars[dollars.length - 1]);
  // 6
  const sentence = /[.?!](?=\s|$)/.exec(t);
  if (sentence) t = t.slice(0, sentence.index + 1);
  // 7
  t = t.replace(/\s+$/, '');
  if (t.length > MAX_SUGGESTION) {
    const space = t.lastIndexOf(' ', MAX_SUGGESTION);
    t = t.slice(0, space > 0 ? space : MAX_SUGGESTION).replace(/\s+$/, '');
  }
  if (t.replace(/\s/g, '').length < 2) return null;
  const tail = prefix.slice(-20);
  if (tail.trim().length >= 10 && t.includes(tail)) return null;
  return t;
}
