import vm from 'node:vm';

/*
 * Regexes the user configures run on the job's own log lines inside the daemon. A catastrophic pattern would
 * block the daemon's event loop, so three bounds apply:
 *   1. at configuration time: length, no backreference, no nested quantifier, no overlapping alternation under
 *      a quantifier, a cap on the number of unbounded quantifiers (compilePattern);
 *   2. at run time: a line is cut to MAX_LINE_LENGTH characters before matching;
 *   3. at run time: a whole batch of lines runs under a time budget, enforced by the V8 script timeout
 *      (createMatcher), which interrupts a regex in progress. The budget is per batch, not per line, because
 *      the timeout has a fixed cost per call. A pattern that blew its budget is not run again for COOLDOWN_CALLS
 *      calls, so a bad pattern costs one budget, not one per poll.
 */

export const MAX_PATTERN_LENGTH = 200;
export const MAX_LINE_LENGTH = 2000;
/** Unbounded quantifiers (`*`, `+`, `{n,}`) allowed in one pattern: more is polynomial blow-up on a 2000-char line. */
export const MAX_UNBOUNDED_QUANTIFIERS = 4;
/**
 * Time one `matchLines` call may take, whatever the pattern. A catastrophic pattern never finishes, so the budget
 * only has to be far above what a sound pattern needs on a loaded machine.
 */
export const DEFAULT_MATCH_BUDGET_MS = 500;
/** After a timeout the matcher answers "timed out" without running for this many calls, then tries again. */
export const COOLDOWN_CALLS = 20;

export type CompiledPattern = { ok: true; regex: RegExp } | { ok: false; error: string };

export interface CompileOptions {
  /** Accepted numbers of capture groups, for example [1, 2] for a counter. */
  groups?: readonly number[];
}

function shown(source: string): string {
  return JSON.stringify(source.length > 60 ? `${source.slice(0, 57)}...` : source);
}

/** First-character set (ASCII) of an alternative, or null when it is empty. A nested group counts as "anything". */
function firstSet(alt: string): boolean[] | null {
  if (alt === '') {
    return null;
  }
  const all = (): boolean[] => new Array<boolean>(128).fill(true);
  let token: string;
  if (alt.startsWith('\\')) {
    token = alt.slice(0, 2);
  } else if (alt.startsWith('[')) {
    const end = alt.indexOf(']', 2);
    token = end < 0 ? alt : alt.slice(0, end + 1);
  } else if (alt.startsWith('(')) {
    return all();
  } else {
    token = alt.slice(0, 1);
  }
  if (token === '.') {
    return all();
  }
  let test: RegExp;
  try {
    test = new RegExp(`^(?:${token})$`);
  } catch {
    return all();
  }
  return Array.from({ length: 128 }, (_, c) => test.test(String.fromCharCode(c)));
}

function alternativesOverlap(alts: string[]): string | null {
  const sets = alts.map(firstSet);
  if (sets.some(s => s === null)) {
    return 'has an empty alternative';
  }
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      if (sets[i]!.some((v, c) => v && sets[j]![c])) {
        return `has alternatives that can match the same text ("${alts[i]}" and "${alts[j]}")`;
      }
    }
  }
  return null;
}

interface Frame {
  alts: string[];
  /** Start of the current alternative in the source. */
  altStart: number;
  /** A quantifier that allows more than one repetition occurs inside (at any depth). */
  repeating: boolean;
}

/** The quantifier at `i`: how long it is and whether it repeats, or null. */
function quantifierAt(src: string, i: number): { len: number; repeating: boolean; unbounded: boolean } | null {
  const c = src[i];
  let len = 0;
  let repeating = false;
  let unbounded = false;
  if (c === '*' || c === '+') {
    len = 1;
    repeating = true;
    unbounded = true;
  } else if (c === '?') {
    len = 1;
  } else if (c === '{') {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
    if (!m) {
      return null;
    }
    len = m[0].length;
    if (m[2] === undefined) {
      repeating = Number(m[1]) > 1;
    } else if (m[3] === '') {
      repeating = true;
      unbounded = true;
    } else {
      repeating = Number(m[3]) > 1;
    }
  } else {
    return null;
  }
  if (src[i + len] === '?') {
    len++;
  }
  return { len, repeating, unbounded };
}

