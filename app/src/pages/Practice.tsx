import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, buildQueue, calcIds, groupCards, recordAnswer, setCalc, setGoroRecalled, type Kind, type QueueMode } from '../db';
import { dueLabel, ratingFor, ratingForCalc, review, type RatingName, type SrsState } from '../srs';
import type { Card } from '../types';
import { go } from '../App';
import { CardImages, cardTitle } from '../components/CardImages';
import { ReportDialog } from '../components/ReportDialog';
import { InkLayer } from '../components/InkLayer';

interface Props { subject?: string | null; count?: number; cardId?: string; mode?: QueueMode; kind?: Kind }
interface Result { card: Card; chosen: number; correct: boolean }
/** 答え合わせした小問ごとの記録（語呂の自己評価で付け直すため） */
interface Logged { at: number; dur: number; prev: SrsState | undefined }

/** 問題の見出し（小問の記号なし） */
const groupTitle = (c: Card) => `${c.subject} ${c.exam} 問${c.number}`;

export default function Practice({ subject = null, count = 20, cardId, mode = 'today', kind = 'goro' }: Props) {
  // 1組 = 1問。(a)(b) のある問題は小問をまとめて1組にし、同じ画面で続けて答える
  const [groups, setGroups] = useState<Card[][] | null>(null);
  const [gi, setGi] = useState(0);
  const [chosen, setChosen] = useState<Record<string, number>>({});
  const [checked, setChecked] = useState(false);   // 答え合わせ済みか
  const [ready, setReady] = useState(false);       // 記録が済み、次回の目安を出せるか
  const logged = useRef<Record<string, Logged>>({});
  const [results, setResults] = useState<Result[]>([]);
  const [reporting, setReporting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [showGoro, setShowGoro] = useState(false);
  const calc = useLiveQuery(calcIds, []);
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2500); };
  const requeued = useRef(new Set<string>());
  const shownAt = useRef(Date.now());

  useEffect(() => {
    (async () => {
      const cards = cardId ? [await db.cards.get(cardId)].filter((c): c is Card => !!c) : await buildQueue(subject, count, mode, kind);
      setGroups(await groupCards(cards));
    })();
  }, [subject, count, cardId, mode, kind]);

  useEffect(() => {
    shownAt.current = Date.now();
    setChosen({}); setChecked(false); setReady(false); setShowGoro(false); logged.current = {};
    window.scrollTo(0, 0);
  }, [gi]);

  const kindQuery = kind === 'calc' ? '&kind=calc' : '';
  if (!groups || !calc) return <div className="page"><p className="muted">読み込み中…</p></div>;
  if (groups.length === 0) {
    const msg = mode === 'weak' ? '苦手な問題はまだありません（解いたことのある問題から選びます）。'
      : kind === 'calc' && mode === 'today' ? '計算問題の今日の分は終わりました。'
      : mode === 'today' ? '今日の復習は終わりました。' : '出せる問題がありません。';
    return (
      <div className="page">
        <div className="panel result-sum">
          <div className="big">🎉</div>
          <p>{msg}</p>
        </div>
        <div className="row">
          <button className="primary" onClick={() => go('/')}>ホームへ</button>
          {mode === 'today' && <button onClick={() => go(`/practice?${subject ? `subject=${subject}&` : ''}n=${count}&mode=extra${kindQuery}`)}>もっと解く（先取り）</button>}
        </div>
      </div>
    );
  }

  if (gi >= groups.length) {
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

  const group = groups[gi];
  const head = group[0];
  const multi = group.length > 1;
  const allChosen = group.every((c) => chosen[c.id] != null);
  const isOk = (c: Card) => chosen[c.id] === c.answer;
  // 計算問題として解くか（問題ごとの印。途中で移すとその場で切り替わる）
  const isCalc = group.some((c) => calc.has(c.id));
  // flag: 語呂の問題は「語呂を思い出せたか」、計算問題は「自信を持って解けたか」
  const rate = (ok: boolean, flag: boolean | null, dur: number): RatingName =>
    isCalc ? ratingForCalc(ok, flag) : ratingFor(ok, flag, dur);

  const toggleCalc = async () => {
    for (const c of group) await setCalc(c.id, !isCalc);
    flash(isCalc ? '語呂の問題に戻しました（次から語呂の復習で出ます）' : '計算問題に移しました（次から計算問題で出ます）');
  };

  /** 答え合わせ: 小問ごとに記録する。時間は小問の数で割る（即答の判定を小問1つあたりで見る） */
  const check = async (picks: Record<string, number>) => {
    if (checked) return;
    setChecked(true);
    const at = Date.now();
    const dur = (at - shownAt.current) / group.length;
    let anyWrong = false;
    for (const c of group) {
      const n = picks[c.id];
      const ok = n === c.answer;
      if (!ok) anyWrong = true;
      setResults((r) => [...r, { card: c, chosen: n, correct: ok }]);
      // ひとまず「正解＝思い出せた」として記録し、語呂の自己評価ボタンで付け直す
      const prev = await recordAnswer(
        { cardId: c.id, at, chosen: n, correct: ok, goroRecalled: null, durationMs: dur, mode: (cardId ? 'single' : mode) + (isCalc ? '-calc' : '') },
        rate(ok, ok ? true : null, dur),
      );
      logged.current[c.id] = { at, dur, prev };
    }
    setReady(true);
    // 間違えた問題は、このセッションの数問あとにもう一度出す（1回だけ、小問ごとまとめて）
    if (anyWrong && !cardId && !requeued.current.has(head.questionId)) {
      requeued.current.add(head.questionId);
      setGroups((g) => {
        const copy = [...g!];
        copy.splice(Math.min(copy.length, gi + 4), 0, group);
        return copy;
      });
    }
  };

  const pick = (c: Card, n: number) => {
    if (checked) return;
    setChosen((prev) => ({ ...prev, [c.id]: n }));
    if (!multi) check({ [c.id]: n });   // 小問がなければ、選んだらすぐ答え合わせ
  };

  const next = async (flag: boolean | null) => {
    if (flag != null) {
      for (const c of group) {
        const l = logged.current[c.id];
        if (l) await setGoroRecalled(c.id, l.at, flag, l.prev, rate(isOk(c), flag, l.dur));
      }
    }
    setGi((i) => i + 1);
  };

  // ボタンを押したときの次回出題日（目安）。小問があれば早い方
  const nextLabel = (flag: boolean) => {
    const dues = group.map((c) => {
      const l = logged.current[c.id];
      return l ? review(l.prev, rate(isOk(c), flag, l.dur), l.at).due : Infinity;
    });
    return dueLabel(Math.min(...dues));
  };
  const okCount = group.filter(isOk).length;

  return (
    <div className="page practice">
      <header className="top">
        <button className="ghost" onClick={() => go('/')}>✕</button>
        <span className="title">{groupTitle(head)}{multi && <small className="muted">（{group.map((c) => `(${c.sub})`).join('')}）</small>}</span>
        {isCalc && <span className="calc-badge">計算</span>}
        {mode === 'weak' && <span className="calc-badge weak-badge">苦手</span>}
        <span className="muted">{gi + 1} / {groups.length}</span>
        <button className="small-btn" onClick={toggleCalc}>{isCalc ? '語呂へ戻す' : '計算へ移す'}</button>
        <button className="report-btn" onClick={() => setReporting(true)}>⚑ 報告</button>
      </header>
      {toast && <div className="toast" onClick={() => setToast(null)}>{toast}</div>}
      {reporting && <ReportDialog card={head} onClose={(m) => { setReporting(false); if (m) flash(m); }} />}

      {/* 消去法の線を書き込める。問題が変わると（同じ問題の出し直しでも）白紙に戻る */}
      <InkLayer key={gi}>
        <CardImages card={head} kind="q" />
      </InkLayer>

      <div className="answer-area">
        {group.map((c) => (
          <div key={c.id} className="sub-row">
            {multi && <div className="sub-hint">({c.sub})</div>}
            <div className={`choices${multi ? ' multi' : ''}`}>
              {[1, 2, 3, 4, 5].map((n) => {
                let cls = 'choice';
                if (checked && n === c.answer) cls += ' correct';
                else if (checked && n === chosen[c.id]) cls += ' wrong';
                else if (!checked && n === chosen[c.id]) cls += ' picked';
                return <button key={n} className={cls} disabled={checked} onClick={() => pick(c, n)}>({n})</button>;
              })}
            </div>
          </div>
        ))}
        {multi && !checked && (
          <button className="primary check-btn" disabled={!allChosen} onClick={() => check(chosen)}>
            {allChosen ? '答え合わせ' : 'すべての小問を選んでください'}
          </button>
        )}
      </div>

      {checked && (
        <div className="reveal">
          {multi ? (
            <div className={`verdict ${okCount === group.length ? 'ok' : 'ng'}`}>
              {group.map((c) => (
                <span key={c.id} className="sub-verdict">({c.sub}) {isOk(c) ? '正解' : `不正解 → (${c.answer})`}</span>
              ))}
            </div>
          ) : (
            <div className={`verdict ${isOk(head) ? 'ok' : 'ng'}`}>
              {isOk(head) ? '正解！' : `不正解　正解は (${head.answer})`}
            </div>
          )}
          {isCalc ? (
            <>
              {showGoro
                ? <><h2>語呂</h2><CardImages card={head} kind="g" /></>
                : <button className="ghost" onClick={() => setShowGoro(true)}>語呂を見る</button>}
              {ready && <div className="recall">
                {okCount > 0 ? (
                  <>
                    <button onClick={() => next(true)}>計算で解けた<small>次は{nextLabel(true)}</small></button>
                    <button onClick={() => next(false)}>自信なし<small>次は{nextLabel(false)}</small></button>
                  </>
                ) : <button onClick={() => next(null)}>次へ<small>次は{nextLabel(false)}</small></button>}
              </div>}
            </>
          ) : (
            <>
              <h2>語呂</h2>
              <CardImages card={head} kind="g" />
              {ready && <div className="recall">
                <button onClick={() => next(true)}>語呂を思い出せた<small>次は{nextLabel(true)}</small></button>
                <button onClick={() => next(false)}>思い出せなかった<small>次は{nextLabel(false)}</small></button>
              </div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
