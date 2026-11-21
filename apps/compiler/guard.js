/**
 * Galley: the compile service's input and access checks, kept apart from the
 * typesetting code so each can be tested without TeX Live.
 *
 * - Root file names: an allowlist, because latexmk hands the name to
 *   /bin/sh inside double quotes, where a backtick runs a command (latexmk's
 *   own refusal list leaves it out). The app server applies the same rules
 *   (apps/server/src/util.ts invalidRootFile); test/rootfile-guard.test.mjs
 *   keeps the two in step.
 * - The API token: COMPILER_TOKEN, sent by the app in the x-compiler-token
 *   header on every route but GET /health, compared in constant time.
 * - Bounded request bodies and bounded captured process output.
 */
const crypto = require('crypto');
const net = require('net');
const path = require('path');

const TOKEN_HEADER = 'x-compiler-token';
const TOKEN_MIN_LENGTH = 32;

/**
 * Characters a root file name may use, per path segment: letters and
 * combining marks of any script (a macOS file name arrives decomposed),
 * digits, the space and . _ - ( ) +. Everything else is refused, the
 * characters /bin/sh reads inside double quotes ($ ` \ ") above all, then
 * quotes, control and format characters, and the ones TeX or latexmk treat
 * specially (% ~ # & ^ { } and the rest).
 */
const ROOT_SEGMENT_RE = /^[\p{L}\p{M}\p{N} ._()+-]+$/u;
const ROOT_MAX_BYTES = 900;
const SEGMENT_MAX_BYTES = 255;

/** How a character is named in a refusal: printable as itself, else by code point. */
function describeChar(ch) {
  const cp = ch.codePointAt(0);
  if (ch === '`') return 'a backtick (`)';
  if (ch === '\\') return 'a backslash (\\)';
  if (ch === '"' || ch === "'") return `a quote (${ch})`;
  if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp < 0xa0)) return `a control character (U+${cp.toString(16).toUpperCase().padStart(4, '0')})`;
  if (/[\p{L}\p{N}\p{P}\p{S}]/u.test(ch)) return `the character "${ch}"`;
  return `the character U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Why `rootFile` cannot be typeset as the main document, or null when it can.
 * It must be a relative path inside the project, "/"-separated, every segment
 * made of ROOT_SEGMENT_RE's characters and not starting with "-" (latexmk
 * reads "-pdflatex=<program>" as an option that runs the program), no ".."
 * anywhere, nothing inside .git or the compiler's output folders.
 */
function rootFileProblem(rootFile) {
  if (typeof rootFile !== 'string' || !rootFile.trim()) return 'the name is empty';
  if (Buffer.byteLength(rootFile) > ROOT_MAX_BYTES) return `the path is longer than ${ROOT_MAX_BYTES} bytes`;
  if (rootFile.startsWith('/') || path.isAbsolute(rootFile)) return 'it is not a path inside the project';
  if (rootFile.includes('..')) return 'it contains ".."';
  const segments = rootFile.split('/');
  for (const seg of segments) {
    if (!seg) return 'it has an empty folder name ("//", or a "/" at the start or end)';
    if (seg === '.') return 'it has a "." folder';
    if (Buffer.byteLength(seg) > SEGMENT_MAX_BYTES) return `a name in it is longer than ${SEGMENT_MAX_BYTES} bytes`;
    if (seg.startsWith('-')) return 'a name in it starts with "-"';
    // As the app server compares them: macOS and Windows open ".GIT." as .git.
    const lower = seg.toLowerCase().replace(/[. ]+$/, '');
    if (lower === '.git' || lower.startsWith('.aldine')) return `it is inside ${seg}, which the compiler does not typeset from`;
    if (!ROOT_SEGMENT_RE.test(seg)) {
      const bad = [...seg].find((ch) => !ROOT_SEGMENT_RE.test(ch));
      return `it contains ${describeChar(bad)}`;
    }
  }
  return null;
}

/** The compiler's yes/no form of rootFileProblem (true = refuse). */
const invalidRootFile = (rootFile) => rootFileProblem(rootFile) !== null;

/** True when `abs` is a strict descendant of `dir` (both absolute and resolved). */
function insideDir(dir, abs) {
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  return abs.startsWith(prefix) && abs.length > prefix.length;
}

/** dataDir/<projectDir>, refused unless it is a directory strictly inside dataDir. */
function projectRootIn(dataDir, projectDir) {
  if (typeof projectDir !== 'string' || !projectDir || projectDir.includes('..') || projectDir.includes('\0')) throw new Error('invalid projectDir');
  const root = path.resolve(dataDir);
  const absDir = path.resolve(root, projectDir);
  if (!insideDir(root, absDir)) throw new Error('projectDir escapes DATA_DIR');
  return absDir;
}

const digest = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest();

/** The configured token in comparable form, or null when there is none. */
function tokenDigest(token) {
  return typeof token === 'string' && token ? digest(token) : null;
}

/**
 * Whether a request may proceed: no token configured, or the header equals it.
 * Both sides are hashed first, so the comparison takes the same time whatever
 * the header's length or content.
 */
function authorized(headerValue, expected) {
  if (!expected) return true;
  if (typeof headerValue !== 'string' || !headerValue) return false;
  return crypto.timingSafeEqual(digest(headerValue), expected);
}

/** A HOST value that binds the loopback interface or every interface. */
function loopbackOrWildcard(host) {
  const h = String(host).trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const kind = net.isIP(h);
  if (kind === 4) return h === '0.0.0.0' || h.startsWith('127.');
  if (kind !== 6) return false;
  // The URL parser prints an IPv6 address in its shortest form: "::1" for
  // every spelling of the loopback, "::ffff:7f00:1" for ::ffff:127.0.0.1.
  let norm;
  try { norm = new URL(`http://[${h}]/`).hostname.slice(1, -1); } catch { return false; }
  if (norm === '::' || norm === '::1') return true;
  const mapped = norm.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!mapped) return false;
  const hi = parseInt(mapped[1], 16);
  const lo = parseInt(mapped[2], 16);
  return loopbackOrWildcard(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
}

