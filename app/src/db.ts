import Dexie, { type EntityTable } from 'dexie';
import { unzipSync, strFromU8 } from 'fflate';
import type { Card, PackManifest, Report } from './types';
import { endOfToday, examSortKeyOf, getNewPerDay, isDueNow, ratingFor, retrievability, review, startOfToday, type RatingName, type SrsState } from './srs';

export interface ImageRow { path: string; blob: Blob }

/** 1回の解答記録 */
export interface ReviewLog {
  id?: number;
  cardId: string;
  at: number;
  chosen: number;
  correct: boolean;
  goroRecalled: boolean | null;
  durationMs: number;
  mode: string;
}

/** 問題ごとの学習状態 */
export interface CardStat {
  cardId: string;
  attempts: number;
  corrects: number;
  lastAt: number;
  lastCorrect: boolean;
  streak: number;      // 連続正解数（間違えると 0）
  firstAt?: number;    // 初めて解いた日時
  srs?: SrsState;      // FSRS の状態
  due?: number;        // 次に出す日時（srs.due と同じ。検索用）
}

/** 問題の種類の印（計算問題として解くか）。問題データを読み込み直しても残る */
export interface CardTag { cardId: string; calc: boolean; at: number }
export type Kind = 'goro' | 'calc';

export const db = new Dexie('denken-goro') as Dexie & {
  cards: EntityTable<Card, 'id'>;
  images: EntityTable<ImageRow, 'path'>;
  reviews: EntityTable<ReviewLog, 'id'>;
  stats: EntityTable<CardStat, 'cardId'>;
  reports: EntityTable<Report, 'id'>;
  tags: EntityTable<CardTag, 'cardId'>;
};

db.version(1).stores({
  cards: 'id, subject, exam, questionId',
  images: 'path',
  reviews: '++id, cardId, at',
  stats: 'cardId, lastAt',
});
db.version(2).stores({ reports: 'id, cardId, at' });
// v3: FSRS を導入。これまでの解答記録を順に当てはめて、問題ごとの状態を作る
db.version(3).stores({ stats: 'cardId, lastAt, due' }).upgrade((tx) => migrateToFsrs(tx));
// v4: 計算問題の印
db.version(4).stores({ tags: 'cardId' });

/** 計算問題に移した問題の id */
export async function calcIds(): Promise<Set<string>> {
  return new Set((await db.tags.toArray()).filter((t) => t.calc).map((t) => t.cardId));
}

/** 計算問題へ移す／語呂へ戻す */
export async function setCalc(cardId: string, calc: boolean) {
  await db.tags.put({ cardId, calc, at: Date.now() });
}

export async function migrateToFsrs(tx: { table: (name: string) => Dexie.Table }) {
  const logs = (await tx.table('reviews').toArray()) as ReviewLog[];
  logs.sort((a, b) => a.at - b.at);
  const byCard = new Map<string, ReviewLog[]>();
  for (const l of logs) byCard.set(l.cardId, [...(byCard.get(l.cardId) ?? []), l]);
  const stats = (await tx.table('stats').toArray()) as CardStat[];
  for (const st of stats) {
    const list = byCard.get(st.cardId) ?? [];
    let srs: SrsState | undefined;
    for (const l of list) srs = review(srs, ratingFor(l.correct, l.goroRecalled, Infinity), l.at);
    st.firstAt = list[0]?.at ?? st.lastAt;
    if (srs) { st.srs = srs; st.due = srs.due; }
  }
  await tx.table('stats').bulkPut(stats);
  console.info(`FSRS: ${stats.length}問の学習記録を変換しました`);
}

/** 問題データ（zip）を読み込む。学習記録はそのまま残す */
export async function importPackage(file: File, onProgress?: (msg: string) => void) {
  onProgress?.('ファイルを展開しています…');
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const mf = files['manifest.json'];
  if (!mf) throw new Error('問題データのファイルではありません（manifest.json がありません）');
  const manifest = JSON.parse(strFromU8(mf)) as PackManifest;
  if (manifest.version !== 1) throw new Error('対応していない形式です');

  const images: ImageRow[] = [];
  for (const [path, data] of Object.entries(files)) {
    if (path.endsWith('.jpg')) images.push({ path, blob: new Blob([data as BlobPart], { type: 'image/jpeg' }) });
  }
  onProgress?.(`保存しています…（${manifest.cards.length}問・画像${images.length}枚）`);
  await db.transaction('rw', db.cards, db.images, async () => {
    // 同じ回の古いデータは入れ替える（学習記録は cardId が同じなら引き継がれる）
    const exams = new Set(manifest.cards.map((c) => `${c.subject}/${c.exam}`));
    const old = await db.cards.filter((c) => exams.has(`${c.subject}/${c.exam}`)).primaryKeys();
    await db.cards.bulkDelete(old);
    await db.cards.bulkPut(manifest.cards);
    await db.images.bulkPut(images);
  });
  return { cards: manifest.cards.length, images: images.length, exams: new Set(manifest.cards.map((c) => c.subject + c.exam)).size };
}

