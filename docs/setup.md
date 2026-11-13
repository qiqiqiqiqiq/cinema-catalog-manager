# セットアップとP0環境からの更新

対象は既存のCloudflare D1 `ccm-db` です。P0で承認・公開済みの作品とキューを引き継ぎます。以下はP1本番反映の手順であり、コードや試験の完成だけで実施済みとは扱いません。

## ローカル検証

Node.js 22.15以降、npm、Python 3を使います。Wranglerはリポジトリの依存パッケージを使用します。

```powershell
npm ci
npm test
npm run check:bundle
```

テストは自分で合成データとローカルD1を用意します。試験のための本番DB初期化は不要です。

手動で空のローカルD1を作る場合だけ、既存DDLのfixtureからCloudflare内部テーブルを除いて適用します。

```powershell
$ccmBaseSchema = Get-Content -LiteralPath tests/fixtures/base-schema.sql -Raw -Encoding utf8
$ccmLocalSchema = $ccmBaseSchema -replace '(?s)\ACREATE TABLE _cf_KV\s*\(.*?\)\s*WITHOUT ROWID;\s*', ''
if ($ccmLocalSchema -eq $ccmBaseSchema) { throw 'Internal table definition was not removed.' }
$ccmSchemaFile = [IO.Path]::GetTempFileName()
try {
    Set-Content -LiteralPath $ccmSchemaFile -Value $ccmLocalSchema -Encoding utf8
    npx.cmd wrangler d1 execute ccm-db --local --file $ccmSchemaFile
    if ($LASTEXITCODE -ne 0) { throw 'Local schema setup failed.' }
} finally {
    Remove-Item -LiteralPath $ccmSchemaFile
}
npx.cmd wrangler d1 migrations apply ccm-db --local
```

`.dev.vars` にローカル専用の管理・保守・公開トークンを設定します。各32文字以上、すべて異なる値とし、Gitへ追加しません。合成データのテストには実YouTubeキーは不要です。

## 本番反映の順序

**追加マイグレーション→Worker更新→main反映→Secrets確認・保守有効化**の順です。新しい公開workflowは新しい復旧APIを使うため、Workerより先にmainへ反映すると既存の公開処理も失敗します。

1. 変更内容と試験結果をレビューし、本番反映を承認する。
2. 実行中・待機中の公開処理がないことを確認する。Muse等のD1直接更新は停止したままにする。保守有効化変数は未設定または `false` にしておく。
3. Account ID、Database ID、既存DDL、適用済みmigrationを確認し、復旧手段を確認する。内部テーブルや作品本文を不要にエクスポートしない。
4. P1の追加migrationを適用し、Workerを更新する。既存の公開構成・作品を初期化し直さない。
5. Workerの既存状態読取りと新経路を確認してからPRをmainへ反映する。
6. 保守トークンをWorkerとGitHubに登録し、接続設定を確認する。
7. `CCM_MAINTENANCE_ENABLED=true` を設定して保守workflowを手動実行する。以後の予定実行も有効になる。
8. 保守runと公開結果を確認し、実際の予定実行が動いた時刻・結果を記録する。

本番マイグレーション例：

```powershell
npx.cmd wrangler d1 migrations list ccm-db --remote --config wrangler.local.jsonc
npx.cmd wrangler d1 migrations apply ccm-db --remote --config wrangler.local.jsonc
npm run deploy:worker
```

`0001_stage1_p0.sql` と `0002_api_budget.sql` はP0で導入済みです。P1は次の追加分です。

| migration | 内容 |
|---|---|
| `0003_catalog.sql` | 候補・作品一覧のインデックス |
| `0004_maintenance.sql` | 保守runの開始・結果・集計記録 |
| `0005_deployment_recovery.sql` | 終了根拠を伴う公開ロック復旧記録 |

`tests/fixtures/base-schema.sql` は**既存の本番DBには流しません**。適用状況が想定と異なる場合は、先に差分を確認します。既存のタイムゾーン付き日時は維持し、新しい日時はUTCの `Z` 形式で保存します。

`wrangler.local.jsonc` はGit対象外の接続設定です。既存ファイルは上書きせず、アカウント・DBを確認します。新規コピーが必要な場合だけ `wrangler.jsonc` を複製し、Account IDとDatabase IDを設定します。追跡対象の設定はプレースホルダーのまま、D1 bindingは `DB` のままです。秘密情報は書き込みません。

## 資格情報と設定

**既存のYouTube APIキーは継続して使えます。P1で新たに必要なのは保守用トークンです。**

| 登録先 | 名前 | 内容 |
|---|---|---|
| Worker Secret | `CCM_ADMIN_TOKEN` | 既存の管理用。維持 |
| Worker / GitHub Secret | `CCM_DEPLOY_TOKEN` | 既存の公開用。同じ値を維持 |
| Worker Secret | `YOUTUBE_API_KEY` | 既存のYouTube Data API v3キー。Actionsへ複製しない |
| Worker / GitHub Secret | `CCM_MAINTENANCE_TOKEN` | 新しい保守用。同じ値を両方へ登録し、他トークンと分離 |
| GitHub Variable | `CCM_API_BASE_URL` | 既存のWorkerベースURL |
| GitHub Variable | `CCM_MAINTENANCE_ENABLED` | `true` で保守を有効化、それ以外で停止 |

保守トークンはパスワード管理ツール等で生成した32文字以上のランダム値を使用します。値はチャット・ソース・コマンド引数へ貼りません。

```powershell
npx.cmd wrangler secret put CCM_MAINTENANCE_TOKEN --config wrangler.local.jsonc
```

対話入力へ登録し、GitHubの `Settings → Secrets and variables → Actions` へ同じ値をSecretとして登録します。管理トークンやYouTubeキーをActionsへ渡す必要はありません。WorkerはD1 bindingを使うため、実行時の `CLOUDFLARE_API_TOKEN` は不要です。

既存設定は `RETENTION_DAYS=30`、`DELETION_GRACE_HOURS=72`、`YOUTUBE_REFRESH_DAILY_BUDGET=8000` が標準です。予算はこのWorkerの再取得分だけを米国太平洋時間の日付で管理します。Google Cloudの実割当・他の呼出し元の消費は別に確認します。

## 切替後の確認

`Maintain CCM catalog` を `main` から手動実行し、次を確認します。

- `/v1/maintenance/status` に対象runの終了結果がある。
- 対象のない正常実行では件数が0でもよい。無理に作品を変更して試験しない。
- 更新・削除で公開が必要になった場合は共通の公開workflowが続く。
- `/v1/state` の現在の版が検証済みとなり、公開待ちが解消する。
- 後続の予定実行についてもGitHub履歴とD1記録を確認する。

`initialized: true` のP0環境に初回承認を再送する必要はありません。空の新規環境だけ、候補登録・再取得・人の審査を経て、公開構成全体を明示承認します。

保守停止は `CCM_MAINTENANCE_ENABLED=false` とし、実行中runを確認します。WorkerだけP0へ戻すと新公開workflowの復旧APIが使えなくなるため、片側だけの巻戻しは行いません。公開APIデータをGitへ戻す復旧手順も使用しません。
