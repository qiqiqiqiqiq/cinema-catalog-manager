# セットアップと既存環境への移行

対象は既存の Cloudflare D1 `ccm-db` です。既存データの意味や旧スナップショットのタイトル由来を推測して自動移行する処理はありません。ここに記載した本番コマンドは、運用担当者が対象アカウント・DB・リポジトリを確認して実行する手順です。

## 1. ローカル検証

前提は Node.js 22.15 以降、npm、Python 3、Cloudflare Workers用の Wrangler です。Wrangler はこのリポジトリの依存パッケージを使用します。

```powershell
npm ci
npm test
```

個別の検証は次のコマンドで行えます。

```powershell
npm run test:unit
npm run test:integration
npm run test:deploy
```

単体試験は合成データによるロジック・HTTP契約の検証、integrationはローカルD1での確認、deployはPythonスクリプトの検証です。本番D1・Pagesの成功を意味しません。

`npm test` は検証用DBを自分で用意するため、以下の手動初期化は不要です。Workerを手動で起動する場合だけ、空のローカルDBへ初期化します。`tests/fixtures/base-schema.sql` は提供済みDDLの再現用で、Cloudflare管理の `_cf_KV` も含みます。その定義を除いた一時ファイルを作って使用します。既存の本番DBへ適用しないでください。

```powershell
$ccmBaseSchema = Get-Content -LiteralPath tests/fixtures/base-schema.sql -Raw -Encoding utf8
$ccmLocalSchema = $ccmBaseSchema -replace '(?s)\ACREATE TABLE _cf_KV\s*\(.*?\)\s*WITHOUT ROWID;\s*', ''
if ($ccmLocalSchema -eq $ccmBaseSchema) { throw 'Internal table definition was not removed.' }
$ccmSchemaFile = [IO.Path]::GetTempFileName()
try {
    Set-Content -LiteralPath $ccmSchemaFile -Value $ccmLocalSchema -Encoding utf8
    npx wrangler d1 execute ccm-db --local --file $ccmSchemaFile
    if ($LASTEXITCODE -ne 0) { throw 'Local schema setup failed.' }
} finally {
    Remove-Item -LiteralPath $ccmSchemaFile
}
npx wrangler d1 migrations apply ccm-db --local
```

ローカル用の管理トークンと公開トークンを `.dev.vars` に設定し、Git対象外であることを確認します。互いに異なる32文字以上のランダムな値を使ってください。YouTube APIの実呼出しを行わない検証では `YOUTUBE_API_KEY` は不要です。

```dotenv
CCM_ADMIN_TOKEN=<ローカル専用の管理トークン>
CCM_DEPLOY_TOKEN=<ローカル専用の公開トークン>
```

```powershell
npx wrangler dev
```

起動直後の空DBは未初期化です。`GET /v1/state` で状態を確認できますが、初回の明示承認までは `GET /v1/publication` が公開本文を返しません。API呼出し例は [api.md](api.md) を参照してください。

## 2. 本番移行前の停止とDDL確認

1. 既存の Pages デプロイworkflowを停止し、実行中・待機中の処理がないことを確認する。Muse等がD1へ直接書き込む操作も停止する。
2. Cloudflare側で対象が `ccm-db` であることを確認し、Database IDを確認する。同名DBや別アカウントへの適用を避ける。
3. 現在のDDLを読み、提供された `exportedTable.csv` および `tests/fixtures/base-schema.sql` と比較する。列、型、NULL制約、CHECK、外部キー、既存追加テーブルを確認する。単にテーブル名が一致するだけでは十分ではない。
4. 差分があれば移行SQLを調整してローカルで検証する。DDL比較はこの手順での確認であり、本実装が既存の任意スキーマを自動修復するものではない。
5. 初回公開する全作品と全キューをレビューする。タイトルごとに `api` または `manual` を明示する。旧JSONから自動判別しない。

既存の日時は、タイムゾーンを明示したISO 8601形式（`Z` または `+09:00` などのオフセット）を受け付けます。保持期限や取得間隔は同じUTC時刻に換算して比較し、新たに保存する日時は `Z` 形式に統一します。既存日時を一括更新する必要はありません。タイムゾーンなし・存在しない日付・不正なオフセットは拒否します。

DDLだけを取得する読取りクエリの例です。作品行やAPI本文のエクスポートは必要ありません。

```sql
SELECT name, sql
FROM sqlite_master
WHERE type = 'table'
ORDER BY name;
```

`_cf_KV` などCloudflare内部のテーブルは変更しません。移行前の復旧手段は確保しますが、APIデータを含む手動バックアップを無期限に追加保存しないでください。Time Travelに残るコピーの保持規定上の扱いは [scope.md](scope.md) の未解決事項です。

## 3. 追加マイグレーションとWorker

まず設定のローカルコピーを用意します。すでに設定済みのファイルがある場合は上書きせず、対象DBを確認します。

```powershell
if (-not (Test-Path -LiteralPath wrangler.local.jsonc)) {
    Copy-Item -LiteralPath wrangler.jsonc -Destination wrangler.local.jsonc
}
```

