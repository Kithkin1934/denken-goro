// Mac 専用: 取り込み結果の確認・修正と、iPad へ送る問題データの書き出し
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ExamReview, ExtractExam, ExtractQuestion, QuestionReview, Report } from '../types';
import { examSortKey, isExcluded, SUBJECTS } from '../types';
import { go } from '../App';

interface ExamEntry { path: string; exam: ExtractExam; review: ExamReview | null }

const effAnswers = (q: ExtractQuestion, r?: QuestionReview) => r?.answers ?? q.answers;
const needsCheck = (q: ExtractQuestion, r?: QuestionReview) =>
  !isExcluded(q, r) && !r?.checked && (effAnswers(q, r).some((a) => a == null) || q.flags.length > 0);

export default function Review() {
  const [entries, setEntries] = useState<ExamEntry[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [onlyCheck, setOnlyCheck] = useState(true);
  const [zoom, setZoom] = useState<string | null>(null);
  const [packMsg, setPackMsg] = useState<string | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const [reports, setReports] = useState<Report[]>([]);
  const openReports = (qid: string) => reports.filter((r) => r.questionId === qid && !r.resolved);

  useEffect(() => {
    const load = () => fetch('/api/reports').then((r) => r.json()).then(setReports).catch(() => {});
    load();
    const t = setInterval(load, 10000); // iPad からの報告を定期的に取り込む
    return () => clearInterval(t);
  }, []);

  const resolveReport = async (id: string, resolved: boolean) => {
    setReports((rs) => rs.map((r) => (r.id === id ? { ...r, resolved } : r)));
    await fetch('/api/reports/resolve', { method: 'POST', body: JSON.stringify({ id, resolved }) });
  };

  useEffect(() => {
    fetch('/api/exams').then((r) => r.json()).then((list: ExamEntry[]) => {
      list.sort((a, b) => SUBJECTS.indexOf(a.exam.subject) - SUBJECTS.indexOf(b.exam.subject) || examSortKey(b.exam.exam) - examSortKey(a.exam.exam));
      setEntries(list);
      setSel((s) => s ?? list[0]?.path ?? null);
    });
  }, []);

  const entry = entries?.find((e) => e.path === sel) ?? null;
  const review: ExamReview = entry?.review ?? { questions: {} };

  const update = (qid: string, patch: Partial<QuestionReview>) => {
    if (!entry) return;
    const next: ExamReview = { ...review, questions: { ...review.questions, [qid]: { ...review.questions[qid], ...patch } } };
    setEntries((es) => es!.map((e) => (e.path === entry.path ? { ...e, review: next } : e)));
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      fetch('/api/review', { method: 'POST', body: JSON.stringify({ path: entry.path, review: next }) });
    }, 300);
  };

  const counts = useMemo(() => new Map((entries ?? []).map((e) => {
    const r = e.review?.questions ?? {};
    const rep = reports.filter((x) => !x.resolved && `${x.subject}/${x.exam}` === e.path).length;
    return [e.path, { total: e.exam.questions.length, check: e.exam.questions.filter((q) => needsCheck(q, r[q.id])).length, rep }];
  })), [entries, reports]);

  const exportPack = async (subject: string) => {
    setPackMsg(`${subject}を書き出し中…`);
    const res = await fetch(`/api/pack?subject=${encodeURIComponent(subject)}`);
    if (!res.ok) { setPackMsg('失敗しました: ' + (await res.text())); return; }
    const info = decodeURIComponent(res.headers.get('X-Pack-Info') ?? '');
    const enc = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get('Content-Disposition') ?? '')?.[1];
    const name = enc ? decodeURIComponent(enc) : 'denken-goro.zip';
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setPackMsg(`${name} を保存しました（${info}・${(blob.size / 1e6).toFixed(1)} MB）。AirDrop で iPad に送ってください。`);
  };

  if (!entries) return <div className="page"><p className="muted">読み込み中…</p></div>;

  const img = (f?: string) => f && entry ? `/data/${entry.path}/${f}` : undefined;
  const questions = entry?.exam.questions.filter((q) => !onlyCheck || needsCheck(q, review.questions[q.id]) || openReports(q.id).length > 0) ?? [];

  return (
    <div className="review">
      <aside>
        <div className="aside-head">
          <button className="ghost" onClick={() => go('/')}>←</button>
          <b>取り込み確認</b>
        </div>
        <div className="small">iPad 用に書き出す（科目ごと）</div>
        <div className="row">
          {SUBJECTS.map((s) => <button key={s} className="primary" onClick={() => exportPack(s)}>{s}</button>)}
        </div>
        {packMsg && <p className="small">{packMsg}</p>}
        {entries.length === 0 && <p className="small">まだ取り込み結果がありません。importer/extract を実行してください。</p>}
        <ul>
          {entries.map((e) => {
            const c = counts.get(e.path)!;
            return (
              <li key={e.path} className={e.path === sel ? 'on' : ''} onClick={() => setSel(e.path)}>
                <span>{e.exam.subject} {e.exam.exam}</span>
                <span>
                  {c.rep > 0 && <span className="badge report">報告 {c.rep}</span>}{' '}
                  <span className={c.check ? 'badge warn' : 'badge ok'}>{c.check ? `要確認 ${c.check}` : `${c.total}問 OK`}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </aside>

      <main>
        {entry && (
          <>
            <div className="review-head">
              <h1>{entry.exam.subject} {entry.exam.exam}</h1>
              <span className="muted">{entry.exam.original} ／ {entry.exam.goro ?? '語呂PDFなし'}</span>
              <label><input type="checkbox" checked={onlyCheck} onChange={(e) => setOnlyCheck(e.target.checked)} /> 要確認だけ表示</label>
            </div>
            {entry.exam.warnings.length > 0 && <p className="warn-text">⚠ {entry.exam.warnings.join(' ／ ')}</p>}
            {questions.length === 0 && <p className="muted">確認が必要な問題はありません。</p>}
            {questions.map((q) => {
              const r = review.questions[q.id] ?? {};
              const answers = effAnswers(q, r);
              const setAns = (i: number, n: number) => { const a = [...answers]; a[i] = n; update(q.id, { answers: a }); };
              return (
                <section key={q.id} className={`rq ${isExcluded(q, r) ? 'excluded' : ''}`}>
                  <div className="rq-head">
                    <b>問{q.number}</b>
                    <span className="muted">{q.part === '?' ? '' : `${q.part}問題`}{q.segment > 0 ? `・区切り${q.segment + 1}` : ''}</span>
                    {q.flags.map((f) => <span key={f} className="flag">{f}</span>)}
                  </div>
                  {reports.some((x) => x.questionId === q.id) && (
                    <ul className="report-list">
                      {reports.filter((x) => x.questionId === q.id).map((x) => (
                        <li key={x.id} className={`report-item ${x.resolved ? 'done' : ''}`}>
                          <b>⚑ {x.reason}</b>
                          <span className="grow">{x.cardId !== q.id ? `(${x.cardId.slice(-1)}) ` : ''}{x.memo}</span>
                          <span className="muted">{new Date(x.at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                          <label><input type="checkbox" checked={!!x.resolved} onChange={(e) => resolveReport(x.id, e.target.checked)} /> 対応済み</label>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="rq-body">
                    <div className="rq-imgs">
                      {q.pieces.map((p, i) => (
                        <div key={i} className="pair">
                          {p.question && <img src={img(p.question)} onClick={() => setZoom(img(p.question)!)} alt="" />}
                          {p.goro && <img src={img(p.goro)} onClick={() => setZoom(img(p.goro)!)} alt="" />}
                        </div>
                      ))}
                    </div>
                    <div className="rq-ctrl">
                      {answers.map((a, i) => (
                        <div key={i} className="ans-row">
                          <span>{answers.length > 1 ? `(${'ab'[i]})` : '正解'}</span>
                          {[1, 2, 3, 4, 5].map((n) => (
                            <button key={n} className={a === n ? 'on' : q.answerCandidates[i]?.includes(n) ? 'cand' : ''} onClick={() => setAns(i, n)}>{n}</button>
                          ))}
                        </div>
                      ))}
                      <div className="row small">
                        <button onClick={() => update(q.id, { answers: answers.length > 1 ? [answers[0]] : [answers[0], null] })}>
                          {answers.length > 1 ? '小問をまとめる' : '(a)(b) に分ける'}
                        </button>
                        <label><input type="checkbox" checked={!!r.checked} onChange={(e) => update(q.id, { checked: e.target.checked })} /> 確認済み</label>
                        <label><input type="checkbox" checked={isExcluded(q, r)} onChange={(e) => update(q.id, { excluded: e.target.checked })} /> 除外</label>
                      </div>
                      {q.goroText && <details><summary>語呂の文字</summary><pre>{q.goroText}</pre></details>}
                    </div>
                  </div>
                </section>
              );
            })}
          </>
        )}
      </main>
      {zoom && <div className="zoom" onClick={() => setZoom(null)}><img src={zoom} alt="" /></div>}
    </div>
  );
}
