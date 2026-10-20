# Webサイト納品前チェックツール

Windows 11上で自分専用に使う、Nuxt 3製のローカルWebアプリです。現在は仕様書Ver.1.1のPhase 3（案件管理、Excel入力、Webサイト機械検査）まで実装しています。検査の進捗・結果・履歴画面はPhase 4の対象です。

## 必要環境

- Node.js 20以降
- npm

## セットアップ

1. `npm install`
2. `npm run playwright:install`
3. `.env.example` を `.env` へコピー
4. `APP_ENCRYPTION_KEY` に32バイト鍵をBase64または64桁の16進数で設定
5. `npm run dev`
6. `http://127.0.0.1:3000` を開く

鍵はPowerShellで `[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))` を実行して生成できます。鍵を失うと保存済み認証情報は復号できません。

## コマンド

- `npm run dev`: 127.0.0.1限定で開発起動
- `npm run build`: 本番ビルド
- `npm run typecheck`: TypeScript検査
- `npm test`: 単体テスト
- `npm run playwright:install`: 検査用Chromiumをインストール

## データ管理

案件は `DATA_DIR`（初期値 `./data`）の `projects/<UUID>/` に保存します。Excel原本は変更せず、`input/current.xlsx` にコピーします。認証情報は `APP_ENCRYPTION_KEY` を使ったAES-256-GCMで `secrets.enc.json` に分離保存します。検査結果は `runs/<runId>/` の `input-snapshot.json`、`result.json`、`events.jsonl` へ保存し、ページ完了ごとに `result.json` を更新します。

`data/`、`.env`、生成物、認証状態はGit対象外です。案件削除機能はありません。アーカイブは `project.json` の日時だけを変更し、Excelや履歴を移動・削除しません。

## Excel入力

入力は `.xlsx` のみです。「納品前のチェック」シートのA〜D列と「Googleタグ」シートのA〜B列を固定形式で読み取り、案件画面へ有効行、除外行、重複URL、結合・数式、タグIDを表示します。数式は実行せず、保存済みキャッシュ値も期待値として採用しません。

ExcelJSは保存済み行の`hidden`状態を読み取れるため、手動非表示行とExcelが非表示状態を保存したフィルター除外行を対象外にします。一方、オートフィルターの条件式自体は評価しません。フィルター範囲や条件だけがあり、除外行の`hidden`状態がファイルへ保存されていない場合は自動除外できません。

## Phase 3 機械検査API

- `POST /api/projects/:projectId/runs`: Excelを再読込して検査を開始
- `GET /api/projects/:projectId/runs/:runId`: 途中結果または完了結果を取得

検査はPlaywright ChromiumでJavaScript描画後DOMを取得し、title・description、Googleタグ、リンク、PC・スマートフォン画像を判定します。アプリ全体で同時に1ジョブ、案件設定内で1〜3ページ並列です。アクセス前のDNS検証、各リダイレクトの再検証、ローカル・私設IPの既定拒否、GET/HEAD制限、時間・サイズ・リダイレクト上限を適用します。ローカル・私設IPが必要な案件だけ、設定画面でホストを明示許可してください。

Phase 4の進捗・結果・履歴画面、Phase 5のOpenAI連携、Phase 6のExcelレポート出力は未実装です。
