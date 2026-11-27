import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, dailyStats, studyStreak } from '../db';
import { SUBJECTS } from '../types';
import { retrievability } from '../srs';
import { BarChart, HBars, LineChart } from '../components/Charts';

const pct = (v: number) => `${Math.round(v * 100)}%`;
const mins = (ms: number) => {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ''}` : `${m}分`;
};

/** 学習の記録（ホーム画面の下に表示） */
export function StatsSection() {
  const [days, setDays] = useState(30);
  const data = useLiveQuery(async () => {
    const daily = await dailyStats(days);
    const streak = await studyStreak();
    const cards = await db.cards.toArray();
    const stats = new Map((await db.stats.toArray()).map((s) => [s.cardId, s]));
    const now = Date.now();
    const subjects = SUBJECTS.map((subject) => {
      let tried = 0, rSum = 0, att = 0, ok = 0;
      for (const c of cards) {
        if (c.subject !== subject) continue;
        const s = stats.get(c.id);
        if (!s?.srs) continue;
        tried++; rSum += retrievability(s.srs, now); att += s.attempts; ok += s.corrects;
      }
      return { subject, retention: tried ? rSum / tried : null, rate: att ? ok / att : null };
    });
    return { daily, streak, subjects };
  }, [days]);

  if (!data) return null;
  const { daily, streak, subjects } = data;
  const total = daily.reduce((a, d) => ({ n: a.n + d.n, ok: a.ok + d.ok, ms: a.ms + d.ms }), { n: 0, ok: 0, ms: 0 });
  const studied = daily.filter((d) => d.n > 0).length;

  return (
    <section id="stats" className="stats-section">
      <div className="section-head">
        <h2>学習の記録</h2>
        <div className="seg">
          {[7, 30].map((n) => <button key={n} className={n === days ? 'on' : ''} onClick={() => setDays(n)}>{n}日</button>)}
        </div>
      </div>

      <div className="panel stat-tiles">
        <div><b>🔥 {streak.days}<small>日</small></b><span>連続学習{!streak.today && streak.days > 0 ? '（今日はまだ）' : ''}</span></div>
        <div><b>{total.n}<small>問</small></b><span>直近{days}日で解いた数</span></div>
        <div><b>{total.n ? pct(total.ok / total.n) : '—'}</b><span>直近{days}日の正答率</span></div>
        <div><b>{mins(total.ms)}</b><span>直近{days}日の勉強時間（{studied}日）</span></div>
      </div>

      <div className="panel">
        <h2>毎日解いた数</h2>
        <BarChart data={daily.map((d) => ({ label: d.label, value: d.n }))} format={(v) => `${Math.round(v)}問`} />
      </div>
      <div className="panel">
        <h2>正答率</h2>
        <LineChart data={daily.map((d) => ({ label: d.label, value: d.n ? d.ok / d.n : null }))} format={pct} max={1} />
      </div>
      <div className="panel">
        <h2>勉強時間</h2>
        <BarChart data={daily.map((d) => ({ label: d.label, value: d.ms / 60000 }))} format={(m) => mins(m * 60000)} />
        <p className="muted small">1問あたり最大5分まで数えています（開いたままの時間は入れません）。</p>
      </div>
      <div className="panel">
        <h2>科目ごとの定着度</h2>
        <HBars rows={subjects.map((s) => ({ label: s.subject, value: s.retention }))} format={pct} />
        <p className="muted small">解いたことのある問題を、今どれくらい思い出せそうかの平均です。</p>
        <h2>科目ごとの正答率</h2>
        <HBars rows={subjects.map((s) => ({ label: s.subject, value: s.rate }))} format={pct} />
      </div>

      <details className="panel">
        <summary>表で見る</summary>
        <table className="table">
          <thead><tr><th>日</th><th>解いた数</th><th>正答率</th><th>勉強時間</th></tr></thead>
          <tbody>
            {[...daily].reverse().map((d) => (
              <tr key={d.key}><td>{d.label}</td><td>{d.n}</td><td>{d.n ? pct(d.ok / d.n) : '—'}</td><td>{d.n ? mins(d.ms) : '—'}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
