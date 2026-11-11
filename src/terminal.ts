import { styleText } from 'node:util';

type Format = Parameters<typeof styleText>[0];
/** What the indented lines under a heading are. */
type Mode = 'turn' | 'call' | 'patch' | 'in' | 'thinking' | 'prose' | undefined;

const INDENT = '    ';
const HARNESS: Record<string, Format> = { 'claude-code': 'yellow', codex: 'green', pi: 'magenta' };
/** Lines of a pasted prompt, and of a tool's input or output, shown before the rest is folded. */
const SHOWN = { turn: 3, call: 6 };
// The terminal's own colours, so the view follows the person's theme, light or dark.
const style = (format: Format, text: string) => text && styleText(format, text, { validateStream: false });
const dim = (text: string) => style('dim', text);
const position = (text: string) => style(['bold', 'cyan'], text);
const prose = (mode: Mode, line: string) => mode === 'in' ? style('bold', line) : mode === 'thinking' ? dim(line) : line;

/** The ledger's text for a person at a terminal. Agents never get this: the CLI paints
 * only when its output is a terminal.
 *
 * No word is changed. Without a width the text is only coloured. With one it is also fitted
 * to the terminal: prose is wrapped, other long lines are cut with `…`, a long pasted prompt
 * or tool body is folded with the command that opens it whole, and sessions with no turns
 * are counted, not listed. The last line says so whenever something was shortened.
 */
export function paint(text: string, width?: number): string {
  const out: string[] = [];
  let mode: Mode, capture = '', scope = '', call = '', shown = 0, hidden = 0, empty = 0, shortened = false;
  const cut = (line: string) => {
    if (!width || line.length <= width) return line;
    shortened = true;
    return line.slice(0, width - 1) + '…';
  };
  const flush = () => {
    if (hidden) out.push(dim(`${INDENT}${INDENT}… ${hidden} more ${hidden === 1 ? 'line' : 'lines'} · wisdom open ${mode === 'turn' ? scope : `${scope}/${call}`} --capture ${capture}`));
    shown = hidden = 0;
  };
  for (const line of text.split('\n')) {
    const isProse = mode === 'in' || mode === 'thinking' || mode === 'prose';
    if (line.startsWith('⤷ ')) {
      // A continued piece of one long line: prose keeps it, a line that was cut does not.
      if (!width) out.push(dim('⤷ ') + line.slice(2));
      else if (isProse) out.push(...wrap(INDENT + line.slice(2), width).map(piece => prose(mode, piece)));
      continue;
    }
    if (!line.startsWith(INDENT)) {
      flush();
      if (width && /^[0-9a-f-]{36}  .*  0 turns  /.test(line)) { empty++; shortened = true; continue; }
      if (empty && !line) { out.push(dim(`${empty} ${empty === 1 ? 'session' : 'sessions'} with no turns ${empty === 1 ? 'is' : 'are'} not listed`)); empty = 0; }
      const at = /^(?:session |([ta]\d+) · .*session )([0-9a-f]{8})/.exec(line);
      if (at) { capture = at[2]; scope = at[1] ?? ''; }
      scope = /^t\d+(?= +in)/.exec(line)?.[0] ?? scope;
      call = /^c\d+(?=  )/.exec(line)?.[0] ?? call;
      // Room to read: a call, and whatever follows an indented block, starts after an empty line.
      if (width && line && out.at(-1) && (/^c\d+  /.test(line) || /^(\x1b\[\d+m)* /.test(out.at(-1)!))) out.push('');
      const [first, ...more] = !width ? [line] : /^(in|thinking|reply|task|report)\b/.test(line) ? wrap(line, width, 10)
        : /^(complete|limited) · /.test(line) ? [line] : [cut(columns(line))];
      const [painted, next] = heading(first);
      mode = next;
      out.push(painted, ...more.map(piece => prose(mode, piece)));
    } else if (mode === 'patch') out.push(diff(line));
    else if (isProse) out.push(...wrap(line, width).map(piece => prose(mode, piece)));
    else if (line.startsWith(INDENT + INDENT) && (mode === 'turn' || mode === 'call')) {
      if (width && capture && scope && shown === SHOWN[mode]) { hidden++; shortened = true; continue; }
      shown++;
      out.push(mode === 'turn' ? style('bold', cut(line)) : cut(line));
    } else {
      flush();
      out.push(mode === 'turn' ? fact(cut(line))
        : cut(line).replace(/^( +)(input and output repeat .*|input|output)/, (_, pad, label) => pad + dim(label)));
    }
  }
  if (shortened) out.push(dim('shortened to fit the terminal · --plain prints the whole text, as agents read it'));
  return out.join('\n');
}

/** Break a line at spaces to fit the width. Later pieces keep the line's indent, or `hang`. */
function wrap(line: string, width?: number, hang = line.length - line.trimStart().length): string[] {
  if (!width || line.length <= width) return [line];
  const pieces: string[] = [];
  let piece = '';
  for (const word of line.split(/(?<=\S) /)) {
    if (piece && piece.length + 1 + word.length > width) { pieces.push(piece); piece = ' '.repeat(hang) + word; }
    else piece = piece ? `${piece} ${word}` : word;
  }
  return [...pieces, piece];
}

/** A row of the session list, its fields in columns. */
function columns(line: string): string {
  const m = /^([0-9a-f-]{36})  (\S+)  (.*)$/.exec(line);
  if (!m) return line;
  const rest = m[3].split('  ');
  const status = rest.length > 3 ? rest.shift()! : '';
  const [time, turns, ...last] = rest;
  return [m[1], m[2].padEnd(11), status.padEnd(11), time, turns.padStart(9), ...last].join('  ');
}

/** A line that starts at the margin, and what the indented lines under it are. */
function heading(line: string): [string, Mode] {
  let m: RegExpExecArray | null;
  if ((m = /^([0-9a-f-]{8})([0-9a-f-]{28})  (\S+)( +.*?)((?<=turns?)  .*)?$/.exec(line))) {
    return [style('bold', m[1]) + dim(m[2]) + '  ' + harness(m[3]) + m[4].replace(/\brecording\b/, part => style('green', part)) + dim(m[5] ?? ''), undefined];
  }
  if ((m = /^(t\d+ +)(in(?: \([^)]*\))?)(?:( {2,})(.*))?$/.exec(line))) return [position(m[1]) + dim(m[2]) + (m[3] ?? '') + style('bold', m[4] ?? ''), 'turn'];
  if ((m = /^((?:[ta]\d+|outside) · )(.*)$/.exec(line))) return [position(m[1]) + dim(m[2]), undefined];
  if ((m = /^(c\d+  )(\S+)(.*)$/.exec(line))) return [position(m[1]) + style('bold', m[2]) + facts(m[3]), 'call'];
  if ((m = /^(p\d+  )(.*)$/.exec(line))) return [position(m[1]) + facts(m[2]), 'patch'];
  if ((m = /^(session )([0-9a-f-]{8})([0-9a-f-]{28})( · )(\S+)(.*)$/.exec(line))) return [style('bold', m[1] + m[2]) + dim(m[3]) + m[4] + harness(m[5]) + facts(m[6]), undefined];
  if ((m = /^(in(?: \([^)]*\))?|thinking(?: · [\d.]+ m?s)?)(?:( {2,})(.*))?$/.exec(line))) {
    const label: Mode = m[1].startsWith('in') ? 'in' : 'thinking';
    return [dim(m[1]) + (m[2] ?? '') + prose(label, m[3] ?? ''), label];
  }
  if ((m = /^(reply(?: \(from hook\))?|task|report)(?:( {2,})(.*))?$/.exec(line))) return [dim(m[1]) + (m[2] ?? '') + (m[3] ?? ''), 'prose'];
  if ((m = /^(change|subagent|outside|call)( {2,})(.*)$/.exec(line))) return [dim(m[1]) + m[2] + facts(m[3]), undefined];
  if ((m = /^(not recorded|unreadable)(  .*)$/.exec(line))) return [style(m[1] === 'unreadable' ? 'red' : 'yellow', m[1]) + dim(m[2]), undefined];
  if (/^(sessions|shared with you) · /.test(line)) return [style('bold', line), undefined];
  if (line.startsWith('limited · ') || line.startsWith('evidence folder missing')) return [style('yellow', line), undefined];
  if (/^\d[\d,]* turns? · /.test(line)) return [facts(line), undefined];
  return [dim(line), undefined];
}

