# Webサイト納品前チェックツール

Windows 11上で自分専用に使う、Nuxt 3製のローカルWebアプリです。仕様書Ver.1.1のPhase 6までを実装し、案件管理、Excel入力、Webサイト機械検査、進捗・結果・履歴表示、任意のAIリンク内容判定、Excelレポート出力に対応しています。

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
- `GET /api/projects/:projectId/runs`: 保存済みの検査履歴を取得
- `GET /api/projects/:projectId/runs/:runId`: 途中結果または完了結果を取得

検査はPlaywright ChromiumでJavaScript描画後DOMを取得し、title・description、Googleタグ、リンク、PC・スマートフォン画像を判定します。アプリ全体で同時に1ジョブ、案件設定内で1〜3ページ並列です。アクセス前のDNS検証、各リダイレクトの再検証、ローカル・私設IPの既定拒否、GET/HEAD制限、時間・サイズ・リダイレクト上限を適用します。ローカル・私設IPが必要な案件だけ、設定画面でホストを明示許可してください。

案件詳細画面では検査開始、2秒間隔の進捗更新、判定集計、ページ別の期待値・実測値・根拠、Googleタグ・リンク・画像の詳細、過去履歴を確認できます。画面更新後も保存済みrunを再読込します。

## AIリンク内容判定

AI判定はOFF、MANUAL、APIの3モードです。OFFではAI用の追加通信を行いません。MANUALではマスキング済みJSONをCodexで判定して取り込みます。APIではサーバー環境変数`OPENAI_API_KEY`を使用し、価格プロファイルと1検査の料金上限に従います。APIキーは画面、案件JSON、結果JSONへ保存しません。

## Excelレポート出力

終了した検査履歴を選び、「Excelレポートをダウンロード」を押すと、保存済み`result.json`から`runs/<runId>/report.xlsx`を再生成してダウンロードします。入力元Excelと検査結果JSONは変更しません。レポートは「検査サマリー」「NG・要確認一覧」「全検査結果」の3シートです。

レポートの「修正状況」と「備考」はExcel出力専用です。編集内容は`result.json`へ反映されません。レポートを再生成すると、修正状況は「未対応」、備考は空欄へ戻ります。