/** The structural problem that makes `src` unsafe to run on untrusted-length input, or null. */
function structuralProblem(src: string): string | null {
  const stack: Frame[] = [{ alts: [], altStart: 0, repeating: false }];
  let unbounded = 0;
  let i = 0;
  // The group just closed, waiting to see whether a quantifier follows.
  let closed: Frame | null = null;

  const applyQuantifier = (q: { repeating: boolean; unbounded: boolean }, group: Frame | null): string | null => {
    if (q.unbounded) {
      unbounded++;
    }
    if (q.repeating) {
      if (group) {
        if (group.repeating) {
          return 'has a quantified group that itself contains a repeating quantifier (nested quantifiers, for example "(a+)+"), which can take exponential time';
        }
        const overlap = group.alts.length > 1 ? alternativesOverlap(group.alts) : null;
        if (overlap) {
          return `repeats a group that ${overlap}, which can take exponential time`;
        }
      }
      stack[stack.length - 1]!.repeating = true;
    }
    return null;
  };

  while (i < src.length) {
    const c = src[i]!;
    if (c === '\\') {
      const next = src[i + 1] ?? '';
      if (/[1-9]/.test(next) || (next === 'k' && src[i + 2] === '<')) {
        return 'uses a backreference, which can take exponential time';
      }
      i += 2;
      closed = null;
    } else if (c === '[') {
      i++;
      while (i < src.length && src[i] !== ']') {
        i += src[i] === '\\' ? 2 : 1;
      }
      i++;
      closed = null;
    } else if (c === '(') {
      stack.push({ alts: [], altStart: i + 1, repeating: false });
      i++;
      if (src[i] === '?') {
        // (?: (?= (?! (?<= (?<! (?<name>
        i++;
        if (src[i] === '<' && src[i + 1] !== '=' && src[i + 1] !== '!') {
          i = src.indexOf('>', i) + 1 || src.length;
        } else {
          i += src[i] === '<' ? 2 : 1;
        }
        stack[stack.length - 1]!.altStart = i;
      }
      closed = null;
    } else if (c === '|') {
      const top = stack[stack.length - 1]!;
      top.alts.push(src.slice(top.altStart, i));
      top.altStart = i + 1;
      i++;
      closed = null;
    } else if (c === ')') {
      const top = stack.pop();
      if (!top || stack.length === 0) {
        return 'has an unbalanced ")"';
      }
      if (top.alts.length > 0) {
        top.alts.push(src.slice(top.altStart, i));
      }
      // Whatever repeats inside the group repeats inside its parent too.
      if (top.repeating) {
        stack[stack.length - 1]!.repeating = true;
      }
      closed = top;
      i++;
    } else {
      const q = quantifierAt(src, i);
      if (q) {
        const problem = applyQuantifier(q, closed);
        if (problem) {
          return problem;
        }
        i += q.len;
      } else {
        i++;
      }
      closed = null;
    }
  }
  return unbounded > MAX_UNBOUNDED_QUANTIFIERS
    ? `has ${unbounded} unbounded quantifiers ("*", "+", "{n,}"), at most ${MAX_UNBOUNDED_QUANTIFIERS} are accepted`
    : null;
}

/**
 * Validates and compiles a user pattern. The error names the problem and what to change; it is shown as is by
 * `orch add/edit` and by the job form.
 */
