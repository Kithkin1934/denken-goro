import { useEffect, useRef, useState } from 'react';
import { db, buildQueue, recordAnswer, setGoroRecalled } from '../db';
import { dueLabel, ratingFor, review, type SrsState } from '../srs';
import type { Card } from '../types';
import { go } from '../App';
import { CardImages, cardTitle } from '../components/CardImages';
import { ReportDialog } from '../components/ReportDialog';

interface Props { subject?: string | null; count?: number; cardId?: string; mode?: 'today' | 'extra' }
interface Result { card: Card; chosen: number; correct: boolean }

export default function Practice({ subject = null, count = 20, cardId, mode = 'today' }: Props) {
  const [queue, setQueue] = useState<Card[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [chosen, setChosen] = useState<number | null>(null);
  const [answeredAt, setAnsweredAt] = useState(0);
  const [duration, setDuration] = useState(0);
  const prevSrs = useRef<SrsState | undefined>(undefined);
  const [results, setResults] = useState<Result[]>([]);
  const [reporting, setReporting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const requeued = useRef(new Set<string>());
  const shownAt = useRef(Date.now());

  useEffect(() => {
    (async () => {
      if (cardId) {
        const c = await db.cards.get(cardId);
        setQueue(c ? [c] : []);
      } else setQueue(await buildQueue(subject, count, mode));
    })();
  }, [subject, count, cardId, mode]);

  useEffect(() => { shownAt.current = Date.now(); window.scrollTo(0, 0); }, [idx]);

  if (!queue) return <div className="page"><p className="muted">読み込み中…</p></div>;
  if (queue.length === 0) {
    return (
      <div className="page">
        <div className="panel result-sum">
          <div className="big">🎉</div>
          <p>{mode === 'today' ? '今日の復習は終わりました。' : '出せる問題がありません。'}</p>
        </div>
        <div className="row">
          <button className="primary" onClick={() => go('/')}>ホームへ</button>
          {mode === 'today' && <button onClick={() => go(`/practice?${subject ? `subject=${subject}&` : ''}n=${count}&mode=extra`)}>もっと解く（先取り）</button>}
        </div>
      </div>
    );
  }

  if (idx >= queue.length) {
    const ok = results.filter((r) => r.correct).length;
    const wrong = results.filter((r) => !r.correct);
    return (
      <div className="page">
        <header className="top"><h1>結果</h1></header>
        <div className="panel result-sum">
          <div className="big">{ok} / {results.length}</div>
          <div className="muted">正解（やり直しを含む）</div>
        </div>
        {wrong.length > 0 && (
          <div className="panel">
            <h2>間違えた問題</h2>
            <ul className="list">
              {wrong.map((r, i) => (
                <li key={i}><a href={`#/card/${encodeURIComponent(r.card.id)}`}>{cardTitle(r.card)}</a>　あなた ({r.chosen}) → 正解 ({r.card.answer})</li>
              ))}
            </ul>
          </div>
        )}
        <div className="row">
          <button className="primary" onClick={() => go('/')}>ホームへ</button>
          {!cardId && <button onClick={() => location.reload()}>続けて解く</button>}
        </div>
      </div>
    );
  }

  const card = queue[idx];
  const answered = chosen != null;
  const correct = chosen === card.answer;

  const answer = async (n: number) => {
    if (answered) return;
    const at = Date.now();
    setChosen(n);
    setAnsweredAt(at);
    const ok = n === card.answer;
    const dur = at - shownAt.current;
    setDuration(dur);
    setResults((r) => [...r, { card, chosen: n, correct: ok }]);
    // ひとまず「正解＝思い出せた」として記録し、語呂の自己評価ボタンで付け直す
    prevSrs.current = await recordAnswer(
      { cardId: card.id, at, chosen: n, correct: ok, goroRecalled: null, durationMs: dur, mode: cardId ? 'single' : mode },
      ratingFor(ok, ok ? true : null, dur),
    );
    // 間違えた問題は、このセッションの数問あとにもう一度出す（1回だけ）
    if (!ok && !cardId && !requeued.current.has(card.id)) {
      requeued.current.add(card.id);
      setQueue((q) => {
        const copy = [...q!];
        copy.splice(Math.min(copy.length, idx + 4), 0, card);
        return copy;
      });
    }
  };

  const next = async (recalled: boolean | null) => {
    if (recalled != null) await setGoroRecalled(card.id, answeredAt, recalled, prevSrs.current, ratingFor(correct, recalled, duration));
    setChosen(null);
    setIdx((i) => i + 1);
  };

  // ボタンを押したときの次回出題日（目安）
  const nextLabel = (recalled: boolean) => dueLabel(review(prevSrs.current, ratingFor(correct, recalled, duration), answeredAt).due);

  return (
    <div className="page practice">
      <header className="top">
        <button className="ghost" onClick={() => go('/')}>✕</button>
        <span className="title">{cardTitle(card)}</span>
        <span className="muted">{idx + 1} / {queue.length}</span>
        <button className="report-btn" onClick={() => setReporting(true)}>⚑ 報告</button>
      </header>
      {toast && <div className="toast" onClick={() => setToast(null)}>{toast}</div>}
      {reporting && <ReportDialog card={card} onClose={(m) => { setReporting(false); if (m) { setToast(m); setTimeout(() => setToast(null), 2500); } }} />}

      <CardImages card={card} kind="q" />

      <div className="answer-area">
        {card.sub && <div className="sub-hint">({card.sub}) の答えを選んでください</div>}
        <div className="choices">
          {[1, 2, 3, 4, 5].map((n) => {
            let cls = 'choice';
            if (answered && n === card.answer) cls += ' correct';
            else if (answered && n === chosen) cls += ' wrong';
            return <button key={n} className={cls} disabled={answered} onClick={() => answer(n)}>({n})</button>;
          })}
        </div>
      </div>

      {answered && (
        <div className="reveal">
          <div className={`verdict ${correct ? 'ok' : 'ng'}`}>
            {correct ? '正解！' : `不正解　正解は (${card.answer})`}
          </div>
          <h2>語呂</h2>
          <CardImages card={card} kind="g" />
          <div className="recall">
            <button onClick={() => next(true)}>語呂を思い出せた<small>次は{nextLabel(true)}</small></button>
            <button onClick={() => next(false)}>思い出せなかった<small>次は{nextLabel(false)}</small></button>
          </div>
        </div>
      )}
    </div>
  );
}
