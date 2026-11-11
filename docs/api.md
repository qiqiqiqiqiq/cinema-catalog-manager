# API契約と呼び出し例

すべての経路に `Authorization: Bearer <token>` が必要です。管理用は `CCM_ADMIN_TOKEN`、公開処理用は `CCM_DEPLOY_TOKEN` を使用します。JSONの送信時は `Content-Type: application/json` を指定します。

## 経路

| Method / path | 権限 | 用途 |
|---|---|---|
| `GET /v1/state` | 管理・公開 | 初期化、更新世代、対象版、反映済み版、公開待ち、実行中試行を取得 |
| `GET /v1/publication` | 管理・公開 | 現在の不変スナップショットを取得。未初期化では拒否 |
| `POST /v1/approvals` | 管理 | 管理者が承認した公開構成を全体置換 |
| `POST /v1/metadata/refresh` | 管理 | 既存作品のYouTubeメタデータをWorkerから再取得 |
| `POST /v1/maintenance/delete-eligible` | 管理 | 定義された自動削除条件を満たす作品を除去 |
| `POST /v1/deployments/begin` | 公開 | デプロイ試行を開始し、排他的な公開ロックを取得 |
| `POST /v1/deployments/{attemptId}/authorize` | 公開 | Pages公開直前に対象版・ロックを再検証 |
| `POST /v1/deployments/{attemptId}/finish` | 公開 | その試行の配信・検証結果を確定 |

`generation` は更新競合を検出するための値です。`revision` は公開JSONの版です。API取得状態だけ変わり公開JSONが同じ場合も `generation` は進み、`revision` は進まない場合があります。両者を交換して使用しないでください。

HTTP本文の上限は256 KiB、承認は最大500作品・2,000キュー項目です。CCM作品ID・キューIDは1～128文字の英数字・`_`・`-`、先頭は英数字です。ジャンルは最大200、手動タイトルは最大500のJavaScript文字列長（UTF-16コード単位）です。未定義のJSON項目は受け付けません。管理・公開トークンは互いに異なる32文字以上の値が必要です。

## 管理操作の例（PowerShell 7）

トークンは対話入力し、例示値を実トークンに置き換えてソースへ保存しません。

```powershell
$ccmBaseUrl = 'https://<your-worker>.workers.dev'
$ccmAdminToken = Read-Host 'CCM admin token' -MaskInput
$ccmHeaders = @{ Authorization = "Bearer $ccmAdminToken" }
$state = Invoke-RestMethod -Uri "$ccmBaseUrl/v1/state" -Headers $ccmHeaders
```

状態レスポンスのフィールドは `initialized`, `generation`, `revision`, `deployedRevision`, `verifiedRevision`, `needsDeployment`, `activeAttemptId` です。リビジョン等の初期値は実際の応答を使い、定数として決め打ちしません。

### 公開承認

次は形式例です。`movie_001` と `movie_002` が既存の採用済み作品であること、全体の公開内容として管理者が承認したことを前提とします。

```powershell
$approval = @{
    expectedGeneration = $state.generation
    movies = @(
        @{ id = 'movie_001'; genre = '映画'; titleMode = 'api' },
        @{ id = 'movie_002'; genre = '短編映画'; titleMode = 'manual'; manualTitle = '管理者が指定した上映名' }
    )
    queue = @(
        @{ id = 'queue_001'; movieId = 'movie_001' },
        @{ id = 'queue_002'; movieId = 'movie_002' },
        @{ id = 'queue_003'; movieId = 'movie_001' }
    )
}
$body = $approval | ConvertTo-Json -Depth 8 -Compress
$state = Invoke-RestMethod -Method Post -Uri "$ccmBaseUrl/v1/approvals" `
    -Headers $ccmHeaders -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
```

- これは差分追加ではなく、公開する `movies` と `queue` の全体指定です。配列の順序が公開順序になります。
- `titleMode: api` は現在のAPIタイトルを使用し、以後の正常再取得によるタイトル変更を公開へ反映します。
- `titleMode: manual` は明示した `manualTitle` を維持します。単にAPIタイトルをコピーしても、保持規定上の由来が独自情報へ変わるわけではありません。
- ジャンルと手動タイトルは承認値です。自動更新時に管理中のジャンル・キュー・手動編集を読み足しません。
- 作品ID・キューIDは安定した内部IDです。同じ作品をキューへ複数回置く場合はそれぞれ別のキューIDを使います。既存のキューIDを別作品へ再利用しません。初回移行後、一度公開キューから外れたIDは同じ作品へも再追加できず、`queue_id_retired` になります。再追加には新しいIDを使います。現在の項目の並び替えではIDを維持します。
- 存在しない作品・重複ID・参照不整合・古い `expectedGeneration` を拒否します。初回も同じ経路で明示承認します。

### APIメタデータの再取得

```powershell
$body = @{ workIds = @('movie_001', 'movie_002') } | ConvertTo-Json -Compress
$state = Invoke-RestMethod -Method Post -Uri "$ccmBaseUrl/v1/metadata/refresh" `
    -Headers $ccmHeaders -ContentType 'application/json' -Body $body
```

