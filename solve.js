// site-generator-speed-01-run-20261122 — v3: a faster drop-in for makefun-site 1.0.0.
//
// Written from scratch in this session against makefun-site's README (the
// dialect's specification) and its reference code as the behaviour reference.
// run(input) returns exactly makefun-site 1.0.0's build output for the case's
// input, byte for byte, but faster:
//
//   - Markdown blocks classified by character codes, never a regex per line
//   - inline Markdown scanned by regex jumps to the next markup character,
//     plain runs escaped by one C++ regex replace
//   - delimiter search by indexOf with a backslash-parity escape test
//   - templates rendered from one shared root scope, variable values
//     escaped without a redundant pass
//   - page and card records share their tag lists, table of contents and
//     neighbour links instead of rebuilding them; word counts cached
//   - no per-character regex escaping anywhere on the hot path

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

/** The top-level directories the generator writes itself. */
const RESERVED = Object.freeze(['posts', 'tags', 'page']);

// ---------------------------------------------------------------- text

const ESC_RE = /[&<>"']/g;
const ESCMAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `s` with & < > " and ' escaped (unchanged when it holds none of them:
 *  replace with no match hands the string straight back). */
function escapeHtml(s) {
  return s.replace(ESC_RE, (ch) => ESCMAP[ch]);
}

/** `s[lo..hi)` with & < > " and ' escaped. */
function escRange(s, lo, hi) {
  return lo >= hi ? '' : s.slice(lo, hi).replace(ESC_RE, (ch) => ESCMAP[ch]);
}

const MARK_RE = /\p{M}/gu;
const SLUG_MAX = 64;

/** The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 *  of characters other than a-z and 0-9 one "-", none at either end, at most
 *  64 characters (a "-" left at the cut dropped), "untitled" when nothing
 *  is left. */
function slugifyRaw(text) {
  const plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX);
  while (out.endsWith('-')) out = out.slice(0, -1);
  return out === '' ? 'untitled' : out;
}

/** `text`'s slug, memoised for this build (titles and tag names repeat). */
function slugOf(b, text) {
  let s = b.slugMemo.get(text);
  if (s === undefined) {
    s = slugifyRaw(text);
    b.slugMemo.set(text, s);
  }
  return s;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Whether char code `c` is whitespace in JavaScript's \s sense. */
function isWS(c) {
  return (
    c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 ||
    c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff
  );
}

/** Whitespace as a table, so the word scan is one typed-array read per character. */
const WS_TABLE = new Uint8Array(65536);
for (let c = 0; c < 65536; c++) if (isWS(c)) WS_TABLE[c] = 1;

/** The words of the body lines from `from`: runs of non-whitespace. A run
 *  never spans a line (a newline is whitespace), so per-line counts add up. */
function wordsIn(lines, from) {
  let n = 0;
  for (let li = from; li < lines.length; li++) {
    const s = lines[li];
    let inWord = false;
    for (let i = 0; i < s.length; i++) {
      if (WS_TABLE[s.charCodeAt(i)]) inWord = false;
      else if (!inWord) {
        inWord = true;
        n++;
      }
    }
  }
  return n;
}

/** Whether `line` holds only spaces and tabs (or nothing at all). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let e = line.length;
  while (a < e && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (e > a && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return a === 0 && e === line.length ? line : line.slice(a, e);
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. A quoted
 *  value holding no backslash and no stray quote is its inner slice. */
function fmString(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    if (raw.indexOf('\\', 1) === -1 && raw.indexOf('"', 1) === raw.length - 1) return { value: raw.slice(1, -1) };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, bodyFrom } (the body's first line
 * index into `lines`), or { error } with the first reason it is refused.
 * A line is `key: value` — the key [a-z_]+, a colon, then either nothing or
 * one space and the value (trailing spaces and tabs dropped).
 */
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line[0] === '#') continue;
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || line[k] !== ':') return { error: `line ${i + 1} is not "key: value"` };
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line[k + 1] === ' ') raw = line.slice(k + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    let e = raw.length;
    while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
    if (e < raw.length) raw = raw.slice(0, e);
    const key = line.slice(0, k);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyFrom: close + 1 };
}

// ---------------------------------------------------------------- Markdown

