'use client';

import type { ReactNode } from 'react';

/** Markdown for recorded replies: headings, paragraphs, bold/italic/strike, inline and
 * fenced code, nested lists, task items, quotes, rules, links and GFM tables.
 * Built only from React elements (never raw HTML), because replies are evidence.
 */
export function Markdown({ text }: { text: string }) {
  return <div className="md">{blocks(text.replace(/\r\n?/g, '\n').split('\n'), 'b')}</div>;
}

const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const bulletLine = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const tableSeparator = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function blocks(lines: string[], key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  const para: string[] = [];
  const flush = () => { if (para.length) { out.push(<p key={`${key}-p${i}`}>{inline(para.join('\n'), `${key}-p${i}`)}</p>); para.length = 0; } };
  while (i < lines.length) {
    const line = lines[i];
    const open = fence.exec(line);
    if (open) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${open[1]}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(<pre key={`${key}-c${i}`} className="code" data-lang={open[2] || undefined}><code>{body.join('\n')}</code></pre>);
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) { flush(); const level = Math.min(heading[1].length + 2, 6); const H = `h${level}` as 'h3';
      out.push(<H key={`${key}-h${i}`} className="md-h">{inline(heading[2], `${key}-h${i}`)}</H>); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push(<hr key={`${key}-r${i}`} />); i++; continue; }
    if (/^\s*>/.test(line)) {
      flush();
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(<blockquote key={`${key}-q${i}`}>{blocks(quoted, `${key}-q${i}`)}</blockquote>);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && tableSeparator.test(lines[i + 1])) {
      flush();
      const cells = (row: string) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
      const align = cells(lines[i + 1]).map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : undefined);
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(
        <div key={`${key}-t${i}`} className="md-table"><table>
          <thead><tr>{head.map((cell, c) => <th key={c} style={{ textAlign: align[c] }}>{inline(cell, `${key}-th${c}`)}</th>)}</tr></thead>
          <tbody>{rows.map((row, r) => <tr key={r}>{head.map((_, c) => <td key={c} style={{ textAlign: align[c] }}>{inline(row[c] ?? '', `${key}-td${r}-${c}`)}</td>)}</tr>)}</tbody>
        </table></div>);
      continue;
    }
    if (bulletLine.test(line)) {
      flush();
      // One list per bullet type at its own indent: a numbered list ends where a
      // "-" list starts, even across a blank line. Deeper lines belong to an item.
      const base = bulletLine.exec(line)!;
      const ordered = /\d/.test(base[2]);
      const belongs = (candidate: string) => {
        const match = bulletLine.exec(candidate);
        if (match) return match[1].length > base[1].length || /\d/.test(match[2]) === ordered;
        return /^\s{2,}\S/.test(candidate);
      };
      const items: string[] = [];
      while (i < lines.length && (lines[i].trim() ? belongs(lines[i]) : i + 1 < lines.length && belongs(lines[i + 1]))) items.push(lines[i++]);
      out.push(list(items, `${key}-l${i}`));
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return out;
}

/** A list and its nested lists, by indentation. */
function list(lines: string[], key: string): ReactNode {
  const first = bulletLine.exec(lines[0])!;
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: { head: string; rest: string[] }[] = [];
  for (const line of lines) {
    const match = bulletLine.exec(line);
    if (match && match[1].length <= indent) items.push({ head: match[3], rest: [] });
    else items.at(-1)?.rest.push(line.slice(Math.min(indent + 2, line.length - line.trimStart().length)));
  }
  const children = items.map((item, n) => {
    const task = /^\[( |x|X)\]\s+(.*)$/.exec(item.head);
    const head = task ? <><input type="checkbox" checked={task[1] !== ' '} readOnly disabled /> {inline(task[2], `${key}-${n}`)}</> : inline(item.head, `${key}-${n}`);
    return <li key={n} className={task ? 'task' : undefined}>{head}{item.rest.some(l => l.trim()) && blocks(item.rest, `${key}-${n}`)}</li>;
  });
  const start = ordered ? Number(/\d+/.exec(first[2])![0]) : undefined;
  return ordered ? <ol key={key} start={start}>{children}</ol> : <ul key={key}>{children}</ul>;
}

const inlinePattern = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*([^*\n]+?)\*|(?<![\w])_([^_\n]+?)_(?![\w])|\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)|(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g;

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const match of text.matchAll(inlinePattern)) {
    if (match.index! > last) out.push(...breaks(text.slice(last, match.index), `${key}-${n++}`));
    const k = `${key}-${n++}`;
    if (match[2] !== undefined) out.push(<code key={k}>{match[2]}</code>);
    else if (match[3] ?? match[4]) out.push(<strong key={k}>{inline(match[3] ?? match[4], k)}</strong>);
    else if (match[5]) out.push(<del key={k}>{inline(match[5], k)}</del>);
    else if (match[6] ?? match[7]) out.push(<em key={k}>{inline(match[6] ?? match[7], k)}</em>);
    else if (match[8]) out.push(link(match[9], inline(match[8], k), k));
    else if (match[10]) out.push(link(match[10], match[10], k));
    last = match.index! + match[0].length;
  }
  if (last < text.length) out.push(...breaks(text.slice(last), `${key}-${n}`));
  return out;
}

/** Only web links become anchors; anything else (file paths, javascript:) stays text. */
function link(href: string, label: ReactNode, key: string): ReactNode {
  return /^https?:\/\//i.test(href) ? <a key={key} href={href} target="_blank" rel="noopener noreferrer">{label}</a> : <span key={key} className="md-link">{label}</span>;
}

function breaks(text: string, key: string): ReactNode[] {
  return text.split('\n').flatMap((part, i) => i ? [<br key={`${key}-br${i}`} />, part] : [part]);
}
