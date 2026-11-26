// 忘却曲線（FSRS）による出題スケジュール
import { fsrs, generatorParameters, createEmptyCard, Rating, State, type Card as FsrsCard, type Grade } from 'ts-fsrs';

/** IndexedDB に保存する FSRS の状態（日時はミリ秒） */
export interface SrsState {
  due: number;
  stability: number;
  difficulty: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  learning_steps: number;
  state: number;
  last_review?: number;
}

/** 目標の定着率（思い出せる確率が 90% まで下がったら出題） */
export const TARGET_RETENTION = 0.9;
/** この秒数以内に正解し、語呂も思い出せたら「即答」 */
export const QUICK_SECONDS = 20;

const scheduler = fsrs(generatorParameters({ request_retention: TARGET_RETENTION, enable_fuzz: true, enable_short_term: true }));

const toFsrs = (s: SrsState): FsrsCard => ({
  ...s,
  due: new Date(s.due),
  last_review: s.last_review != null ? new Date(s.last_review) : undefined,
} as unknown as FsrsCard);

const fromFsrs = (c: FsrsCard): SrsState => {
  const x = c as unknown as Record<string, unknown>;
  return {
    due: new Date(x.due as Date).getTime(),
    stability: x.stability as number,
    difficulty: x.difficulty as number,
    scheduled_days: x.scheduled_days as number,
    reps: x.reps as number,
    lapses: x.lapses as number,
    learning_steps: (x.learning_steps as number) ?? 0,
    state: x.state as number,
    last_review: x.last_review ? new Date(x.last_review as Date).getTime() : undefined,
  };
};

export type RatingName = 'again' | 'hard' | 'good' | 'easy';
const RATING: Record<RatingName, Grade> = { again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy };

/**
 * 解答から評価を決める
 * - 不正解 → Again（もう一度）
 * - 正解だが語呂を思い出せなかった（勘・消去法） → Hard
 * - 正解で語呂も思い出せた → Good（20秒以内なら Easy）
 */
export function ratingFor(correct: boolean, recalled: boolean | null, durationMs: number): RatingName {
  if (!correct) return 'again';
  if (recalled === false) return 'hard';
  if (recalled === true && durationMs <= QUICK_SECONDS * 1000) return 'easy';
  return 'good';
}

/** 評価を反映した新しい状態 */
export function review(prev: SrsState | undefined, rating: RatingName, at: number): SrsState {
  const card = prev ? toFsrs(prev) : createEmptyCard(new Date(at));
  const rec = scheduler.next(card, new Date(at), RATING[rating]) as unknown as { card: FsrsCard };
  return fromFsrs(rec.card);
}

/** 今この瞬間に思い出せる確率（0〜1）。未学習は 0 */
export function retrievability(s: SrsState | undefined, now = Date.now()): number {
  if (!s || s.state === State.New) return 0;
  const r = scheduler.retrievability(toFsrs(s), new Date(now));
  return typeof r === 'number' && isFinite(r) ? r : 0;
}

export const isLearning = (s?: SrsState) => !!s && (s.state === State.Learning || s.state === State.Relearning);

export function endOfToday(now = Date.now()) {
  const d = new Date(now); d.setHours(23, 59, 59, 999); return d.getTime();
}
export function startOfToday(now = Date.now()) {
  const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime();
}

/** 「今日」「明日」「3日後」「12月5日」のような表示 */
export function dueLabel(due: number, now = Date.now()): string {
  const days = Math.round((startOfToday(due) - startOfToday(now)) / 86400000);
  if (days <= 0) return '今日';
  if (days === 1) return '明日';
  if (days < 30) return `${days}日後`;
  const d = new Date(due);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// 1日に新しく出す問題の数（設定）
const NEW_KEY = 'newPerDay';
export const getNewPerDay = () => Number(localStorage.getItem(NEW_KEY) ?? 10);
export const setNewPerDay = (n: number) => localStorage.setItem(NEW_KEY, String(n));

/** 回の並び順（平成→令和、年、上期→下期） */
export function examSortKeyOf(exam: string): number {
  const m = exam.match(/^([HR])(\d+)/);
  if (!m) return 0;
  const year = (m[1] === 'H' ? 1988 : 2018) + Number(m[2]);
  return year * 10 + (exam.includes('下期') ? 2 : exam.includes('上期') ? 1 : 0);
}
