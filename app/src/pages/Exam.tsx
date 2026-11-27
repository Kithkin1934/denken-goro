import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, groupCards, recordAnswer } from '../db';
import { examSortKeyOf, ratingFor } from '../srs';
import { SUBJECTS, type Card, type Subject } from '../types';
import { go } from '../App';
import { CardImages } from '../components/CardImages';
import { InkLayer } from '../components/InkLayer';

/** 試験時間（分） */
const LIMIT_MIN: Record<Subject, number> = { 理論: 90, 機械: 90, 法規: 65 };
const PASS = 60;
const STATE_KEY = 'mockExam';
const HISTORY_KEY = 'mockExamHistory';

/** 途中の試験（閉じても続きから再開できるよう localStorage に保存） */
interface ExamState {
  subject: Subject;
  exam: string;
  groups: string[][];              // 1問 = 小問の cardId の組
  answers: Record<string, number>;
  elapsed: number;                 // 解いていた時間（ミリ秒）。アプリを閉じている間は進まない
  limit: number;                   // 制限時間（ミリ秒）
  cur: number;
  startedAt: number;
}
interface HistoryItem { subject: Subject; exam: string; at: number; score: number; correct: number; total: number; elapsed: number }

const loadState = (): ExamState | null => { try { return JSON.parse(localStorage.getItem(STATE_KEY) ?? 'null'); } catch { return null; } };
const saveState = (s: ExamState | null) => s ? localStorage.setItem(STATE_KEY, JSON.stringify(s)) : localStorage.removeItem(STATE_KEY);
const loadHistory = (): HistoryItem[] => { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]'); } catch { return []; } };
const clock = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
/** 100点満点に換算（理論・機械は1問5点でちょうど100点。法規・除外のある回は正解の割合で換算） */
const scoreOf = (correct: number, total: number) => (total ? Math.round((correct / total) * 100) : 0);

export default function Exam() {
  const [state, setState] = useState<ExamState | null>(loadState);
  const [result, setResult] = useState<{ st: ExamState; cards: Card[] } | null>(null);
  const update = (s: ExamState | null) => { saveState(s); setState(s); };

  if (result) return <ExamResult st={result.st} cards={result.cards} onClose={() => setResult(null)} />;
  if (state) return <ExamRun st={state} update={update} onFinish={(st, cards) => { update(null); setResult({ st, cards }); }} />;
  return <ExamSetup onStart={update} />;
}