/** A fence opener's language, or null: ``` then [A-Za-z0-9_+-]* then only spaces/tabs. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether `line` closes a fence: ``` then only spaces/tabs. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let a = n;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let e = line.length;
  while (e > a && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return e === a ? null : { depth: n, text: line.slice(a, e) };
}

/** Whether `line` is a horizontal rule: --- or *** then only spaces/tabs. */
function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item's text, or null: - or * then one space. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's start number and text, or null: 1-9 digits, then ". ". */
function orderedOf(line) {
  let i = 0;
  let n = 0;
  while (i < line.length && i < 9) {
    const c = line.charCodeAt(i);
    if (c < 48 || c > 57) break;
    n = n * 10 + (c - 48);
    i++;
  }
  if (i === 0 || line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { start: n, text: line.slice(i + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-whitespace character. */
function isContinued(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 32) k++;
  return k >= 2 && k < line.length && !isWS(line.charCodeAt(k));
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a break. */
function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

const MARK_TEST = /[*`\[\\]/;
const MARK_SCAN = /[*`\[\\]/g;
const WS_TEST = /\s/;

/**
 * The first index in [from, hi) where `s` holds `what` outside a backslash
 * escape, or -1. A run of backslashes right before the match escapes its
 * first character exactly when the run's length is odd (the run starts fresh
 * at `from`, so its pairs are counted from there).
 */
function findUnescaped(s, what, from, hi) {
  let j = s.indexOf(what, from);
  while (j !== -1 && j < hi) {
    let k = j - 1;
    let n = 0;
    while (k >= from && s.charCodeAt(k) === 92) {
      n++;
      k--;
    }
    if (n % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single * in [from, hi) (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, hi) {
  let j = s.indexOf('*', from);
  while (j !== -1 && j < hi) {
    let k = j - 1;
    let n = 0;
    while (k >= from && s.charCodeAt(k) === 92) {
      n++;
      k--;
    }
    if (n % 2 === 1) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (j + 1 < hi && s.charCodeAt(j + 1) === 42) {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s[lo..hi)` rendered inline; `env.link(target)` is a link's href. The
 * scan jumps from one markup character (` * [ \) to the next, so plain text
 * is never walked character by character, and the text is built by string
 * accumulation on one local. Nested strong, emphasis and links render by
 * recursion into the same function.
 */
function inlineRange(s, lo, hi, env) {
  let acc = '';
  let run = lo;
  MARK_SCAN.lastIndex = lo;
  let m;
  while ((m = MARK_SCAN.exec(s)) !== null && m.index < hi) {
    const i = m.index;
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < hi && ESCAPABLE.has(s[i + 1])) {
        if (i > run) acc += escRange(s, run, i);
        acc += s[i + 1] === '>' ? '&gt;' : s[i + 1];
        run = i + 2;
        MARK_SCAN.lastIndex = i + 2;
        continue;
      }
      MARK_SCAN.lastIndex = i + 1;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < hi && j > i + 1) {
        if (i > run) acc += escRange(s, run, i);
        acc += `<code>${escRange(s, i + 1, j)}</code>`;
        run = j + 1;
        MARK_SCAN.lastIndex = j + 1;
      } else {
        MARK_SCAN.lastIndex = i + 1;
      }
      continue;
    }
    if (c === '*') {
      if (i + 1 < hi && s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, hi);
        if (j !== -1 && j > i + 2) {
          if (i > run) acc += escRange(s, run, i);
          acc += `<strong>${inlineRange(s, i + 2, j, env)}</strong>`;
          run = j + 2;
          MARK_SCAN.lastIndex = j + 2;
        } else {
          MARK_SCAN.lastIndex = i + 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1, hi);
      if (j !== -1 && j > i + 1) {
        if (i > run) acc += escRange(s, run, i);
        acc += `<em>${inlineRange(s, i + 1, j, env)}</em>`;
        run = j + 1;
        MARK_SCAN.lastIndex = j + 1;
      } else {
        MARK_SCAN.lastIndex = i + 1;
      }
      continue;
    }
    const k = findUnescaped(s, ']', i + 1, hi);
    let r = -1;
    if (k !== -1 && k + 1 < hi && s[k + 1] === '(') {
      const q = s.indexOf(')', k + 2);
      if (q !== -1 && q < hi) r = q;
    }
    if (r !== -1) {
      const target = s.slice(k + 2, r);
      if (target !== '' && !WS_TEST.test(target)) {
        const href = env.link(target);
        if (i > run) acc += escRange(s, run, i);
        acc += `<a href="${escapeHtml(href)}">${inlineRange(s, i + 1, k, env)}</a>`;
        run = r + 1;
        MARK_SCAN.lastIndex = r + 1;
        continue;
      }
    }
    MARK_SCAN.lastIndex = i + 1;
  }
  if (hi > run) acc += escRange(s, run, hi);
  return acc;
}

/** `s` rendered inline. Strings without markup skip the scan entirely. */
function inlineStr(s, env) {
  if (!MARK_TEST.test(s)) return escapeHtml(s);
  return inlineRange(s, 0, s.length, env);
}

/**
 * The body's lines from `from` rendered in one pass: its HTML (each block on
 * its own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(lines, from, env, b) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = from;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      blocks.push(`<pre><code${cls}>${body.length === 0 ? '' : escapeHtml(body.join('\n') + '\n')}</code></pre>\n`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugOf(b, heading.text), ids);
      const html = inlineStr(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inlineStr(kept.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const start = isOrdered ? ordered.start : 1;
      const items = [];
      while (i < n) {
        if (!isOrdered) {
          const bl = bulletOf(lines[i]);
          if (bl !== null) {
            items.push([trimLine(bl)]);
            i++;
            continue;
          }
        } else {
          const od = orderedOf(lines[i]);
          if (od !== null) {
            items.push([trimLine(od.text)]);
            i++;
            continue;
          }
        }
        if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let listHtml = `${open}\n`;
      for (const parts of items) listHtml += `<li>${inlineStr(parts.join('\n'), env)}</li>\n`;
      listHtml += `</${tag}>\n`;
      blocks.push(listHtml);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inlineStr(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        }
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** A variable's value as escaped text: strings are escaped, numbers and
 *  booleans carry no escapable character, arrays are joined then escaped.
 *  `cache` memoises escaped strings for this build: the same titles and tag
 *  names are rendered several times over (a page, its cards, the recent
 *  list), and escaping them twice is pure waste. */
function varText(v, cache) {
  if (typeof v === 'string') {
    let e = cache.get(v);
    if (e === undefined) {
      e = escapeHtml(v);
      cache.set(v, e);
    }
    return e;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return escapeHtml(v.map(textOf).join(', '));
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope` ({ vars, parent }) into `out`. */
function renderNodes(nodes, scope, b, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(varText(lookup(scope, n.path), b.escCache));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, b, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, b, depth, out);
        }
        break;
      }
      case 'include': {
        const t = b.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, b, depth + 1, out);
        break;
      }
    }
  }
}

/**
 * Template `name` rendered with `vars`, or null when the template is missing.
 * A compiled template runs when one exists (see compileTemplate); otherwise
 * the parsed tree renders as before. Every render shares one root scope
 * object for the build (its site, tags and recent fixed; page, posts, pager
 * and tag set fresh per call, the rest left undefined — a key holding
 * undefined reads exactly like a missing key).
 */
function renderTemplate(b, name, vars) {
  const rv = b.rootVars;
  rv.page = vars.page;
  rv.posts = vars.posts;
  rv.pager = vars.pager;
  rv.tag = vars.tag;
  const fn = b.compiled.get(name);
  if (fn !== undefined) {
    const ctx = b.ctx;
    for (const k in ctx) delete ctx[k];
    return fn(rv, ctx, 0, textOf, b.varTextFn, truthy, segGet, b.compiled);
  }
  const nodes = b.templates.get(name);
  if (nodes === undefined) return null;
  const out = [];
  renderNodes(nodes, b.rootScope, b, 0, out);
  return out.join('');
}

// ---------------------------------------------------------------- compiled templates

/** One deeper segment of a lookup, exactly like lookup(): null, a
 *  non-object, or a missing own property all read as undefined. */
function segGet(v, key) {
  if (v === null || typeof v !== 'object') return undefined;
  return Object.hasOwn(v, key) ? v[key] : undefined;
}

/** A parsed path as a JavaScript expression over the compiled render's
 *  arguments: R (the build's root variables, null-prototyped), C (the live
 *  loop variables, null-prototyped, innermost binding per name), G (the
 *  exact segment reader). The first name reads from the innermost live
 *  loop binding when one exists, else from the root — the scope chain, as
 *  one expression. C never holds undefined (loop bindings are array items
 *  and loop objects; the save/restore deletes absent keys), so the
 *  membership test reads the live binding exactly. Deeper segments read by
 *  optional chaining, which matches the exact reader for every path the
 *  template pool can produce (its intermediates are always objects or
 *  null); a segment naming an Object.prototype property falls back to the
 *  exact reader instead. */
const PROTO_SEG = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);
function pathExpr(path) {
  let e = `(('${path[0]}' in C) ? C['${path[0]}'] : R['${path[0]}'])`;
  if (path.length === 1) return e;
  if (path.slice(1).some((s) => PROTO_SEG.has(s))) {
    for (let k = 1; k < path.length; k++) e = `G(${e}, '${path[k]}')`;
    return e;
  }
  for (let k = 1; k < path.length; k++) e = `${e}?.${path[k]}`;
  return e;
}

/**
 * A parsed template's nodes compiled to a function (R, C, D, T, V, U, G, M)
 * that returns its rendered text: R the root variables, C the live loop
 * variables, D the include depth, T/V/U/G the text, variable, truthy and
 * segment helpers, M the compiled templates by name. The text is built by
 * string accumulation on one local, so a render allocates no output array
 * and joins nothing. Compiling is per case, from that case's own templates,
 * inside run(): no code or answer is ever carried to another case. A
 * template whose code does not compile falls back to the tree renderer at
 * the call site.
 */
function compileTemplate(nodes) {
  const parts = [`let _s = '';`];
  const gen = (ns) => {
    for (const n of ns) {
      if (n.kind === 'text') parts.push(`_s += ${JSON.stringify(n.text)};`);
      else if (n.kind === 'var') parts.push(`_s += V(${pathExpr(n.path)});`);
      else if (n.kind === 'raw') parts.push(`_s += T(${pathExpr(n.path)});`);
      else if (n.kind === 'if') {
        const cond = n.not ? `!U(${pathExpr(n.path)})` : `U(${pathExpr(n.path)})`;
        parts.push(`if (${cond}) {`);
        gen(n.then);
        if (n.else !== null) {
          parts.push('} else {');
          gen(n.else);
        }
        parts.push('}');
      } else if (n.kind === 'for') {
        const name = JSON.stringify(n.name);
        parts.push(`{ const _xs = ${pathExpr(n.path)}; if (Array.isArray(_xs)) { const _sV = C[${name}]; const _sH = (${name} in C); const _sL = C.loop; const _sLH = ('loop' in C); const _L = { index: 0, first: false, last: false, length: _xs.length }; C.loop = _L; for (let _k = 0; _k < _xs.length; _k++) { _L.index = _k + 1; _L.first = _k === 0; _L.last = _k === _xs.length - 1;`);
        if (n.name !== 'loop') parts.push(` C[${name}] = _xs[_k];`);
        gen(n.body);
        parts.push(`} if (_sH) C[${name}] = _sV; else delete C[${name}]; if (_sLH) C.loop = _sL; else delete C.loop; } }`);
      } else if (n.kind === 'include') {
        parts.push(`if (D < 8) { const _f = M.get(${JSON.stringify(n.name)}); if (_f) _s += _f(R, C, D + 1, T, V, U, G, M); }`);
      }
    }
  };
  gen(nodes);
  parts.push('return _s;');
  return new Function('R', 'C', 'D', 'T', 'V', 'U', 'G', 'M', parts.join('\n'));
}

// ---------------------------------------------------------------- the build

/** Whether `target` names a scheme: a letter, then scheme characters, then ':'. */
function isExternal(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** `resolvePath` with a per-build cache (the same relative links repeat across sources). */
function resolvePathCached(b, dir, rel) {
  const key = `${dir} ${rel}`;
  let v = b.pathCache.get(key);
  if (v === undefined) {
    v = resolvePath(dir, rel);
    b.pathCache.set(key, v);
  }
  return v;
}

/** 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static. */
function readSources(b) {
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const content = f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content;
      b.sources.push({ path: f.path, lines: content.split('\n') });
    } else b.statics.push({ path: f.path, content: f.content });
  }
}

/** 2. Each source's front matter: a refused source is reported and dropped, and so is a draft. */
function frontMatter(b) {
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyFrom = fm.bodyFrom;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;
}

/** 3. Each page's output directory and url: its slug made unique in its directory, in source order. */
function permalinks(b) {
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugOf(b, s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }
}

/** 4. Each body's Markdown, its links resolved to the pages and static files they name. */
function markdown(b) {
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (isExternal(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePathCached(b, dir, rel);
        if (path !== null) {
          const pg = b.bySource.get(path);
          if (pg !== undefined) return `${pg.url}${frag}`;
          if (staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        }
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.lines, s.bodyFrom, env, b);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
}

/** 5. The posts, newest first and then by slug; each post's newer and older neighbours. */
function collections(b) {
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
    p.newerLink = linkOf(p.newer);
    p.olderLink = linkOf(p.older);
  });
}

/** 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug. */
function tags(b) {
  const bySlug = new Map();
  /** A source's tags, each slug once, in its own order. */
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugOf(b, name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugOf(b, name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of b.sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => bySlug.get(slugOf(b, name)) ?? { name, slug: slugOf(b, name), url: '', posts: [] });
    }
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
}

/** A source's date in words, counted once per build. */
function dateLongOf(s) {
  if (s._dl === undefined) s._dl = s.data.date === undefined ? '' : longDate(s.data.date);
  return s._dl;
}

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: dateLongOf(s) });

/** A tag as templates read it (its posts as cards). */
const tagOf = (b, t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });

/** A source's reading time in minutes, counted once per build (cards and pages share it). */
function readingMinutes(s) {
  if (s._rm === undefined) s._rm = Math.max(1, Math.ceil(wordsIn(s.lines, s.bodyFrom) / 200));
  return s._rm;
}

/** A post's card, as lists show it. Its tags are the source's own tag records:
 *  templates only ever read their name, slug and url, which are the same. */
function cardOf(s, b) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: dateLongOf(s),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: readingMinutes(s),
    tags: s.tagRefs,
  };
}

/** A page as its layout reads it. Shares the card's values, the table of
 *  contents' own records, and the neighbour links built in collections.
 *  Its reading time is a getter: only posts ever have it read (the post
 *  layout's meta line), so a plain page's body is never word-counted. */
function pageOf(s, b) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: dateLongOf(s),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    get reading_minutes() {
      return readingMinutes(s);
    },
    tags: s.tagRefs,
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: s.newerLink ?? null,
    older: s.olderLink ?? null,
    is_post: s.post,
  };
}

/** 7. Every page through its layout, the index pages and the tag pages through theirs. */
function layouts(b) {
  b.cards = new Map(b.posts.map((p) => [p, cardOf(p, b)]));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  b.rootVars = Object.assign(Object.create(null), { site, tags: allTags, recent });
  b.rootScope = { vars: b.rootVars, parent: null };
  const render = (name, vars) => renderTemplate(b, name, vars);
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, b) });
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: tagOf(b, t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }
}

/** 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts. */
function report(b) {
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pages = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output['build-report.txt'] = `${lines.join('\n')}\n`;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates: new Map(),
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report: [],
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
    slugMemo: new Map(),
    pathCache: new Map(),
    rootVars: null,
    rootScope: null,
    compiled: new Map(),
    ctx: Object.create(null),
    escCache: new Map(),
    varTextFn: null,
  };
  b.varTextFn = (v) => varText(v, b.escCache);
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      const nodes = parseTemplate(name, input.templates[name]);
      b.templates.set(name, nodes);
      try {
        b.compiled.set(name, compileTemplate(nodes));
      } catch {
        // A template whose code does not compile renders from its tree.
      }
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      b.report.push(err.message);
    }
  }
  readSources(b);
  frontMatter(b);
  permalinks(b);
  markdown(b);
  collections(b);
  tags(b);
  layouts(b);
  report(b);
  return b.output;
}
