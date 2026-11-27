import { useEffect, useRef, useState, type ReactNode } from 'react';

type Pt = [number, number];   // 0〜1 の相対座標（画面の大きさが変わってもずれない）

/**
 * 問題の画像に Apple Pencil で線を書き込む透明な下敷き（消去法用）
 * - Pencil（Mac ではマウス）で書き、指ではスクロール
 * - 保存しない。問題が変わると消える（呼び出し側で key を変える）
 */
export function InkLayer({ children }: { children: ReactNode }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Pt[][]>([]);
  const current = useRef<Pt[] | null>(null);
  const [count, setCount] = useState(0);

  const redraw = () => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (const s of strokes.current) drawStroke(ctx, cv, s);
  };

  // 下の画像の大きさに合わせてキャンバスを作り直す
  useEffect(() => {
    const wrap = wrapRef.current, cv = canvasRef.current;
    if (!wrap || !cv) return;
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.round(wrap.clientWidth * dpr);
      cv.height = Math.round(wrap.clientHeight * dpr);
      redraw();
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // iPad: Pencil のときだけスクロールを止める（指はそのままスクロール）
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const stop = (e: TouchEvent) => {
      if ([...e.touches].some((t) => (t as Touch & { touchType?: string }).touchType === 'stylus')) e.preventDefault();
    };
    cv.addEventListener('touchstart', stop, { passive: false });
    cv.addEventListener('touchmove', stop, { passive: false });
    return () => { cv.removeEventListener('touchstart', stop); cv.removeEventListener('touchmove', stop); };
  }, []);

  const toPt = (e: { clientX: number; clientY: number }): Pt => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };
  const canDraw = (e: React.PointerEvent) => e.pointerType === 'pen' || e.pointerType === 'mouse';

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canDraw(e)) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    current.current = [toPt(e)];
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const s = current.current;
    if (!s) return;
    const evs = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
    for (const ev of evs) s.push(toPt(ev));
    const cv = canvasRef.current!;
    drawStroke(cv.getContext('2d')!, cv, s.slice(-evs.length - 1));
  };
  const onUp = () => {
    const s = current.current;
    current.current = null;
    if (s && s.length > 1) { strokes.current.push(s); setCount(strokes.current.length); }
  };

  const undo = () => { strokes.current.pop(); setCount(strokes.current.length); redraw(); };
  const clear = () => { strokes.current = []; setCount(0); redraw(); };

  return (
    <div className="ink">
      <div className="ink-bar">
        <span className="muted small">✏️ Pencil で線を引けます（指でスクロール）</span>
        <button className="small-btn" disabled={!count} onClick={undo}>↶ 1本戻す</button>
        <button className="small-btn" disabled={!count} onClick={clear}>全部消す</button>
      </div>
      <div className="ink-wrap" ref={wrapRef}>
        {children}
        <canvas
          ref={canvasRef}
          className="ink-canvas"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
      </div>
    </div>
  );
}

function drawStroke(ctx: CanvasRenderingContext2D, cv: HTMLCanvasElement, s: Pt[]) {
  if (s.length < 2) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.strokeStyle = 'rgba(220, 30, 30, 0.85)';
  ctx.lineWidth = 2.5 * dpr;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(s[0][0] * cv.width, s[0][1] * cv.height);
  for (const [x, y] of s.slice(1)) ctx.lineTo(x * cv.width, y * cv.height);
  ctx.stroke();
}