// ---- 1. 科目と回を選ぶ ----
function ExamSetup({ onStart }: { onStart: (s: ExamState) => void }) {
  const [subject, setSubject] = useState<Subject>('理論');
  const [exam, setExam] = useState<string | null>(null);
  const exams = useLiveQuery(async () => {
    const cards = await db.cards.where({ subject }).toArray();
    const by = new Map<string, Card[]>();
    for (const c of cards) by.set(c.exam, [...(by.get(c.exam) ?? []), c]);
    return [...by.entries()].sort((a, b) => examSortKeyOf(b[0]) - examSortKeyOf(a[0]));
  }, [subject]);
  const history = loadHistory();
  const cards = exams?.find(([e]) => e === exam)?.[1] ?? [];
  // 選択問題（理論・機械の問17と問18）: 両方あればどちらかを選ぶ
  const has17 = cards.some((c) => c.number === 17), has18 = cards.some((c) => c.number === 18);
  const choose = subject !== '法規' && has17 && has18;

  const start = async (skip: number | null) => {
    if (!exam) return;
    const use = cards.filter((c) => c.number !== skip)
      .sort((a, b) => a.number - b.number || (a.sub ?? '').localeCompare(b.sub ?? ''));
    const groups = (await groupCards(use)).map((g) => g.map((c) => c.id));
    onStart({ subject, exam, groups, answers: {}, elapsed: 0, limit: LIMIT_MIN[subject] * 60000, cur: 0, startedAt: Date.now() });
  };

  return (
    <div className="page">
      <header className="top">
        <button className="ghost" onClick={() => go('/')}>←</button>
        <h1>模擬試験</h1>
        <div className="seg">
          {SUBJECTS.map((s) => <button key={s} className={s === subject ? 'on' : ''} onClick={() => { setSubject(s); setExam(null); }}>{s}</button>)}
        </div>
      </header>
      <div className="panel">
        <h2>回を選ぶ</h2>
        <p className="muted small">試験時間 {LIMIT_MIN[subject]}分・100点満点・{PASS}点で合格。試験中は正解を表示しません。閉じても続きから再開できます。</p>
        <div className="exam-list">
          {exams?.map(([e, cs]) => {
            const best = history.filter((h) => h.subject === subject && h.exam === e).sort((a, b) => b.score - a.score)[0];
            return (
              <button key={e} className={e === exam ? 'on' : ''} onClick={() => setExam(e)}>
                <b>{e}</b><span>{new Set(cs.map((c) => c.number)).size}問</span>
                {best && <span className={best.score >= PASS ? 'pass' : 'fail'}>最高 {best.score}点</span>}
              </button>
            );
          })}
        </div>
        {exams?.length === 0 && <p className="muted">この科目の問題はまだありません。</p>}
      </div>
      {exam && (
        <div className="panel">
          <h2>{subject} {exam}</h2>
          {choose ? (
            <>
              <p>問17と問18は選択問題です。どちらを解きますか？</p>
              <div className="row">
                <button className="primary" onClick={() => start(18)}>問17を解く</button>
                <button className="primary" onClick={() => start(17)}>問18を解く</button>
              </div>
            </>
          ) : <button className="primary big-btn" onClick={() => start(null)}>試験を始める</button>}
        </div>
      )}
      {history.length > 0 && (
        <div className="panel">
          <h2>これまでの結果</h2>
          <table className="table">
            <thead><tr><th>日</th><th>回</th><th>点数</th><th>正解</th><th>時間</th></tr></thead>
            <tbody>
              {[...history].reverse().slice(0, 20).map((h, i) => (
                <tr key={i}>
                  <td>{new Date(h.at).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })}</td>
                  <td>{h.subject} {h.exam}</td>
                  <td className={h.score >= PASS ? 'pass' : 'fail'}>{h.score}点</td>
                  <td>{h.correct}/{h.total}</td>
                  <td>{clock(h.elapsed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- 2. 試験中 ----
function ExamRun({ st, update: save, onFinish }: { st: ExamState; update: (s: ExamState | null) => void; onFinish: (st: ExamState, cards: Card[]) => void }) {
  const [cards, setCards] = useState<Map<string, Card> | null>(null);
  const [elapsed, setElapsed] = useState(st.elapsed);
  const [confirm, setConfirm] = useState(false);
  // 最新の状態（タイマーで毎秒進む経過時間を含む）はここに持つ
  const stRef = useRef(st);
  const update = (s: ExamState | null) => { if (s) stRef.current = s; save(s); };
  const finishing = useRef(false);

  useEffect(() => {
    (async () => {
      const list = await db.cards.bulkGet(st.groups.flat());
      setCards(new Map(list.filter((c): c is Card => !!c).map((c) => [c.id, c])));
    })();
  }, [st.groups]);

  // タイマー: 1秒ごとに進め、保存する。画面を開いている間だけ進む
  useEffect(() => {
    let last = Date.now();
    const t = setInterval(() => {
      const now = Date.now();
      const dt = document.visibilityState === 'visible' ? Math.min(now - last, 5000) : 0;
      last = now;
      const s = stRef.current;
      const next = { ...s, elapsed: s.elapsed + dt };
      setElapsed(next.elapsed);
      saveState(next);
      stRef.current = next;
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const finish = async () => {
    if (finishing.current || !cards) return;
    finishing.current = true;
    const s = { ...stRef.current };
    const all = s.groups.flat().map((id) => cards.get(id)).filter((c): c is Card => !!c);
    // 答えた問題は忘却曲線の記録にも入れる（語呂の自己評価なし）。答えていない問題は記録しない
    const at = Date.now();
    for (const c of all) {
      const n = s.answers[c.id];
      if (n == null) continue;
      const ok = n === c.answer;
      await recordAnswer({ cardId: c.id, at, chosen: n, correct: ok, goroRecalled: null, durationMs: s.elapsed / all.length, mode: 'exam' }, ratingFor(ok, null, Infinity));
    }
    const correct = all.filter((c) => s.answers[c.id] === c.answer).length;
    const item: HistoryItem = { subject: s.subject, exam: s.exam, at, score: scoreOf(correct, all.length), correct, total: all.length, elapsed: s.elapsed };
    localStorage.setItem(HISTORY_KEY, JSON.stringify([...loadHistory(), item]));
    onFinish(s, all);
  };

  const left = st.limit - elapsed;
  useEffect(() => { if (left <= 0) finish(); }, [left <= 0, cards]);   // 時間切れで自動終了

  if (!cards) return <div className="page"><p className="muted">読み込み中…</p></div>;
  const group = st.groups[st.cur].map((id) => cards.get(id)).filter((c): c is Card => !!c);
  const head = group[0];
  const setCur = (i: number) => { update({ ...stRef.current, cur: i }); window.scrollTo(0, 0); };
  const pick = (c: Card, n: number) => {
    const s = stRef.current;
    const answers = { ...s.answers };
    if (answers[c.id] === n) delete answers[c.id]; else answers[c.id] = n;   // 同じ番号をもう一度押すと取り消し
    update({ ...s, answers });
  };
  const answeredGroups = st.groups.filter((g) => g.every((id) => st.answers[id] != null)).length;

  return (
    <div className="page practice exam-run">
      <header className="top">
        <span className="title">{st.subject} {st.exam}　問{head?.number}</span>
        <span className={`timer${left < 5 * 60000 ? ' low' : ''}`}>残り {clock(left)}</span>
        <button className="small-btn" onClick={() => setConfirm(true)}>試験を終える</button>
      </header>
      {confirm && (
        <div className="modal-bg" onClick={() => setConfirm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>試験を終えて採点しますか？</h2>
            <p>答えた問題 {answeredGroups} / {st.groups.length}</p>
            <div className="row">
              <button className="primary" onClick={finish}>採点する</button>
              <button onClick={() => setConfirm(false)}>続ける</button>
              <button className="danger" onClick={() => { if (window.confirm('採点せずに試験をやめますか？（記録は残りません）')) { update(null); go('/'); } }}>採点せずにやめる</button>
            </div>
          </div>
        </div>
      )}

      <nav className="exam-nav">
        {st.groups.map((g, i) => {
          const c = cards.get(g[0]);
          const done = g.every((id) => st.answers[id] != null), some = g.some((id) => st.answers[id] != null);
          return <button key={i} className={`${i === st.cur ? 'cur' : ''} ${done ? 'done' : some ? 'some' : ''}`} onClick={() => setCur(i)}>{c?.number}</button>;
        })}
      </nav>

      {head && (
        <InkLayer key={st.cur}>
          <CardImages card={head} kind="q" />
        </InkLayer>
      )}

      <div className="answer-area">
        {group.map((c) => (
          <div key={c.id} className="sub-row">
            {group.length > 1 && <div className="sub-hint">({c.sub})</div>}
            <div className={`choices${group.length > 1 ? ' multi' : ''}`}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} className={`choice${st.answers[c.id] === n ? ' picked' : ''}`} onClick={() => pick(c, n)}>({n})</button>
              ))}
            </div>
          </div>
        ))}
        <div className="row exam-move">
          <button disabled={st.cur === 0} onClick={() => setCur(st.cur - 1)}>← 前の問題</button>
          {st.cur < st.groups.length - 1
            ? <button className="primary" onClick={() => setCur(st.cur + 1)}>次の問題 →</button>
            : <button className="primary" onClick={() => setConfirm(true)}>試験を終える</button>}
        </div>
      </div>
    </div>
  );
}

// ---- 3. 結果 ----
function ExamResult({ st, cards, onClose }: { st: ExamState; cards: Card[]; onClose: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const correct = cards.filter((c) => st.answers[c.id] === c.answer).length;
  const score = scoreOf(correct, cards.length);
  const pass = score >= PASS;
  return (
    <div className="page">
      <header className="top"><h1>模擬試験の結果</h1></header>
      <div className={`panel result-sum ${pass ? 'pass' : 'fail'}`}>
        <div className="muted">{st.subject} {st.exam}</div>
        <div className="big">{score}<small>点</small></div>
        <div className="verdict-line">{pass ? '合格ライン（60点）を超えました 🎉' : `合格まであと ${PASS - score}点`}</div>
        <div className="muted">正解 {correct} / {cards.length}・かかった時間 {clock(st.elapsed)}（制限 {clock(st.limit)}）</div>
      </div>
      <div className="panel">
        <h2>問題ごとの結果</h2>
        <ul className="list exam-review">
          {cards.map((c) => {
            const n = st.answers[c.id];
            const ok = n === c.answer;
            return (
              <li key={c.id}>
                <button className="link-btn" onClick={() => setOpen(open === c.id ? null : c.id)}>
                  <span className={ok ? 'pass' : 'fail'}>{ok ? '○' : '×'}</span> 問{c.number}{c.sub ? `(${c.sub})` : ''}
                  　あなた {n == null ? '未回答' : `(${n})`} ／ 正解 ({c.answer})　{!ok && <small className="muted">{open === c.id ? '語呂を閉じる' : '語呂を見る'}</small>}
                </button>
                {open === c.id && <div className="exam-goro"><CardImages card={c} kind="g" /></div>}
              </li>
            );
          })}
        </ul>
      </div>
      <div className="row">
        <button className="primary" onClick={() => go('/')}>ホームへ</button>
        <button onClick={onClose}>別の回を解く</button>
      </div>
    </div>
  );
}