Git対象外の `wrangler.local.jsonc` のD1設定を、確認済みの `ccm-db` のDatabase IDへ合わせ、ルートの `account_id` に対象Account IDを設定します。追跡対象の `wrangler.jsonc` はプレースホルダーのままです。binding名は `DB` のままにします。これらのIDは認証トークンではありません。秘密情報は設定ファイルへ書き込みません。

Cloudflareへの操作には別途ログインが必要です。未ログインなら次のコマンドでブラウザーから認証し、表示されるアカウントが対象と一致することを確認します。APIトークンの値をチャットへ送る必要はありません。

```powershell
npx wrangler login
npx wrangler whoami
```

既存の更新処理を停止した状態で、追加マイグレーションのみ適用します。

```powershell
npx wrangler d1 migrations apply ccm-db --remote --config wrangler.local.jsonc
npm run deploy:worker
```

追加マイグレーションはP0の公開管理用構造とWorker再取得予算用構造を作ります。既存の作品やAPIメタデータを初回承認前に消去することは意図していません。旧スナップショットは初回承認まで残りますが、新APIからの公開元には使いません。初回承認による新スナップショット生成時に古い本文を除去するため、承認内容を確認してから進めます。

WorkerのSecretsを登録します。値は対話入力へ入力し、コマンド引数・チャット・ソースファイルには含めません。

```powershell
npx wrangler secret put CCM_ADMIN_TOKEN --config wrangler.local.jsonc
npx wrangler secret put CCM_DEPLOY_TOKEN --config wrangler.local.jsonc
```

本番でAPIメタデータの再取得を使用するには、Google Cloud側でYouTube Data API v3を有効化し、APIキーに利用API制限を設定した上で登録します。キーがなくてもローカルの合成データによるテストはできますが、実APIによる更新はできません。

```powershell
npx wrangler secret put YOUTUBE_API_KEY --config wrangler.local.jsonc
```

管理トークンは承認・API再取得・削除判定用、公開トークンはActionsの公開処理用です。両者とも状態と公開本文の読取りができます。Secretsの不足は認証成功として扱いません。WorkerのDB操作にはD1 bindingを使うため、実行時の `CLOUDFLARE_API_TOKEN` は不要です。

設定の `RETENTION_DAYS` は初期値30日、`DELETION_GRACE_HOURS` は初期値72時間です。期限前に削除判定する猶予であり、復旧コピーやCDNを含む削除保証ではありません。`YOUTUBE_REFRESH_DAILY_BUDGET` は初期値8,000で、このWorkerによる再取得の消費だけを米国太平洋時間の日付単位で管理します。0なら新たな呼出しを停止します。Google Cloud側の実割当と他の呼出し元の消費は別に確認します。

## 4. 初回公開構成の明示承認

1. `GET /v1/state` を管理トークンで取得し、`initialized: false` と現在の `generation` を確認する。
2. 現在の `works.status = approved` の作品と必要なAPIメタデータを確認する。
3. 管理者が公開する作品一覧、ジャンル、タイトル方式、手動タイトル、キューの順番を確認する。既存JSONの一覧を参考にしても、タイトル由来を推測して自動送信しない。
4. 現在の `generation` を `expectedGeneration` に設定して、`POST /v1/approvals` へ全体を送る。
5. 新状態と `GET /v1/publication` の両JSONを確認する。承認APIの完了は、まだPagesへの反映完了を意味しない。

`movies: []` と `queue: []` の承認は全作品を非公開にする意思決定です。動作確認のために本番で空承認を送らないでください。競合が返った場合は最新状態と承認内容を見直し、`expectedGeneration` だけを機械的に差し替えて再送しません。

## 5. GitHub Actionsへの切替

新workflowをレビューして `main` に反映した後で使います。旧workflow・旧D1直接書込み経路との並行稼働はしません。GitHubのリポジトリ設定でPagesの配信元をGitHub Actionsにします。

GitHubの `Settings → Secrets and variables → Actions` に、Workerの公開トークンと同じ値の `CCM_DEPLOY_TOKEN` をSecretとして登録します。Worker APIのベースURLを `CCM_API_BASE_URL` として、workflowで参照するRepository Variableに登録します。管理トークンやYouTubeキーをActionsへ複製する必要はありません。

初回承認後に新workflowを手動起動し、対象リビジョンの開始記録、Pages反映、両URL照合、D1への結果記録を確認します。任意入力の `revision` は期待する版であり、旧版を強制再公開する指定ではありません。空欄なら実行開始時点の最新版を取得します。`needsDeployment: false` と対象版の検証済み状態を確認して移行完了とします。

本P0には公開要求を検出して自動起動する新しいschedulerはありません。公開要求はD1に残るため、当面は手動起動し、定期起動・停止検知・Museの障害復旧はP1で接続・実証します。旧処理の直接SQL更新を再開すると競合検出を迂回するため、P0で扱う更新・削除・承認はWorker経由へ切り替えます。
