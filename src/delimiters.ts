import { goTokens } from './function-limit';

/** Repair only structural delimiters in generated text; never change existing editor text. */
export function repairGoDelimiters(input: string, prefix: string, suffix: string): string {
  let code = input;
  const boundary = prefix.length;
  // An empty map/slice/array literal must use braces. A well-formed generic [T] is untouched.
  const name = '[\\p{L}_][\\p{L}\\p{Nd}_]*(?:\\.[\\p{L}_][\\p{L}\\p{Nd}_]*)?';
  const typo = new RegExp('(?:map\\s*\\[[^\\]\\r\\n]+\\]|\\[\\s*(?:\\d+)?\\s*\\])\\s*(?:\\[\\s*\\]\\s*)*\\*?\\s*' + name + '(\\[)(?=\\s*\\})', 'gu');
  const combined = prefix + code + suffix;
  const mapEdits: number[] = [];
  for (const match of combined.matchAll(typo)) {
    const at = match.index! + match[0].length - 1;
    if (at >= boundary && at < boundary + code.length) {
      const token = goTokens(combined.slice(0, at + 1)).at(-1);
      if (token?.text === '[' && token.start === at) mapEdits.push(at - boundary);
    }
  }
  for (const at of mapEdits.reverse()) code = code.slice(0, at) + '{' + code.slice(at + 1);

  const end = boundary + code.length;
  const items = goTokens(prefix + code + suffix);
  if (items.some(t => t.literal && !t.complete && t.start < end)) return code;
  const stack: { char: string; start: number }[] = [];
  const opening: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const closing: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const edits: { at: number; remove: number; text: string }[] = [];
  let lastGeneratedEnd = boundary;
  for (const token of items) {
    if (token.literal) { if (token.end <= end && token.end > boundary) lastGeneratedEnd = token.end; continue; }
    if (Object.hasOwn(closing, token.text)) stack.push({ char: token.text, start: token.start });
    else if (Object.hasOwn(opening, token.text)) {
      if (stack.at(-1)?.char === opening[token.text]) stack.pop();
      else {
        let match = stack.length - 1;
        while (match >= 0 && stack[match].char !== opening[token.text]) match--;
        if (token.start < boundary) return code; // Existing malformed prefix: do not guess.
        const missing = stack.slice(match + 1);
        if (match >= 0 && missing.every(t => t.char === '(' || t.char === '[')) {
          edits.push({ at: lastGeneratedEnd - boundary, remove: 0, text: missing.reverse().map(t => closing[t.char]).join('') });
          stack.length = match; // Missing delimiters plus this closer are now satisfied.
        } else if (match < 0 && token.start < end && (token.text === ')' || token.text === ']')) {
          edits.push({ at: token.start - boundary, remove: 1, text: '' });
        } else if (token.start < end) return code; // Ambiguous braces remain for the model/user.
      }
    }
    if (token.end <= end && token.end > boundary) lastGeneratedEnd = token.end;
  }
  let tail = '';
  while (stack.length && stack.at(-1)!.start < end && ['(', '['].includes(stack.at(-1)!.char)) tail += closing[stack.pop()!.char];
  if (tail) edits.push({ at: lastGeneratedEnd - boundary, remove: 0, text: tail });
  // Preserve edit order at the same insertion point while applying from right to left.
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit = edits[i];
    if (edit.at >= 0 && edit.at <= code.length) code = code.slice(0, edit.at) + edit.text + code.slice(edit.at + edit.remove);
  }
  return code;
}
