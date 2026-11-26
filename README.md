# 電験語呂（電験三種 語呂暗記アプリ）

仕様: [app_spec.md](app_spec.md)

## フォルダ
- `importer/` … Mac 用の取り込みプログラム（Swift）
- `data/` … 取り込み結果（問題ごとの画像と exam.json、確認内容 review.json）
- `export/` … iPad に送る問題データ（zip）
- `app/` … アプリ本体（React + Vite。iPad ではホーム画面に追加して使う）

## 使い方（Mac）
1. 取り込み（初回はコンパイル）
   ```
   cd importer && swiftc -O extract.swift -o extract
   ./extract ~/Documents/電験三種 ../data            # 全部
   ./extract ~/Documents/電験三種 ../data 理論R8上期  # 一部だけ
   ```
2. 確認画面を開く: `cd app && npm run dev` → ブラウザで http://localhost:5173/#/review
3. 「iPad 用に書き出す」で zip を保存 → AirDrop で iPad へ
4. iPad のアプリで「問題データを読み込む」

Node.js は `~/.local/node` に入っている（`export PATH=~/.local/node/bin:$PATH`）。
