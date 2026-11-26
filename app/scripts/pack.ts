// 確認済みの取り込み結果を、iPad に送る1つの zip（問題データ）にまとめる
// 使い方: npm run pack  →  ../export/denken-goro-YYYYMMDD-HHMM.zip
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import type { Card, ExamReview, ExtractExam, PackManifest, PackPiece } from '../src/types';
import { SUBJECTS, subLabel, isExcluded } from '../src/types';

/** 複数年度が1ファイルの回（例: H15-20）は、区切りごとに年度名を付ける */
function examLabel(exam: string, segment: number): string {
  const m = exam.match(/^([HR])(\d+)-(\d+)$/);
  return m ? `${m[1]}${Number(m[2]) + segment}` : exam;
}

export interface PackResult { zip: Uint8Array; cards: number; skipped: number; exams: number; fileName: string }

export function buildPack(dataDir: string, only?: Set<string>): PackResult {
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};
  const cards: Card[] = [];
  let skipped = 0, exams = 0;
  for (const subject of SUBJECTS) {
    const sdir = join(dataDir, subject);
    if (!existsSync(sdir)) continue;
    for (const examDir of readdirSync(sdir)) {
      if (only && !only.has(`${subject}/${examDir}`)) continue;
      const ej = join(sdir, examDir, 'exam.json');
      if (!existsSync(ej)) continue;
      const exam: ExtractExam = JSON.parse(readFileSync(ej, 'utf8'));
      const rj = join(sdir, examDir, 'review.json');
      const review: ExamReview = existsSync(rj) ? JSON.parse(readFileSync(rj, 'utf8')) : { questions: {} };
      exams++;
      for (const q of exam.questions) {
        const r = review.questions[q.id] ?? {};
        if (isExcluded(q, r)) continue;
        const answers = r.answers ?? q.answers;
        const pieces: PackPiece[] = q.pieces.map((p) => {
          const out: PackPiece = {};
          for (const [k, f] of [['q', p.question], ['g', p.goro]] as const) {
            if (!f) continue;
            const zp = `images/${subject}/${examDir}/${f}`;
            if (!files[zp]) files[zp] = [readFileSync(join(sdir, examDir, f)), { level: 0 }];
            out[k] = zp;
          }
          return out;
        });
        answers.forEach((a, i) => {
          if (a == null) { skipped++; return; }
          const sub = subLabel(i, answers.length);
          cards.push({
            id: q.id + (sub ? `-${sub}` : ''),
            questionId: q.id,
            subject, exam: examLabel(exam.exam, q.segment), number: q.number, part: q.part, sub,
            answer: a, pieces, text: q.text, goroText: q.goroText,
          });
        });
      }
    }
  }
  const manifest: PackManifest = { version: 1, createdAt: new Date().toISOString(), cards };
  files['manifest.json'] = strToU8(JSON.stringify(manifest));
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const label = only && only.size > 0 ? `-${[...only][0].split('/')[0]}` : '';
  const fileName = `denken-goro${label}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.zip`;
  return { zip: zipSync(files), cards: cards.length, skipped, exams, fileName };
}

// コマンドとして実行されたとき
if (process.argv[1]?.endsWith('pack.ts')) {
  const root = resolve(import.meta.dirname, '..', '..');
  const r = buildPack(join(root, 'data'));
  mkdirSync(join(root, 'export'), { recursive: true });
  const out = join(root, 'export', r.fileName);
  writeFileSync(out, r.zip);
  console.log(`${r.exams}回分 / ${r.cards}問 を書き出しました（正解未確定でスキップ: ${r.skipped}）\n${out}\n${(r.zip.length / 1e6).toFixed(1)} MB`);
}