/** 解答を記録し、FSRS の状態を更新する。更新前の状態を返す（語呂の自己評価で付け直すため） */
export async function recordAnswer(log: Omit<ReviewLog, 'id'>, rating: RatingName): Promise<SrsState | undefined> {
  let prev: SrsState | undefined;
  await db.transaction('rw', db.reviews, db.stats, async () => {
    await db.reviews.add(log);
    const s = (await db.stats.get(log.cardId)) ?? { cardId: log.cardId, attempts: 0, corrects: 0, lastAt: 0, lastCorrect: false, streak: 0, firstAt: log.at };
    prev = s.srs;
    s.attempts++;
    if (log.correct) { s.corrects++; s.streak++; } else s.streak = 0;
    s.lastAt = log.at;
    s.lastCorrect = log.correct;
    s.firstAt ??= log.at;
    s.srs = review(prev, rating, log.at);
    s.due = s.srs.due;
    await db.stats.put(s);
  });
  return prev;
}

/** 語呂を思い出せたかを記録し、評価を付け直す */
export async function setGoroRecalled(cardId: string, at: number, recalled: boolean, prev: SrsState | undefined, rating: RatingName) {
  await db.transaction('rw', db.reviews, db.stats, async () => {
    const r = await db.reviews.where({ cardId }).filter((x) => x.at === at).first();
    if (r?.id != null) await db.reviews.update(r.id, { goroRecalled: recalled });
    const s = await db.stats.get(cardId);
    if (s) {
      s.srs = review(prev, rating, at);
      s.due = s.srs.due;
      await db.stats.put(s);
    }
  });
}

/** 今日その科目で新しく解き始めた問題の数（計算問題は数えない） */
export function newStartedToday(stats: CardStat[], calc: Set<string>, subject: string): number {
  const start = startOfToday();
  return stats.filter((s) => (s.firstAt ?? 0) >= start && !calc.has(s.cardId) && s.cardId.startsWith(`${subject}-`)).length;
}

/**
 * 出題する問題を選ぶ
 * - today: 今日が期限の問題（思い出せる確率が低い順）＋ 新しい問題（1日の上限まで）
 * - kind: goro は語呂の問題だけ、calc は計算問題に移した問題だけ
 * - extra: 今日の分が終わったあとの追加。新しい問題と、思い出せる確率が低い問題から
 */
export async function buildQueue(subject: string | null, max: number, mode: 'today' | 'extra', kind: Kind = 'goro'): Promise<Card[]> {
  const calc = await calcIds();
  const all = subject ? await db.cards.where({ subject }).toArray() : await db.cards.toArray();
  const cards = all.filter((c) => calc.has(c.id) === (kind === 'calc'));
  const statList = await db.stats.toArray();
  const stats = new Map(statList.map((s) => [s.cardId, s]));
  const now = Date.now(), end = endOfToday();
  // 新しい問題は、新しい回から順に（本番に近い傾向から覚える）。同じ回の中は問番号順
  const fresh = cards.filter((c) => !stats.get(c.id)?.srs)
    .sort((a, b) => examSortKeyOf(b.exam) - examSortKeyOf(a.exam) || a.subject.localeCompare(b.subject) || a.number - b.number || (a.sub ?? '').localeCompare(b.sub ?? ''));
  const seen = cards.filter((c) => stats.get(c.id)?.srs)
    .map((c) => ({ c, s: stats.get(c.id)!.srs!, r: retrievability(stats.get(c.id)!.srs, now) }));

  if (mode === 'today') {
    const due = seen.filter((x) => isDueNow(x.s, now)).sort((a, b) => a.r - b.r).map((x) => x.c);
    // 新しい問題の1日の上限は科目ごと。計算問題は自分で選んだ少数なので上限をかけない
    const newLeft = kind === 'calc' ? Infinity
      : subject ? Math.max(0, getNewPerDay() - newStartedToday(statList, calc, subject))
      : 0;
    const take = due.slice(0, max);
    return [...take, ...fresh.slice(0, Math.min(newLeft, max - take.length))];
  }
  // extra: 新しい問題と、忘れかけている問題を交互に
  const weak = seen.filter((x) => x.s.due > end).sort((a, b) => a.r - b.r).map((x) => x.c);
  const out: Card[] = [];
  for (let i = 0; out.length < max && (i < weak.length || i < fresh.length); i++) {
    if (i < weak.length) out.push(weak[i]);
    if (out.length < max && i < fresh.length) out.push(fresh[i]);
  }
  return out;
}