const harness = (name: string) => style(HARNESS[name] ?? 'bold', name);

/** Facts joined by ` · `: only what went wrong or is still open gets a colour; `plain` styles the rest. */
function facts(text: string, plain = (part: string) => part): string {
  return text.split(' · ').map(part => {
    const stat = /^\+(\d+) −(\d+)$/.exec(part);
    if (stat) return `${style('green', `+${stat[1]}`)} ${style('red', `−${stat[2]}`)}`;
    if (part === 'ok' || part === 'recording') return style('green', part);
    if (part === 'failed' || /^[\d,]+ failed$/.test(part)) return style('red', part);
    return /^([\d,]+ )?(pending|without a recorded result)$|^(no result|outcome not) recorded$/.test(part) ? style('yellow', part) : plain(part);
  }).join(plain(' · '));
}

/** A turn's `out`, facts or subagent line in a glance. */
function fact(line: string): string {
  const m = /^( +)(out {2,}|subagent )?(.*)$/.exec(line)!;
  if (m[2]?.startsWith('out')) return m[1] + dim(m[2]) + m[3];
  return m[1] + dim(m[2] ?? '') + facts(m[3], dim);
}

function diff(line: string): string {
  const body = line.slice(INDENT.length);
  if (/^(\+\+\+|---) /.test(body)) return style('bold', line);
  if (body.startsWith('@@')) return style('cyan', line);
  return body.startsWith('+') ? style('green', line) : body.startsWith('-') ? style('red', line) : line;
}
