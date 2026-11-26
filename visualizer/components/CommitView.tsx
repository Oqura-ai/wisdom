'use client';

import { useState } from 'react';
import type { Change, Commit, CommitSession, Index, Manifest, Piece, Reason, SessionTurns } from '@contract';
import { sessionPath } from '@contract';
import { useData, useMany } from '@/lib/data';
import { go } from '@/lib/route';
import { BASIS, HOW, STATUS, TONE, ago, plural, reasonWords, short } from '@/lib/words';
import { Avatar, Crumbs, Dot, FoundPath, Seg, StateNote } from './bits';
import { Markdown } from './Markdown';

type Tab = 'pieces' | 'guide' | 'sessions';
const LABEL: Record<Piece['state'], [string, string]> = { recorded: ['lb-rec', 'recorded'], outside: ['lb-out', 'changed outside any recorded step'], 'two-sessions': ['lb-amb', 'seen by two sessions'] };

/** Level 2: a commit. One sentence, how its record was found, then pieces · guide · sessions. */
export function CommitView({ sha, via, index, manifest, onSelect }: { sha: string; via?: string; index: Index; manifest: Manifest; onSelect: (key?: string) => void }) {
  const { data: commit, error, missing } = useData<Commit>(`commit/${sha}.json`);
  const changeId = via ?? commit?.change;
  const change = useData<Change>(changeId ? `change/${changeId}.json` : undefined).data;
  const [tab, setTab] = useState<Tab>('pieces');
  if (missing) return <StateNote title="No such commit in this build">Only commits on main since team mode and on active branches have a page. git show has the rest.</StateNote>;
  if (error) return <StateNote title="This commit could not be read">{error}</StateNote>;
  if (!commit) return <StateNote title="Reading…" />;

  const merge = commit.parents.length > 1;
  const pieces = commit.files.flatMap(f => f.pieces);
  const recorded = pieces.filter(p => p.state === 'recorded').length;
  const sessionCount = commit.sessionsNamed.length;
  const at = change ? change.commits.findIndex(c => c.sha === commit.sha) : -1;
  const standIn = change?.landed?.onMain.find(m => m.sha === commit.sha);
  const prev = at > 0 ? change!.commits[at - 1] : undefined, next = change && at >= 0 ? change.commits[at + 1] : undefined;
  const changeName = change ? (change.pr ? `#${change.pr} ${change.title}` : change.title) : '';
  const up = change?.state === 'open' ? { label: 'Active branches', open: () => go({ view: 'branches' }) } : { label: index.main, open: () => go({ view: 'main' }) };

  const kicker = change && at >= 0 ? `Commit ${at + 1} of ${change.commits.length} in ${change.pr ? `#${change.pr}` : change.branch || 'this change'}`
    : standIn ? `On ${index.main}, from ${change?.pr ? `#${change.pr}` : 'a change'} · ${HOW[change!.landed!.how]}`
    : index.changes.entries.some(e => e.kind === 'direct' && e.commit.sha === commit.sha) ? `Direct commit on ${index.main}` : 'Commit';

  const sentence = merge ? 'A merge brings one line\'s work into another; Wisdom keeps no record for merges, by design.'
    : commit.found.by === 'line' && !pieces.length ? 'Its message names a record this build does not have.'
    : !pieces.length && commit.found.by === 'unlinked' ? 'Nothing recorded explains this change.'
    : !pieces.length ? 'Its record describes no files.'
    : <>{recorded} of {plural(pieces.length, 'piece')} made in recorded steps, from {plural(sessionCount, 'session')}.
      {commit.reasons[0] && <> <span className={`t-${TONE[commit.status]}`}>{cap(reasonWords(commit.reasons[0]))}.</span></>}</>;

  return (
    <>
      <Crumbs parts={[up, ...(change ? [{ label: changeName, open: () => go({ view: 'change', id: change.id }) }] : []), { label: `commit ${short(commit.sha)}` }]}
        nav={<>{prev && <button onClick={() => go({ view: 'commit', sha: prev.sha, change: change!.id })}>‹ {short(prev.sha)}</button>}
          {next && <button onClick={() => go({ view: 'commit', sha: next.sha, change: change!.id })}>{short(next.sha)} ›</button>}</>} />
      <div className="card">
        <span className="kicker">{kicker}</span>
        <h1><span className="muted" style={{ font: '500 18px var(--mono)' }}>{short(commit.sha)}</span> {commit.subject}</h1>
        <div className="row small" style={{ marginTop: 8 }}><Avatar name={commit.author} /> {commit.author} <span className="muted">· {ago(commit.committedAt)} ·</span>
          <Dot status={commit.status} /> <span className={`t-${TONE[commit.status]}`}>{merge && commit.status === 'none' ? 'merge' : STATUS[commit.status]}</span></div>
        <p className="verdict">{sentence}</p>
        {!merge && <div style={{ marginTop: 12 }}><FoundPath used={commit.found.by} /></div>}
        <Whereabouts commit={commit} change={change} />
        <Callouts commit={commit} />
        {commit.message.trim() !== commit.subject.trim() && <details style={{ marginTop: 12 }}><summary className="small muted">Full message</summary>
          <pre className="small" style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0' }}>{commit.message}</pre></details>}
      </div>
      {(!merge || pieces.length > 0) && (
        <div className="card">
          <div style={{ marginBottom: 14 }}>
            <Seg label="Show" value={tab} onChange={setTab} options={[['pieces', `Pieces · ${pieces.length}`], ['guide', 'Guide'], ['sessions', `Sessions · ${sessionCount}`]]} />
          </div>
          {tab === 'pieces' && <Pieces commit={commit} onSelect={onSelect} />}
          {tab === 'guide' && <Guide commit={commit} />}
          {tab === 'sessions' && <Sessions commit={commit} index={index} manifest={manifest} onSelect={onSelect} />}
        </div>
      )}
    </>
  );
}

const cap = (text: string) => text ? text[0].toUpperCase() + text.slice(1) : text;

/** Where the commit stands: amended from, and how it reached main (or what it stands for there). */
function Whereabouts({ commit, change }: { commit: Commit; change?: Change }) {
  const lines: React.ReactNode[] = [];
  if (commit.from?.how === 'amend') lines.push(<>Amended: {BASIS[commit.from.basis]}, from <code>{short(commit.from.commits[0])}</code>. The record from before: <code>wisdom glance --commit {short(commit.from.commits[0])}</code>.</>);
  const landed = change?.landed;
  const standIn = landed?.onMain.find(m => m.sha === commit.sha);
  const name = change?.pr ? `#${change.pr}` : 'the change';
  if (standIn && landed) {
    if (standIn.merge) lines.push(<>The merge commit of {name}: its branch&apos;s commits are on main themselves, each with its own record.</>);
    else if (standIn.from) lines.push(<>Made by {HOW[landed.how]} from {standIn.from.commits.map((c, k) => <span key={c}>{k ? ', ' : ''}<button className="pos" onClick={() => go({ view: 'commit', sha: c, change: change!.id })}>{short(c)}</button></span>)}
      {' '}({BASIS[standIn.from.basis]}{standIn.from.basis === 'order' && <span className="t-bad">: weaker, needs attention</span>}). It has no record of its own; theirs stand for it.</>);
  } else if (landed && change?.commits.some(c => c.sha === commit.sha)) {
    if (landed.how === 'merge') lines.push(<>On main as itself, through merge commit <code>{short(landed.onMain[0].sha)}</code>.</>);
    else {
      const m = landed.onMain.find(x => x.from?.commits.includes(commit.sha));
      if (m) lines.push(<>On main as <button className="pos" onClick={() => go({ view: 'commit', sha: m.sha, change: change!.id })}>{short(m.sha)}</button>
        {landed.how === 'squash' ? <>, the squash merge of {name}; its link leads here.</> : <>, {BASIS[m.from!.basis]}{m.from!.basis === 'order' && <span className="t-bad">: weaker, needs attention</span>}.</>}</>);
    }
  } else if (change?.state === 'open' && commit.parents.length < 2) lines.push(<>Not on main yet: {name} is open.</>);
  return lines.length ? <p className="small muted" style={{ margin: '8px 0 0' }}>{lines.map((l, k) => <span key={k}>{k ? ' ' : ''}{l}</span>)}</p> : null;
}

/** The things that need attention, each said once, in the words CI uses. */
function Callouts({ commit }: { commit: Commit }) {
  const first = (code: Reason['code']) => commit.reasons.find(r => r.code === code);
  const out: React.ReactNode[] = [];
  const missing = commit.reasons.filter(r => r.code === 'session-missing');
  if (missing.length) out.push(<div key="sm" className="callout bad"><b>{missing.length === 1 ? 'Session missing' : `${missing.length} sessions missing`} on the remote</b>
    <div className="small">The record names {missing.map(r => short(r.session?.split('/').pop() ?? '')).join(', ')}; this build does not have {missing.length === 1 ? 'it' : 'them'}. Only the recorder&apos;s machine can say why.</div></div>);
  const rm = first('record-missing');
  if (rm) out.push(<div key="rm" className="callout bad"><b>Record missing on the remote</b><div className="small">{cap(rm.detail ?? commit.found.cause ?? 'its record is not here')}.</div></div>);
  const ng = first('no-guide');
  if (ng) out.push(<div key="ng" className="callout bad"><b>Guide missing</b><div className="small">{ng.detail ? `${cap(ng.detail)}. ` : ''}CI flags it until someone runs <code>wisdom guide {short(commit.sha)}</code>.</div></div>);
  const gp = first('guide-problems');
  if (gp) out.push(<div key="gp" className="callout bad"><b>The guide did not pass its check</b><div className="small">{gp.detail}. Wisdom re-ran the check on this build; the Guide tab has it.</div></div>);
  const sc = commit.reasons.filter(r => r.code === 'step-changed');
  if (sc.length) out.push(<div key="sc" className="callout bad"><b>A cited step changed</b><div className="small">{sc.map(r => r.detail).filter(Boolean).join(', ')} {sc.length === 1 ? 'is' : 'are'} no longer in {sc.length === 1 ? 'its session' : 'their sessions'} as recorded (trimmed, redacted or edited after the commit).</div></div>);
  if (first('order-link')) out.push(<div key="ol" className="callout bad"><b>Tied by position only</b><div className="small">This commit is not the same change as the one it is paired with; the pairing is a judgement of order, not of content.</div></div>);
  if (commit.status === 'none' && commit.found.cause && commit.parents.length < 2) out.push(<div key="nr" className="callout"><b>No record</b><div className="small">{cap(commit.found.cause)}.</div></div>);
  return <>{out}</>;
}

function Pieces({ commit, onSelect }: { commit: Commit; onSelect: (key?: string) => void }) {
  if (!commit.files.length) return <p className="small muted">{commit.found.by === 'unlinked' ? 'No record, so no pieces: git show has the diff.' : 'Its record describes no files.'}</p>;
  const idOf = (key: string) => short(key.split('/').pop() ?? key);
  return (
    <>
      {commit.files.map(f => (
        <div key={f.path} style={{ marginBottom: 14 }}>
          <div className="row small" style={{ padding: '4px 0' }}><code style={{ color: 'var(--ink)' }}>{f.path}</code>
            <span className="muted">{f.operation}{f.binary ? ' · binary' : ` · +${f.added} −${f.removed}`}</span></div>
          {f.pieces.map((p, k) => (
            <div key={k} className="piece">
              <span className="h-delta">{p.header}</span><span className="spacer" />
              {p.steps.map((s, j) => (
                <button key={j} className="pos" title={s.attribution ? `${s.position} · ${s.attribution}` : s.position} onClick={() => onSelect(s.turn ? `turn:${s.session}#${s.turn}` : `session:${s.session}`)}>
                  {s.position} {idOf(s.session)}</button>
              ))}
              {p.unexplained > 0 && <span className="small t-warn">{plural(p.unexplained, 'line')} no recorded step made</span>}
              <span className={`label ${LABEL[p.state][0]}`}>{LABEL[p.state][1]}</span>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

/** A guide is derived, not evidence: shown as written, under what its check found. */
function Guide({ commit }: { commit: Commit }) {
  const g = commit.guide;
  if (!g) return commit.guideMissing || commit.reasons.some(r => r.code === 'no-guide')
    ? <p className="small t-bad">No guide{commit.guideMissing ? `: ${commit.guideMissing}` : ''}. CI flags it until someone runs <code>wisdom guide {short(commit.sha)}</code>.</p>
    : <p className="small muted">No guide: {commit.files.length ? 'none was written for this commit.' : 'there is no record to build one from.'}</p>;
  const facts = [g.writer, `written ${ago(g.writtenAt)}`, g.costUsd !== undefined && `$${g.costUsd.toFixed(3)}`, g.seconds !== undefined && `${Math.round(g.seconds)} s`].filter(Boolean).join(' · ');
  return (
    <>
      <p className="small muted">Derived, not evidence. {g.problems.length ? <span className="t-bad">Its check found {plural(g.problems.length, 'problem')}:</span> : 'Its citations were checked against this build.'} · {facts}</p>
      {g.problems.length > 0 && <ul className="small t-bad" style={{ margin: '0 0 10px' }}>{g.problems.map((p, k) => <li key={k}>{p}</li>)}</ul>}
      <div className="guide"><Markdown text={g.text} /></div>
    </>
  );
}

function Sessions({ commit, index, manifest, onSelect }: { commit: Commit; index: Index; manifest: Manifest; onSelect: (key?: string) => void }) {
  const listings = useMany<SessionTurns>(commit.sessionsNamed.map(s => `${sessionPath(s.key)}/index.json`).filter(path => path in manifest.files));
  if (!commit.sessionsNamed.length) return <p className="small muted">No session points to this commit.</p>;
  // A commit on main made from others stands for them: their turns are "this commit" here.
  const self = new Set([commit.sha, ...(commit.from && commit.from.how !== 'amend' ? commit.from.commits : [])]);
  return (
    <>
      <p className="small muted" style={{ margin: 0 }}>Every turn, tagged by the commit that points to it · click a turn to read it in the panel</p>
      {commit.sessionsNamed.map(s => <SessionBlock key={s.key} s={s} commit={commit} self={self} summary={index.sessions.find(x => x.key === s.key)}
        listing={listings?.find(l => l?.key === s.key)} onSelect={onSelect} />)}
    </>
  );
}

function SessionBlock({ s, commit, self, summary, listing, onSelect }: { s: CommitSession; commit: Commit; self: Set<string>;
  summary?: Index['sessions'][number]; listing?: SessionTurns; onSelect: (key?: string) => void }) {
  // The turns this commit's pieces name, or the record's window.
  const mine = new Set(commit.files.flatMap(f => f.pieces.flatMap(p => p.steps.filter(x => x.session === s.key && x.turn).map(x => x.turn!))));
  if (s.turns) for (let t = s.turns[0]; t <= s.turns[1]; t++) mine.add(t);
  const window = mine.size ? `t${Math.min(...mine)}${mine.size > 1 ? `–t${Math.max(...mine)}` : ''}` : '';
  return (
    <div className="sess">
      <header>
        <code>{short(s.id)}</code> <Avatar name={s.person} /> <span style={{ fontWeight: 500 }}>{summary?.title || s.id}</span><span className="spacer" />
        <span className={`small ${s.present ? 'muted' : 't-bad'}`}>{s.present ? `${s.harness} · ${plural(summary?.turns ?? 0, 'turn')}` : 'not on the remote'}</span>
        <button className="pos" onClick={() => onSelect(`session:${s.key}`)}>In the panel ›</button>
      </header>
      {!s.present ? (
        <div className="tline" style={{ cursor: 'default' }}><code></code><span className="req t-bad">The record says this commit came from {window || 'it'}; their text can&apos;t be read here.</span><span /></div>
      ) : listing ? listing.turnList.map(t => {
        const here = t.cited.some(c => self.has(c)) || mine.has(t.turn);
        const other = t.cited.find(c => !self.has(c));
        return (
          <div key={t.turn} className={`tline ${here ? 'here' : ''}`} onClick={() => onSelect(`turn:${s.key}#${t.turn}`)}>
            <code>t{t.turn}</code><span className="req">{t.request}</span>
            {here ? <span className="tag this">this commit</span> : other ? <span className="tag">{short(other)}</span> : <span className="tag none">no commit</span>}
          </div>
        );
      }) : (
        <div className="tline" style={{ cursor: 'default' }}><code></code><span className="req muted">This commit points to {window || 'no turn'}; this build has no turn text for the session.</span><span /></div>
      )}
    </div>
  );
}