const urlCache = new Map<string, string>();
export async function imageUrl(path: string): Promise<string | null> {
  const hit = urlCache.get(path);
  if (hit) return hit;
  const row = await db.images.get(path);
  if (!row) return null;
  const url = URL.createObjectURL(row.blob);
  urlCache.set(path, url);
  return url;
}

/** 問題を報告する。Mac の開発サーバーから開いているときは、その場で Mac に送る */
export async function addReport(card: Card, reason: string, memo: string) {
  const r: Report = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    cardId: card.id, questionId: card.questionId, subject: card.subject, exam: card.exam, number: card.number,
    reason, memo, at: Date.now(), sent: false,
  };
  await db.reports.put(r);
  return sendReports();
}

/** まだ Mac に送っていない報告を送る。送れたら件数、送れなければ null */
export async function sendReports(): Promise<number | null> {
  const pending = (await db.reports.toArray()).filter((r) => !r.sent);
  if (pending.length === 0) return 0;
  if (!import.meta.env.DEV) return null;
  try {
    const res = await fetch('/api/reports', { method: 'POST', body: JSON.stringify({ reports: pending.map(({ sent: _s, ...r }) => r) }) });
    if (!res.ok) return null;
    await db.reports.bulkPut(pending.map((r) => ({ ...r, sent: true })));
    return pending.length;
  } catch {
    return null;
  }
}

// ---- 学習記録のバックアップ ----
interface Backup { app: 'denken-goro'; version: 1; exportedAt: string; reviews: ReviewLog[]; stats: CardStat[]; reports: Report[]; tags?: CardTag[] }

/** 学習記録（解答記録・学習状態・報告・計算問題の印）を JSON ファイルにする。問題データは含めない */
export async function exportBackup(): Promise<{ blob: Blob; fileName: string; reviews: number }> {
  const data: Backup = {
    app: 'denken-goro', version: 1, exportedAt: new Date().toISOString(),
    reviews: (await db.reviews.toArray()).map(({ id: _id, ...r }) => r as ReviewLog),
    stats: await db.stats.toArray(),
    reports: await db.reports.toArray(),
    tags: await db.tags.toArray(),
  };
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const fileName = `denken-goro-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
  return { blob: new Blob([JSON.stringify(data)], { type: 'application/json' }), fileName, reviews: data.reviews.length };
}

/** バックアップを読み込む。同じ解答記録は重ねず、問題ごとの状態は新しい方を残す */
export async function importBackup(file: File) {
  const data = JSON.parse(await file.text()) as Backup;
  if (data.app !== 'denken-goro' || data.version !== 1) throw new Error('電験語呂のバックアップファイルではありません');
  let added = 0;
  await db.transaction('rw', [db.reviews, db.stats, db.reports, db.tags], async () => {
    const have = new Set((await db.reviews.toArray()).map((r) => `${r.cardId}@${r.at}`));
    const fresh = data.reviews.filter((r) => !have.has(`${r.cardId}@${r.at}`));
    added = fresh.length;
    await db.reviews.bulkAdd(fresh);
    const cur = new Map((await db.stats.toArray()).map((s) => [s.cardId, s]));
    await db.stats.bulkPut(data.stats.filter((s) => (cur.get(s.cardId)?.lastAt ?? -1) < s.lastAt));
    await db.reports.bulkPut(data.reports.filter((r) => r.id));
    // 計算問題の印は、あとで付けた方を残す
    const tags = new Map((await db.tags.toArray()).map((t) => [t.cardId, t]));
    await db.tags.bulkPut((data.tags ?? []).filter((t) => (tags.get(t.cardId)?.at ?? -1) < t.at));
  });
  return { added, stats: data.stats.length };
}