`workIds` は重複のない1～50件の既存CCM作品IDです。YouTube動画IDやAPI応答本文をクライアントから注入するAPIではありません。Workerが呼出し前の更新世代を読み、YouTubeから取得してから同じ世代で反映します。取得中に競合した場合は古い応答を反映しません。

API照会の正常応答に対象動画が含まれない場合は `unavailable`、通信・クォータ等の問題は `api_error` です。後者は取得不能回数にも正常取得日時の延長にも使いません。応答の `refresh.ok`, `refresh.unavailable`, `refresh.apiError` で件数を確認します。HTTP成功だけで全作品の取得成功と解釈しないでください。未知の作品を作成する機能はありません。

### 削除条件の適用

```powershell
$state = Invoke-RestMethod -Uri "$ccmBaseUrl/v1/state" -Headers $ccmHeaders
$body = @{ expectedGeneration = $state.generation } | ConvertTo-Json -Compress
$result = Invoke-RestMethod -Method Post -Uri "$ccmBaseUrl/v1/maintenance/delete-eligible" `
    -Headers $ccmHeaders -ContentType 'application/json' -Body $body
```

これは読取りやドライランではなく、条件を満たす作品を実際に削除する操作です。正常API照会による24時間以上離れた取得不能確認、または保持期限に対する削除猶予到達を評価します。作品・API情報・関連キュー・承認済み公開構成の除去、監査、公開要求は一体で更新します。

監査や削除済み内部IDの記録へYouTubeの動画ID・URL・タイトルを残しません。削除後に遅れて届いた更新で、削除済みCCM作品IDを復活させません。保持期限を延ばす旧 `extension_used` は期限超過を許可する根拠にしません。

### 公開本文

```powershell
$publication = Invoke-RestMethod -Uri "$ccmBaseUrl/v1/publication" -Headers $ccmHeaders
```

応答は `revision`, `libraryJson`, `queueJson` です。後者2つは完成済みJSONの文字列です。出力先は一時領域を使い、Gitにコミットしません。

```json
{"version":1,"movies":[{"id":"movie_001","title":"作品名","genre":"映画","url":"https://www.youtube.com/watch?v=VIDEO_ID"}]}
```

```json
{"version":1,"queue":[{"id":"queue_001","movieId":"movie_001"}]}
```

## デプロイ試行契約

この経路は通常workflowが呼びます。`attemptId` はGitHubの `run_id-run_attempt` です。同じリビジョンを再試行しても、新しいGitHub試行には別IDを使います。

```json
{"attemptId":"123456789-1","expectedRevision":42}
```

`begin` は現在の版であることと別試行のロックがないことを検証します。同じ実行中IDの再送は同じ試行として扱います。完了済みIDを再び開始しません。

Artifactアップロード後、Pages公開の直前に `authorize` を呼びます。本文は空のJSONオブジェクト `{}` です。呼出し元から任意の版を渡して認可を置き換えることはできません。再確認に失敗した場合や古い版になった場合は公開を行いません。

検証成功の `finish` 本文例：

```json
{
  "outcome": "verified",
  "deployed": true,
  "libraryMatches": true,
  "queueMatches": true,
  "phase": "verify",
  "retryCount": 0
}
```

`outcome` は `verified`, `failed`, `superseded`, `uncertain` のいずれかです。`verified` には事前認可、配信完了、両ファイルの一致が必要です。失敗時はコード側で定義された短い `errorCode` と段階を使用し、外部サービスの応答本文を渡しません。完全に同一の終端通知は再送できますが、一度確定した結果を異なる本文で書き換えません。

Pagesへの要求後のtimeout等で、外部デプロイが終了したか不明なら `uncertain` を使います。これは確定した失敗ではなく、記録してもロックを解放しません。外部処理が終わった根拠なしに `failed` として閉じないでください。

古い試行の成功通知は新しい版を検証済みにしません。ロックは確定した終端記録が保存されたときだけ解放されます。結果のD1保存に失敗した場合は、Pagesが更新されていてもworkflowを成功扱いにしません。

## エラー時の原則

認証不足、入力不正、更新競合、未初期化、実行中試行などはAPIエラーとして返します。競合時には状態を読み直し、何を承認・変更するかを再評価します。API応答本文、HTTPリクエストヘッダー、YouTubeキー付きURLをログへ出力しません。

エラー本文は `{"error":{"code":"invalid_request"}}` のようにコードだけを返します。認証失敗は401、権限不足は403、形式不正は400、JSON以外は415、本文上限超過は413、再取得予算超過は429、設定不足は503です。更新競合等はサービスから返るコードで判別します。

作業後はPowerShellの一時変数を除去するかセッションを閉じます。

```powershell
Remove-Variable ccmAdminToken, ccmHeaders -ErrorAction SilentlyContinue
```