/**
 * Why the service must not start with this environment, or null.
 * - COMPILER_TOKEN, when set, must be at least TOKEN_MIN_LENGTH visible ASCII
 *   characters (a header value cannot carry anything else intact).
 * - Without a token, HOST must not name the loopback or every interface:
 *   on a shared machine either is reachable by every local account, and the
 *   API runs TeX on any project it is pointed at. HOST unset is upstream's
 *   container layout (the compiler alone in its network namespace, on an
 *   internal network), which keeps working; COMPILER_ALLOW_UNAUTHENTICATED=1
 *   is the explicit way to run without a token anyway.
 */
function startupProblem(env) {
  const token = env.COMPILER_TOKEN;
  if (token !== undefined && token !== '') {
    if (!/^[\x21-\x7e]+$/.test(token)) return 'COMPILER_TOKEN may only hold visible ASCII characters (no spaces)';
    if (token.length < TOKEN_MIN_LENGTH) return `COMPILER_TOKEN must be at least ${TOKEN_MIN_LENGTH} characters long`;
    return null;
  }
  const host = env.HOST;
  if (host === undefined || host === '') return null;
  if (env.COMPILER_ALLOW_UNAUTHENTICATED === '1') return null;
  if (loopbackOrWildcard(host)) {
    return `HOST=${host} makes this API reachable by every account on the machine, and COMPILER_TOKEN is not set. `
      + 'Set COMPILER_TOKEN (the same value for the app server), or COMPILER_ALLOW_UNAUTHENTICATED=1 to run without one.';
  }
  return null;
}

/**
 * Reads a request body up to `limit` bytes. Past the limit the rest is read
 * and dropped (the client still gets an answer), and `over` is set.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (d) => {
      if (over) return;
      size += d.length;
      if (size > limit) { over = true; chunks.length = 0; return; }
      chunks.push(d);
    });
    req.on('end', () => resolve({ over, text: over ? '' : Buffer.concat(chunks).toString('utf8') }));
    req.on('error', reject);
  });
}

/**
 * A child's output as text, bounded: the first `headMax` characters and the
 * last `tailMax`, with a note of how much was left out between them. A
 * document that prints without end costs memory up to the cap, not more.
 */
class OutputBuffer {
  constructor(headMax = 256 * 1024, tailMax = 1024 * 1024) {
    this.headMax = headMax;
    this.tailMax = tailMax;
    this.head = '';
    this.tail = [];
    this.tailLen = 0;
    this.dropped = 0;
  }

  push(s) {
    if (!s) return;
    if (this.head.length < this.headMax) {
      const room = this.headMax - this.head.length;
      this.head += s.slice(0, room);
      s = s.slice(room);
      if (!s) return;
    }
    this.tail.push(s);
    this.tailLen += s.length;
    while (this.tailLen > this.tailMax) {
      const extra = this.tailLen - this.tailMax;
      const first = this.tail[0];
      if (first.length <= extra) {
        this.tail.shift();
        this.tailLen -= first.length;
        this.dropped += first.length;
      } else {
        this.tail[0] = first.slice(extra);
        this.tailLen -= extra;
        this.dropped += extra;
      }
    }
  }

  toString() {
    const tail = this.tail.join('');
    if (!this.dropped) return this.head + tail;
    return `${this.head}\n[… ${Math.ceil(this.dropped / 1000)} KB of output left out …]\n${tail}`;
  }
}

module.exports = {
  TOKEN_HEADER, TOKEN_MIN_LENGTH, ROOT_SEGMENT_RE,
  rootFileProblem, invalidRootFile, insideDir, projectRootIn,
  tokenDigest, authorized, loopbackOrWildcard, startupProblem,
  readBody, OutputBuffer,
};
