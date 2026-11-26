// 取り込みプログラム（importer/extract.swift）が書き出す形式
export interface ExtractPiece { question?: string; goro?: string }
export interface ExtractQuestion {
  id: string;
  number: number;
  part: 'A' | 'B' | '?';
  subCount: number;
  answers: (number | null)[];
  answerCandidates: number[][];
  pieces: ExtractPiece[];
  text: string;
  goroText: string;
  flags: string[];
  segment: number;
  struck?: boolean;    // 語呂PDFで斜線が引かれている
  excluded?: boolean;  // 取り込み時点で除外（機械の斜線 = 勉強しない）
}
export interface ExtractExam {
  subject: Subject;
  exam: string;
  original: string;
  goro?: string;
  pageCount: number;
  goroPageCount: number;
  questions: ExtractQuestion[];
  warnings: string[];
  extractedAt: string;
}

// Mac の確認画面で人が直した内容（data/<科目>/<回>/review.json）
export interface QuestionReview {
  answers?: (number | null)[];
  excluded?: boolean;
  checked?: boolean;
}
export interface ExamReview {
  questions: Record<string, QuestionReview>;
  done?: boolean;
}

export type Subject = '理論' | '機械' | '法規';
export const SUBJECTS: Subject[] = ['理論', '機械', '法規'];

// iPad に送る問題データ（zip の manifest.json）
export interface PackPiece { q?: string; g?: string } // zip 内の画像パス
export interface Card {
  id: string;          // 例: 理論-R8上期-15-a
  questionId: string;  // 例: 理論-R8上期-15
  subject: Subject;
  exam: string;        // 例: R8上期
  number: number;
  part: 'A' | 'B' | '?';
  sub: 'a' | 'b' | null;
  answer: number;
  pieces: PackPiece[];
  text: string;
  goroText: string;
}
export interface PackManifest {
  version: 1;
  createdAt: string;
  cards: Card[];
}

/** 人が確認画面で決めた除外 > 取り込み時の除外 */
export const isExcluded = (q: ExtractQuestion, r?: QuestionReview) => r?.excluded ?? !!q.excluded;

export const subLabel = (i: number, count: number): 'a' | 'b' | null =>
  count >= 2 ? (['a', 'b'][i] as 'a' | 'b') : null;

/** 回の並び順（平成→令和、年、上期→下期） */
export function examSortKey(exam: string): number {
  const m = exam.match(/^([HR])(\d+)/);
  if (!m) return 0;
  const year = (m[1] === 'H' ? 1988 : 2018) + Number(m[2]);
  return year * 10 + (exam.includes('下期') ? 2 : exam.includes('上期') ? 1 : 0);
}

/** iPad の「この問題を報告」 */
export const REPORT_REASONS = ['2問がまとまっている', '画像が切れている・足りない', '正解が違う', '語呂が違う問題のもの', 'その他'] as const;
export interface Report {
  id: string;
  cardId: string;
  questionId: string;
  subject: Subject;
  exam: string;
  number: number;
  reason: string;
  memo: string;
  at: number;
  sent?: boolean;      // iPad 側: Mac に送ったか
  resolved?: boolean;  // Mac 側: 対応済みか
}