export function compilePattern(source: unknown, options: CompileOptions = {}): CompiledPattern {
  if (typeof source !== 'string' || source === '') {
    return { ok: false, error: `a pattern must be a non-empty string (a regular expression), got ${JSON.stringify(source) ?? String(source)}` };
  }
  if (source.length > MAX_PATTERN_LENGTH) {
    return { ok: false, error: `pattern ${shown(source)} is ${source.length} characters long, at most ${MAX_PATTERN_LENGTH} are accepted; split it or simplify it` };
  }
  let regex: RegExp;
  try {
    regex = new RegExp(source);
  } catch (err) {
    // violations-suppress: ts/no-err-message-direct instanceof-guarded accessor
    const why = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `pattern ${shown(source)} is not a valid regular expression: ${why}` };
  }
  const problem = structuralProblem(source);
  if (problem) {
    return { ok: false, error: `pattern ${shown(source)} ${problem}; rewrite it without that construct (the pattern runs on every log line of the job)` };
  }
  if (options.groups) {
    const count = (new RegExp(`${source}|`).exec('') ?? []).length - 1;
    if (!options.groups.includes(count)) {
      const wanted = options.groups.join(' or ');
      return { ok: false, error: `pattern ${shown(source)} has ${count} capture group(s), it needs ${wanted} capture groups (for example "(\\d+)/(\\d+)" or "(\\d+)%"); put the numbers in parentheses` };
    }
  }
  return { ok: true, regex };
}

export interface MatchBatch {
  /** One entry per input line: the match (full match first, then the groups), or null. Empty when timedOut. */
  matches: Array<Array<string | undefined> | null>;
  /** The budget ran out: the pattern is too slow on this log. The matches are unusable. */
  timedOut: boolean;
}

export interface Matcher {
  matchLines(lines: readonly string[]): MatchBatch;
}

export interface MatcherOptions {
  budgetMs?: number;
}

/**
 * Runs `regex` on lines under a time budget, in its own V8 context so the timeout can interrupt a match in
 * progress. A line is cut to MAX_LINE_LENGTH first. Flags other than `g`/`y` are kept.
 */
export function createMatcher(regex: RegExp, options: MatcherOptions = {}): Matcher {
  const budgetMs = options.budgetMs ?? DEFAULT_MATCH_BUDGET_MS;
  // violations-suppress: react/no-context-in-renderer node:vm sandbox context, not a React context
  const context = vm.createContext({ __src: regex.source, __flags: regex.flags.replace(/[gy]/g, ''), __re: undefined, __lines: [] });
  new vm.Script('__re = new RegExp(__src, __flags);').runInContext(context);
  let cooldown = 0;
  const script = new vm.Script(
    '(function () { var out = []; for (var i = 0; i < __lines.length; i++) {'
    + ' var m = __re.exec(__lines[i]); out.push(m === null ? null : Array.prototype.slice.call(m)); } return out; })()',
  );
  // The first run pays for compiling the script; it is done now, outside the budget.
  context['__lines'] = [''];
  script.runInContext(context, { timeout: 10_000 });
  context['__lines'] = [];
  return {
    matchLines(lines) {
      if (lines.length === 0) {
        return { matches: [], timedOut: false };
      }
      if (cooldown > 0) {
        cooldown--;
        return { matches: [], timedOut: true };
      }
      context['__lines'] = lines.map(l => (l.length > MAX_LINE_LENGTH ? l.slice(0, MAX_LINE_LENGTH) : l));
      try {
        const raw = script.runInContext(context, { timeout: budgetMs }) as Array<ArrayLike<string | undefined> | null>;
        return { matches: raw.map(m => (m === null ? null : Array.from(m))), timedOut: false };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
          cooldown = COOLDOWN_CALLS;
          return { matches: [], timedOut: true };
        }
        throw err;
      } finally {
        context['__lines'] = [];
      }
    },
  };
}

const MATCHER_CACHE_SIZE = 32;
const matchers = new Map<string, Matcher>();

/** A matcher per distinct pattern, kept: building one creates a V8 context. */
export function matcherFor(regex: RegExp): Matcher {
  const key = `${regex.flags}/${regex.source}`;
  let matcher = matchers.get(key);
  if (!matcher) {
    if (matchers.size >= MATCHER_CACHE_SIZE) {
      matchers.delete(matchers.keys().next().value as string);
    }
    matcher = createMatcher(regex);
    matchers.set(key, matcher);
  }
  return matcher;
}
