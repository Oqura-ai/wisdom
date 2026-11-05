'use client';

import { useEffect, useState } from 'react';
import { recordBodies, resultBody } from '@/lib/api';
import type { TreeNode } from '@/lib/tree';

type Body = { available: boolean; text?: string; truncated?: boolean; reason?: string } | undefined;

/** Bodies load on demand: request text, tool input and result, or the patch. */
export function Inspector({ captureId, readVersion, node, onClose }: { captureId: string; readVersion?: number; node?: TreeNode; onClose: () => void }) {
  const [bodies, setBodies] = useState<{ main?: any; result?: any }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    setBodies(undefined); setError(undefined);
    if (!node || readVersion === undefined || node.kind === 'subagent') return;
    const id = node.record.id;
    // A slower answer for the row selected before must not replace this row's evidence.
    let current = true;
    Promise.all([recordBodies(captureId, id, readVersion), node.result ? resultBody(captureId, node.result, readVersion) : undefined])
      .then(([main, result]) => { if (current) setBodies({ main, result }); }, e => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [captureId, readVersion, node]);

  if (!node) return <aside className="inspector card empty small">Select a request, tool call or change to see its recorded evidence.</aside>;
  const r = node.record;
  return (
    <aside className="inspector card">
      <header><b>{node.kind === 'tool' ? r.toolName : node.kind === 'change' ? r.path : node.kind}</b><span className="spacer" /><button className="ghost" onClick={onClose}>✕</button></header>
      <dl className="facts">
        {[['type', r.type], ['seq', r.seq], ['observed', new Date(r.observedAt).toLocaleString()], ['tool call', r.toolCallId], ['agent', r.agentId],
          ['operation', r.operation], ['attribution', r.attribution], ['result', node.result ? (node.result.isError === true ? 'error' : node.result.isError === false ? 'ok' : 'recorded, outcome unknown') : node.kind === 'tool' ? 'none recorded' : undefined],
          ['result basis', node.result?.resultBasis], ['started subagent', node.result?.childAgentId], ['record', r.id]]
          .filter(([, value]) => value !== undefined && value !== '')
          .map(([label, value]) => <div key={label as string}><dt>{label}</dt><dd className="mono">{String(value)}</dd></div>)}
      </dl>
      {error && <div className="banner">{error}</div>}
      {node.kind === 'subagent' && <p className="muted small">Subagent lane. Its own requests, calls and changes are nested below it in the tree.</p>}
      {node.kind !== 'subagent' && !bodies && !error && <div className="muted small">Loading evidence…</div>}
      {bodies?.main && (
        <>
          {node.kind === 'request' && <Section title="Request" body={bodies.main.content} />}
          {node.kind === 'reply' && <Section title="Assistant reply" body={bodies.main.content} />}
          {node.kind === 'tool' && <Section title="Input" body={bodies.main.data} json />}
          {node.kind === 'tool' && <Section title={node.result?.resultBasis ? 'Result (from transcript)' : 'Result'}
            body={bodies.result ?? { available: false, reason: node.result ? 'No result body recorded.' : 'No result recorded.' }} json />}
          {node.kind === 'change' && <Section title="Patch" body={bodies.main.patch} diff />}
          {['gap', 'note'].includes(node.kind) && <Section title="Detail" body={bodies.main.data ?? { available: true, text: r.summary }} json />}
        </>
      )}
    </aside>
  );
}

function Section({ title, body, json, diff }: { title: string; body: Body; json?: boolean; diff?: boolean }) {
  if (!body) return null;
  if (!body.available) return <section className="evidence"><h3>{title}</h3><div className="muted small">{body.reason ?? 'Not available.'}</div></section>;
  let text = body.text ?? '';
  if (json) {
    try {
      const value = JSON.parse(text);
      const only = value && typeof value === 'object' && Object.keys(value).length === 1 && 'input' in value;
      // Display only: line breaks inside strings read as line breaks. The stored body is unchanged.
      text = JSON.stringify(only ? value.input : value, null, 2).replace(/(?<!\\)(\\r)?\\n/g, '\n');
    } catch { /* raw text */ }
  }
  return (
    <section className="evidence">
      <h3>{title}{body.truncated && <span className="tag warn">truncated</span>}</h3>
      <pre className={diff ? 'diff' : ''}>
        {/* Display only: drop the diff library's Index/==== header; the stored patch is unchanged. */}
        {diff ? text.split('\n').filter(line => !/^Index: /.test(line) && !/^=+$/.test(line)).map((line, i) => <span key={i} className={line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : ''}>{line}{'\n'}</span>) : text}
      </pre>
    </section>
  );
}
