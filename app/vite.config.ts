import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, normalize } from 'node:path';
import { buildPack } from './scripts/pack';
import type { Report } from './src/types';

// Mac で取り込み結果を確認するための開発用 API（ビルドしたアプリには含まれない）
const DATA = resolve(__dirname, '../data');

function reviewApi(): Plugin {
  const safe = (p: string) => {
    const full = normalize(join(DATA, decodeURIComponent(p)));
    if (!full.startsWith(DATA)) throw new Error('bad path');
    return full;
  };
  return {
    name: 'review-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/exams', (_req, res) => {
        const out: unknown[] = [];
        for (const subject of ['理論', '機械', '法規']) {
          const dir = join(DATA, subject);
          if (!existsSync(dir)) continue;
          for (const exam of readdirSync(dir)) {
            const f = join(dir, exam, 'exam.json');
            if (!existsSync(f)) continue;
            const r = join(dir, exam, 'review.json');
            out.push({
              path: `${subject}/${exam}`,
              exam: JSON.parse(readFileSync(f, 'utf8')),
              review: existsSync(r) ? JSON.parse(readFileSync(r, 'utf8')) : null,
              mtime: statSync(f).mtimeMs,
            });
          }
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(out));
      });
      server.middlewares.use('/api/review', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            const { path, review } = JSON.parse(body);
            writeFileSync(join(safe(path), 'review.json'), JSON.stringify(review, null, 2));
            res.end('ok');
          } catch (e) { res.statusCode = 400; res.end(String(e)); }
        });
      });
      // iPad からの「この問題を報告」（data/reports.json に貯める）
      const REPORTS = join(DATA, 'reports.json');
      const loadReports = (): Report[] => (existsSync(REPORTS) ? JSON.parse(readFileSync(REPORTS, 'utf8')) : []);
      server.middlewares.use('/api/reports', (req, res) => {
        const send = (v: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(v)); };
        if (req.method === 'GET') return send(loadReports());
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            const msg = JSON.parse(body);
            const list = loadReports();
            if (req.url?.startsWith('/resolve')) {
              const r = list.find((x) => x.id === msg.id);
              if (r) r.resolved = !!msg.resolved;
            } else {
              for (const r of msg.reports as Report[]) {
                if (!list.some((x) => x.id === r.id)) list.push({ ...r, resolved: false });
              }
            }
            writeFileSync(REPORTS, JSON.stringify(list, null, 2));
            send({ ok: true, count: list.length });
          } catch (e) { res.statusCode = 400; res.end(String(e)); }
        });
      });
      server.middlewares.use('/api/pack-list', (_req, res) => {
        const list: string[] = [];
        for (const subject of ['理論', '機械', '法規']) {
          const dir = join(DATA, subject);
          if (!existsSync(dir)) continue;
          for (const exam of readdirSync(dir)) if (existsSync(join(dir, exam, 'exam.json'))) list.push(`${subject}/${exam}`);
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(list));
      });
      server.middlewares.use('/api/pack', (req, res) => {
        try {
          const q = new URL(req.url ?? '/', 'http://x').searchParams;
          const exam = q.get('exam'), subject = q.get('subject');
          const only = exam ? new Set([exam])
            : subject && existsSync(join(DATA, subject)) ? new Set(readdirSync(join(DATA, subject)).map((e) => `${subject}/${e}`))
            : undefined;
          const r = buildPack(DATA, only);
          res.setHeader('Content-Type', 'application/zip');
          res.setHeader('Content-Disposition', `attachment; filename="denken-goro.zip"; filename*=UTF-8''${encodeURIComponent(r.fileName)}`);
          res.setHeader('X-Pack-Info', encodeURIComponent(`${r.exams}回分 / ${r.cards}問（正解未確定 ${r.skipped}）`));
          res.end(Buffer.from(r.zip));
        } catch (e) { res.statusCode = 500; res.end(String(e)); }
      });
      server.middlewares.use('/data', (req, res, next) => {
        try {
          const f = safe((req.url ?? '').split('?')[0]);
          if (!existsSync(f) || !statSync(f).isFile()) return next();
          res.setHeader('Content-Type', f.endsWith('.jpg') ? 'image/jpeg' : 'application/json');
          res.end(readFileSync(f));
        } catch { next(); }
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), reviewApi()],
  // 同じ Wi-Fi の iPad から http://<Macの名前>.local:5173 で開けるようにする
  server: { allowedHosts: ['.local'] },
});
