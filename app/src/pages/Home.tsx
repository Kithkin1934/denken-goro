import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, calcIds, studyStreak, exportBackup, importBackup, importPackage, newStartedToday, sendReports } from '../db';
import { SUBJECTS } from '../types';
import { getNewPerDay, isDueNow, retrievability, setNewPerDay } from '../srs';
import { go } from '../App';
import { StatsSection } from './Stats';

const isDevMac = import.meta.env.DEV && !/iPad|iPhone/.test(navigator.userAgent) && navigator.maxTouchPoints < 2;

export default function Home() {
  const fileRef = useRef<HTMLInputElement>(null);
  const backupRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [count, setCount] = useState(20);
  const [newPerDay, setNpd] = useState(getNewPerDay());

  const summary = useLiveQuery(async () => {
    const cards = await db.cards.toArray();
    const statList = await db.stats.toArray();
    const stats = new Map(statList.map((s) => [s.cardId, s]));
    const calc = await calcIds();
    const now = Date.now();
    const subjects = SUBJECTS.map((subject) => {
      const cs = cards.filter((c) => c.subject === subject);
      let tried = 0, attempts = 0, corrects = 0, due = 0, fresh = 0, rSum = 0, calcTotal = 0, calcDue = 0;
      for (const c of cs) {
        const s = stats.get(c.id);
        const isCalc = calc.has(c.id);
        if (isCalc) { calcTotal++; if (!s?.srs || isDueNow(s.srs, now)) calcDue++; }
        if (!s?.srs) { if (!isCalc) fresh++; continue; }
        tried++; attempts += s.attempts; corrects += s.corrects;
        if (isDueNow(s.srs, now) && !isCalc) due++;
        rSum += retrievability(s.srs, now);
      }
      return {
        subject, total: cs.length, exams: new Set(cs.map((c) => c.exam)).size, tried, due,
        newToday: Math.min(fresh, Math.max(0, newPerDay - newStartedToday(statList, calc, subject))),
        calcTotal, calcDue,   // 計算問題（語呂の復習とは別枠）
        rate: attempts ? corrects / attempts : null,
        retention: tried ? rSum / tried : null,   // 解いたことのある問題の、今の平均の思い出せる確率
      };
    });
    return { subjects };
  }, [newPerDay]);

  const today = useLiveQuery(async () => {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const logs = await db.reviews.where('at').aboveOrEqual(start.getTime()).toArray();
    return { n: logs.length, ok: logs.filter((l) => l.correct).length, streak: await studyStreak() };
  }, []);

  // 問題データ（zip）を読み込む。科目ごとの複数ファイルをまとめて選べる
  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    let cards = 0, exams = 0;
    try {
      for (const [i, f] of [...files].entries()) {
        const r = await importPackage(f, (m) => setMsg(`${i + 1} / ${files.length}: ${m}`));
        cards += r.cards; exams += r.exams;
      }
      setMsg(`読み込みました: ${exams}回分・${cards}問`);
    } catch (e) {
      setMsg(`読み込めませんでした: ${(e as Error).message}`);
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const saveBackup = async () => {
    const { blob, fileName, reviews } = await exportBackup();
    const file = new File([blob], fileName, { type: 'application/json' });
    // iPad では共有シートから「ファイルに保存」できる。使えなければダウンロード
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: '電験語呂のバックアップ' }); setMsg(`バックアップを作りました（解答記録 ${reviews} 件）`); return; } catch { /* キャンセル */ }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = fileName; a.click();
    setMsg(`バックアップを保存しました（解答記録 ${reviews} 件）`);
  };
  const loadBackup = async (f: File | undefined) => {
    if (!f) return;
    try {
      const r = await importBackup(f);
      setMsg(`バックアップを読み込みました（解答記録 ${r.added} 件を追加）`);
    } catch (e) {
      setMsg(`読み込めませんでした: ${(e as Error).message}`);
    }
    if (backupRef.current) backupRef.current.value = '';
  };

  // 開発中だけ: Mac の取り込み結果を直接読み込む（AirDrop 不要）
  const loadFromMac = async () => {
    try {
      setMsg('Mac から問題データを受け取っています…');
      const list: string[] = await (await fetch('/api/pack-list')).json();
      let cards = 0;
      for (const [i, exam] of list.entries()) {
        setMsg(`読み込み中 ${i + 1} / ${list.length}（${exam}）`);
        const res = await fetch(`/api/pack?exam=${encodeURIComponent(exam)}`);
        if (!res.ok) throw new Error(await res.text());
        cards += (await importPackage(new File([await res.blob()], 'pack.zip'))).cards;
      }
      setMsg(`読み込みました: ${list.length}回分・${cards}問`);
    } catch (e) {
      setMsg(`読み込めませんでした: ${(e as Error).message}`);
    }
  };

  const unsent = useLiveQuery(async () => (await db.reports.toArray()).filter((r) => !r.sent).length, []);
  const resend = async () => {
    const n = await sendReports();
    setMsg(n == null ? 'Mac に送れませんでした（Mac の開発サーバーにつないで開いてください）' : `報告を ${n} 件 Mac に送りました`);
  };

  const subjects = summary?.subjects;
  const total = subjects?.reduce((a, s) => a + s.total, 0) ?? 0;
  const changeNewPerDay = (n: number) => { setNewPerDay(n); setNpd(n); };

  return (
    <div className="page">
      <header className="top">
        <h1>電験語呂</h1>
        {today && <span className="muted">今日 {today.n}問・正解 {today.ok}</span>}
        {!!today?.streak.days && <button className="streak" onClick={() => document.getElementById('stats')?.scrollIntoView({ behavior: 'smooth' })}>🔥 {today.streak.days}日連続</button>}
      </header>

      {total === 0 && subjects && (
        <div className="panel empty">
          <p>まだ問題がありません。Mac で作った「問題データ」（.zip）を読み込んでください。</p>
        </div>
      )}

      <section className="subjects">
        {subjects?.map((s) => (
          <div key={s.subject} className="panel subject">
            <div className="subject-head">
              <h2>{s.subject}</h2>
              <span className="muted">{s.exams}回分・{s.total}問</span>
            </div>
            <div className="subject-stats">
              <div><b>{s.due}</b><span>今日の復習</span></div>
              <div><b>{s.newToday}</b><span>新しい問題</span></div>
              <div><b>{s.tried}<small>/{s.total}</small></b><span>学習済み</span></div>
              <div><b>{s.retention == null ? '—' : `${Math.round(s.retention * 100)}%`}</b><span>定着度</span></div>
              <div><b>{s.rate == null ? '—' : `${Math.round(s.rate * 100)}%`}</b><span>正答率</span></div>
            </div>
            <div className="subject-btns">
              {s.due + s.newToday > 0 || !s.total
                ? <button className="primary" disabled={!s.total} onClick={() => go(`/practice?subject=${s.subject}&n=${count}`)}>
                    {s.subject}の今日の学習 {s.due + s.newToday}
                  </button>
                : <button onClick={() => go(`/practice?subject=${s.subject}&n=${count}&mode=extra`)}>
                    今日の分は終わり 🎉　もっと解く
                  </button>}
              <button disabled={!s.tried} onClick={() => go(`/practice?subject=${s.subject}&n=${count}&mode=weak`)}>苦手集中</button>
              {s.calcTotal > 0 && (
                <button onClick={() => go(`/practice?subject=${s.subject}&n=${count}&kind=calc${s.calcDue ? '' : '&mode=extra'}`)}>
                  計算問題 {s.calcDue}<small>/{s.calcTotal}</small>
                </button>
              )}
            </div>
          </div>
        ))}
      </section>

      {total > 0 && <StatsSection />}

      <div className="panel settings">
        <div className="row">
          <span>1回の問題数</span>
          <div className="seg">
            {[10, 20, 30].map((n) => (
              <button key={n} className={n === count ? 'on' : ''} onClick={() => setCount(n)}>{n}問</button>
            ))}
          </div>
        </div>
        <div className="row">
          <span>1日に新しく解く問題（科目ごと）</span>
          <div className="seg">
            {[5, 10, 20, 30].map((n) => (
              <button key={n} className={n === newPerDay ? 'on' : ''} onClick={() => changeNewPerDay(n)}>{n}問</button>
            ))}
          </div>
        </div>
        <p className="muted small">忘れかけた頃（思い出せる確率が約90%まで下がった頃）に、もう一度出題します。</p>
      </div>

      <div className="panel row">
        <button disabled={!total} onClick={() => go('/browse')}>問題一覧</button>
        <button disabled={!total} onClick={() => go('/exam')}>模擬試験{localStorage.getItem('mockExam') ? '（途中）' : ''}</button>
        <button onClick={() => fileRef.current?.click()}>問題データを読み込む</button>
        <input ref={fileRef} type="file" accept=".zip,application/zip" multiple hidden onChange={(e) => onFiles(e.target.files)} />
        {import.meta.env.DEV && <button onClick={loadFromMac}>Mac から直接読み込む</button>}
        {isDevMac && <button onClick={() => go('/review')}>取り込み確認（Mac）</button>}
      </div>
      <div className="panel row">
        <span>学習記録</span>
        <button onClick={saveBackup}>バックアップを作る</button>
        <button onClick={() => backupRef.current?.click()}>バックアップから戻す</button>
        <input ref={backupRef} type="file" accept=".json,application/json" hidden onChange={(e) => loadBackup(e.target.files?.[0])} />
      </div>
      {!!unsent && (
        <div className="panel row">
          <span>Mac に送っていない報告が {unsent} 件あります</span>
          <button onClick={resend}>Mac に送る</button>
        </div>
      )}
      {msg && <p className="msg">{msg}</p>}
    </div>
  );
}
