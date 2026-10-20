# Webサイト納品前チェックツール

Windows 11上で自分専用に使う、Nuxt 3製のローカルWebアプリです。現在は仕様書Ver.1.1のPhase 1（案件、Excel保管、認証情報の暗号化、アーカイブ）まで実装しています。検査・Excel解析・履歴は後続Phaseの対象です。

## 必要環境

- Node.js 20以降
- npm

## セットアップ

1. `npm install`
2. `.env.example` を `.env` へコピー
3. `APP_ENCRYPTION_KEY` に32バイト鍵をBase64または64桁の16進数で設定
4. `npm run dev`
5. `http://127.0.0.1:3000` を開く

鍵はPowerShellで `[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))` を実行して生成できます。鍵を失うと保存済み認証情報は復号できません。

## コマンド

- `npm run dev`: 127.0.0.1限定で開発起動
- `npm run build`: 本番ビルド
- `npm run typecheck`: TypeScript検査
- `npm test`: 単体テスト

## Phase 1のデータ

案件は `DATA_DIR`（初期値 `./data`）の `projects/<UUID>/` に保存します。Excel原本は変更せず、`input/current.xlsx` にコピーします。認証情報は `APP_ENCRYPTION_KEY` を使ったAES-256-GCMで `secrets.enc.json` に分離保存します。

`data/`、`.env`、生成物、認証状態はGit対象外です。案件削除機能はありません。アーカイブは `project.json` の日時だけを変更し、Excelや履歴を移動・削除しません。

## Excel形式と既知制限

入力は `.xlsx` のみです。固定の「納品前のチェック」「Googleタグ」シートと各列の解析・検証はPhase 2で実装します。Phase 1では安全なファイル形式・サイズ確認とコピー保存までです。OpenAI連携、Playwright Chromium、検査、履歴、比較、レポート出力も未実装です。
