import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { SUBJECTS, examSortKey, type Subject } from '../types';
import { go } from '../App';
import { dueLabel } from '../srs';

export default function Browse() {
  const [subject, setSubject] = useState<Subject>('理論');
  const data = useLiveQuery(async () => {
    const cards = await db.cards.where({ subject }).toArray();
    const stats = new Map((await db.stats.toArray()).map((s) => [s.cardId, s]));
    const byExam = new Map<string, typeof cards>();
    for (const c of cards) byExam.set(c.exam, [...(byExam.get(c.exam) ?? []), c]);
    return [...byExam.entries()]
      .sort((a, b) => examSortKey(b[0]) - examSortKey(a[0]))
      .map(([exam, cs]) => ({
        exam,
        cards: cs.sort((a, b) => a.number - b.number || (a.sub ?? '').localeCompare(b.sub ?? '')).map((c) => ({ c, s: stats.get(c.id) })),
      }));
  }, [subject]);

  return (
    <div className="page">
      <header className="top">
        <button className="ghost" onClick={() => go('/')}>←</button>
        <h1>問題一覧</h1>
        <div className="seg">
          {SUBJECTS.map((s) => <button key={s} className={s === subject ? 'on' : ''} onClick={() => setSubject(s)}>{s}</button>)}
        </div>
      </header>
      {data?.length === 0 && <p className="muted">この科目の問題はまだありません。</p>}
      {data?.map(({ exam, cards }) => (
        <div key={exam} className="panel">
          <h2>{subject} {exam}</h2>
          <div className="qgrid">
            {cards.map(({ c, s }) => {
              const cls = !s ? '' : s.lastCorrect ? 'ok' : 'ng';
              const rate = s ? `${Math.round((s.corrects / s.attempts) * 100)}%` : '';
              const next = s?.srs ? dueLabel(s.srs.due) : '';
              return (
                <button key={c.id} className={`qcell ${cls}`} onClick={() => go(`/card/${encodeURIComponent(c.id)}`)}>
                  <b>{c.number}{c.sub ?? ''}</b><span>{rate}</span>{next && <span className="next">{next}</span>}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
