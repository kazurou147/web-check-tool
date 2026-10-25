# Webサイト納品前チェックツール

Windows 11上で自分専用に使う、Nuxt 3製のローカルWebアプリです。仕様書Ver.1.3に基づき、案件管理、Excel入力、Webサイト機械検査、進捗・結果・履歴表示、任意のAIリンク内容判定、Excelレポート出力、全URL再実行、安全化JSON出力に対応しています。

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
- `POST /api/projects/:projectId/runs/:runId/cancel`: 実行中の検査へキャンセルを要求
- `POST /api/projects/:projectId/runs/:runId/rerun`: 現在のExcelを再読込し、新しいrunIdで全URLを再実行
- `GET /api/projects/:projectId/runs/:runId/export/json`: 保存済み結果の安全化JSONをダウンロード

検査はPlaywright ChromiumでJavaScript描画後DOMを取得し、title・description、Googleタグ、リンク、PC・スマートフォン画像を判定します。アプリ全体で同時に1ジョブ、案件設定内で1〜3ページ並列です。アクセス前のDNS検証、各リダイレクトの再検証、ローカル・私設IPの既定拒否、GET/HEAD制限、時間・サイズ・リダイレクト上限を適用します。ローカル・私設IPが必要な案件だけ、設定画面でホストを明示許可してください。

案件詳細画面では検査開始、2秒間隔の進捗更新、判定集計、ページ別の期待値・実測値・根拠、Googleタグ・リンク・画像の詳細、過去履歴を確認できます。画面更新後も保存済みrunを再読込します。

キャンセル時は完了済みのページ結果とAI判定バッチを保持し、未完了ページをNGとして追加しません。アプリの異常終了後は、次回起動時に実行中だったrunを「中断」として確定し、Web検査やOpenAI APIを自動再実行しません。同じ`DATA_DIR`を利用するアプリは単一インスタンスに制限されます。OpenAI APIへすでに受理されたリクエストは、キャンセル後も料金が発生する可能性があります。

全URL再実行は、現在登録されているExcelからURLと期待値を読み直します。検査条件は現在設定または元runの設定スナップショットから選択できますが、AIモードの初期値は常にOFFです。APIモードは有料実行を明示確認した場合だけ開始します。元runと入力Excelは変更しません。

JSON結果は保存済み`result.json`を変更せず、allowlist方式のエクスポートデータとして生成します。URL認証情報、秘密性の高いクエリ値、Cookie、Authorization、JWT、APIキーらしい文字列を自動マスキングしますが、秘密情報の完全除去は保証しません。一般的なメールアドレス・電話番号や検査対象サイト由来の文章は維持されるため、共有前に内容を確認してください。実行中のダウンロードは、その時点までに保存されたスナップショットです。

## AIリンク内容判定

AI判定はOFF、MANUAL、APIの3モードです。OFFではAI用の追加通信を行いません。MANUALではマスキング済みJSONをCodexで判定して取り込みます。APIではサーバー環境変数`OPENAI_API_KEY`を使用し、価格プロファイルと1検査の料金上限に従います。APIキーは画面、案件JSON、結果JSONへ保存しません。

## Excelレポート出力

終了した検査履歴を選び、「Excelレポートをダウンロード」を押すと、保存済み`result.json`から`runs/<runId>/report.xlsx`を再生成してダウンロードします。入力元Excelと検査結果JSONは変更しません。レポートは「検査サマリー」「NG・要確認一覧」「全検査結果」の3シートです。

レポートの「修正状況」と「備考」はExcel出力専用です。編集内容は`result.json`へ反映されません。レポートを再生成すると、修正状況は「未対応」、備考は空欄へ戻ります。

## Phase 7で確認する異常系テスト課題

- 破損または過大な`result.json`が1件存在すると、検査履歴一覧全体の読み込みが失敗する可能性があります。Phase 7で履歴単位のエラー分離とサイズ制限を含めて検証します。
- 通常ブラウザでのJavaScript確認ダイアログと、JSONファイルの保存完了操作は一部未確認です。Phase 7のWindows 11ブラウザ試験で確認します。
