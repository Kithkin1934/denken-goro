import { useState } from 'react';

/** 1系列のグラフ（日ごとの値）。タップ／ホバーした日の値を上に表示する */
export interface DayPoint { label: string; value: number | null }

const W = 640, H = 180, PAD = { l: 36, r: 12, t: 12, b: 24 };

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 5, 10].map((m) => m * p).find((x) => x >= v)!;
}

function useHover(n: number) {
  const [i, setI] = useState<number | null>(null);
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const k = Math.round(((x - PAD.l) / (W - PAD.l - PAD.r)) * n - 0.5);
    setI(Math.max(0, Math.min(n - 1, k)));
  };
  return { i, onMove, onLeave: () => setI(null) };
}

interface Props { data: DayPoint[]; format: (v: number) => string; max?: number; unit?: string }

/** 棒グラフ（例: 毎日解いた数） */
export function BarChart({ data, format, max }: Props) {
  const n = data.length;
  const top = max ?? niceMax(Math.max(0, ...data.map((d) => d.value ?? 0)));
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b, slot = iw / n;
  const bw = Math.min(24, slot - 2);
  const y = (v: number) => PAD.t + ih - (v / top) * ih;
  const h = useHover(n);
  const shown = h.i ?? lastIndex(data);
  return (
    <figure className="chart">
      <Readout d={shown != null ? data[shown] : null} format={format} />
      <svg viewBox={`0 0 ${W} ${H}`} onPointerMove={h.onMove} onPointerDown={h.onMove} onPointerLeave={h.onLeave}>
        <Axis top={top} format={format} />
        {data.map((d, i) => {
          if (!d.value) return null;
          const x = PAD.l + slot * i + (slot - bw) / 2, yy = y(d.value), hh = PAD.t + ih - yy;
          const r = Math.min(4, hh, bw / 2);
          // 上だけ角を丸める（下の基準線側は四角）
          const path = `M${x},${PAD.t + ih} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + bw - r} Q${x + bw},${yy} ${x + bw},${yy + r} V${PAD.t + ih} Z`;
          return <path key={i} d={path} className={i === shown ? 'mark on' : 'mark'} />;
        })}
        <XLabels data={data} />
        {h.i != null && <rect x={PAD.l + slot * h.i} y={PAD.t} width={slot} height={ih} className="hover-band" />}
      </svg>
    </figure>
  );
}

/** 折れ線グラフ（例: 正答率）。値のない日は線をつながない */
export function LineChart({ data, format, max }: Props) {
  const n = data.length;
  const top = max ?? niceMax(Math.max(0, ...data.map((d) => d.value ?? 0)));
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b, slot = iw / n;
  const x = (i: number) => PAD.l + slot * (i + 0.5);
  const y = (v: number) => PAD.t + ih - (v / top) * ih;
  const h = useHover(n);
  const shown = h.i ?? lastIndex(data);
  const segs: string[] = [];
  let cur = '';
  data.forEach((d, i) => {
    if (d.value == null) { if (cur) segs.push(cur); cur = ''; return; }
    cur += `${cur ? 'L' : 'M'}${x(i)},${y(d.value)} `;
  });
  if (cur) segs.push(cur);
  return (
    <figure className="chart">
      <Readout d={shown != null ? data[shown] : null} format={format} />
      <svg viewBox={`0 0 ${W} ${H}`} onPointerMove={h.onMove} onPointerDown={h.onMove} onPointerLeave={h.onLeave}>
        <Axis top={top} format={format} />
        {segs.map((p, i) => <path key={i} d={p} className="line" />)}
        {data.map((d, i) => d.value != null && (segs.length === 0 || i === shown || isLonely(data, i)) && (
          <circle key={i} cx={x(i)} cy={y(d.value)} r={i === shown ? 5 : 4} className="dot" />
        ))}
        <XLabels data={data} />
        {h.i != null && <line x1={x(h.i)} x2={x(h.i)} y1={PAD.t} y2={PAD.t + ih} className="crosshair" />}
      </svg>
    </figure>
  );
}

/** 前後に値がない点は線にならないので点で見せる */
const isLonely = (d: DayPoint[], i: number) => d[i - 1]?.value == null && d[i + 1]?.value == null;
const lastIndex = (d: DayPoint[]) => { for (let i = d.length - 1; i >= 0; i--) if (d[i].value != null) return i; return null; };

function Readout({ d, format }: { d: DayPoint | null; format: (v: number) => string }) {
  return <div className="readout">{d ? <><span className="muted">{d.label}</span> <b>{d.value == null ? '—' : format(d.value)}</b></> : <span className="muted">記録なし</span>}</div>;
}

function Axis({ top, format }: { top: number; format: (v: number) => string }) {
  const ih = H - PAD.t - PAD.b;
  return (
    <g className="axis">
      {[0, 0.5, 1].map((f) => {
        const yy = PAD.t + ih - f * ih;
        return (
          <g key={f}>
            <line x1={PAD.l} x2={W - PAD.r} y1={yy} y2={yy} />
            <text x={PAD.l - 6} y={yy + 4} textAnchor="end">{format(top * f)}</text>
          </g>
        );
      })}
    </g>
  );
}

function XLabels({ data }: { data: DayPoint[] }) {
  const n = data.length, slot = (W - PAD.l - PAD.r) / n;
  const every = Math.ceil(n / 6);
  return (
    <g className="axis">
      {data.map((d, i) => (n - 1 - i) % every === 0 && (
        <text key={i} x={PAD.l + slot * (i + 0.5)} y={H - 6} textAnchor="middle">{d.label}</text>
      ))}
    </g>
  );
}

/** 横棒（例: 科目ごとの定着度）。値は棒の先に書く */
export function HBars({ rows, format }: { rows: { label: string; value: number | null }[]; format: (v: number) => string }) {
  return (
    <div className="hbars">
      {rows.map((r) => (
        <div key={r.label} className="hbar">
          <span>{r.label}</span>
          <div className="hbar-track">
            {r.value != null && <div className="hbar-fill" style={{ width: `${Math.max(1, r.value * 100)}%` }} />}
          </div>
          <b>{r.value == null ? '—' : format(r.value)}</b>
        </div>
      ))}
    </div>
  );
}
