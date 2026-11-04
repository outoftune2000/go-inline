export interface GoToken { text: string; start: number; end: number; braces: number; parens: number; brackets: number; literal?: boolean; complete?: boolean; }

/** Tokenize structural Go text while ignoring comments, strings, and rune literals. */
export function goTokens(text: string): GoToken[] {
  const result: GoToken[] = [];
  let braces = 0, parens = 0, brackets = 0;
  for (let i = 0; i < text.length;) {
    const start = i, ch = text[i], next = text[i + 1];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '/' && next === '/') { const end = text.indexOf('\n', i + 2); i = end < 0 ? text.length : end + 1; continue; }
    if (ch === '/' && next === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2; continue; }
    if (ch === '"' || ch === "'" || ch === '`') {
      let complete = false;
      i++;
      while (i < text.length) {
        if (ch !== '`' && text[i] === '\\') { i += 2; continue; }
        if (text[i++] === ch) { complete = true; break; }
      }
      result.push({ text: text.slice(start, i), start, end: i, braces, parens, brackets, literal: true, complete });
      continue;
    }
    if (/[\p{L}_]/u.test(ch)) { i++; while (i < text.length && /[\p{L}\p{Nd}_]/u.test(text[i])) i++; }
    else i++;
    const word = text.slice(start, i);
    result.push({ text: word, start, end: i, braces, parens, brackets });
    if (word === '{') braces++; else if (word === '}') braces--;
    else if (word === '(') parens++; else if (word === ')') parens--;
    else if (word === '[') brackets++; else if (word === ']') brackets--;
  }
  return result;
}
const keywords = new Set(['break','default','func','interface','select','case','defer','go','map','struct','chan','else','goto','package','switch','const','fallthrough','if','range','type','continue','for','import','return','var']);
const identifier = (value?: string) => !!value && !keywords.has(value) && /^[\p{L}_][\p{L}\p{Nd}_]*$/u.test(value);

function declaration(items: GoToken[], index: number): boolean {
  if (items[index].text !== 'func') return false;
  if (identifier(items[index + 1]?.text)) return true;
  const receiver = items[index + 1];
  if (receiver?.text !== '(') return false;
  let close = -1;
  for (let i = index + 2; i < items.length; i++) {
    if (items[i].text === ')' && items[i].parens === receiver.parens + 1) { close = i; break; }
  }
  return close >= 0 && identifier(items[close + 1]?.text) && items[close + 2]?.text === '(';
}

/** Finish the enclosing function or suggest one new named function/method. Nested callbacks are preserved. */
export function limitToOneFunction(code: string, prefix: string): string {
  const boundary = prefix.length;
  const items = goTokens(prefix + code);
  const functions: { start: number; end?: number }[] = [];
  for (let i = 0; i < items.length; i++) {
    if (!declaration(items, i)) continue;
    const entry: { start: number; end?: number } = { start: items[i].start };
    functions.push(entry);
    for (let j = i + 1; j < items.length; j++) {
      if (declaration(items, j)) break;
      const token = items[j];
      if (token.text !== '{' || token.braces !== items[i].braces || token.parens !== items[i].parens || token.brackets !== items[i].brackets) continue;
      if (items[j - 1]?.text === 'struct' || items[j - 1]?.text === 'interface') continue;
      for (let k = j + 1; k < items.length; k++) {
        if (items[k].text === '}' && items[k].braces === token.braces + 1) { entry.end = items[k].end; break; }
      }
      break;
    }
  }
  const existing = functions.filter(f => f.start < boundary && (f.end === undefined || f.end > boundary)).at(-1);
  const generated = functions.filter(f => f.start >= boundary);
  const allowed = existing ?? generated[0];
  if (!allowed) return code;
  const extra = generated.find(f => f !== allowed);
  let end = code.length;
  if (allowed.end !== undefined) end = Math.min(end, Math.max(0, allowed.end - boundary));
  if (extra) end = Math.min(end, Math.max(0, extra.start - boundary));
  return code.slice(0, end).trimEnd();
}
