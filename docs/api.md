# API契約

すべての経路に `Authorization: Bearer <token>` が必要です。POSTは `Content-Type: application/json` を指定します。HTTPSを使い、リダイレクトへ認証を転送しません。Museからはアプリ名を含む `User-Agent: CCM-Muse/0.1` を送信してください。

| 権限 | Secret | 用途 |
|---|---|---|
| 管理 | `CCM_ADMIN_TOKEN` | 候補登録・人による審査・公開構成承認、保守 |
| 保守 | `CCM_MAINTENANCE_TOKEN` | 状態確認、対象作品の再取得、削除条件適用、保守run記録 |
| 公開 | `CCM_DEPLOY_TOKEN` | 公開本文取得、公開試行・結果・復旧記録 |

トークンは互いに異なる32文字以上の値を使用します。保守トークンで作品の審査・公開承認・公開本文取得・公開結果通知はできません。公開トークンで管理・保守操作はできません。

## 経路

| Method / path | 権限 | 用途 |
|---|---|---|
| `GET /v1/state` | 全権限 | 現在の世代・版・公開状態 |
| `GET /v1/publication` | 管理・公開 | 現在の公開スナップショット |
| `GET /v1/works` | 管理 | 作品一覧、ページ分割・審査状態フィルター |
| `GET /v1/works/{workId}` | 管理 | 作品詳細と発見経路 |
| `GET /v1/approved-configuration` | 管理 | 承認済み作品・キュー全体 |
| `POST /v1/discoveries` | 管理 | URL単体の候補登録 |
| `POST /v1/works/{workId}/review` | 管理 | 人が指定した審査結果・メモ |
| `POST /v1/approvals` | 管理 | 承認済み公開構成の全体置換 |
| `POST /v1/metadata/refresh` | 管理・保守 | 最大50作品のAPI再取得 |
| `GET /v1/maintenance/plan` | 管理・保守 | 次の再取得対象、最大50件 |
| `POST /v1/maintenance/delete-eligible` | 管理・保守 | 削除条件を満たす作品を実際に除去 |
| `GET /v1/maintenance/status` | 管理・保守 | 最新20件の保守run |
| `POST /v1/maintenance/runs/start` | 管理・保守 | 保守run開始記録 |
| `POST /v1/maintenance/runs/{runId}/finish` | 管理・保守 | 保守runの結果記録 |
| `GET /v1/deployments/active` | 公開 | 現在の公開ロック対象 |
| `POST /v1/deployments/begin` | 公開 | 公開試行を開始 |
| `POST /v1/deployments/{attemptId}/authorize` | 公開 | Pages公開直前の版確認 |
| `POST /v1/deployments/{attemptId}/finish` | 公開 | 配信・両本文照合結果 |
| `POST /v1/deployments/{attemptId}/recover` | 公開 | 終了根拠を伴うロック復旧 |

`generation` は更新競合の検出値、`revision` は公開JSONの版です。公開本文が変わらない更新では前者だけ進みます。レスポンスや再読取りで得た値を使い、固定値にしません。競合時は内容を読み直し、人の判断を伴う変更では世代番号だけ差し替えて再送しません。

HTTP本文上限は256 KiB。未定義のJSON項目を拒否します。CCM作品・キューIDは先頭英数字、以降英数字・`_`・`-`、1～128文字です。文字数上限はJavaScript文字列長です。

## 状態と読取り

`/v1/state` は `initialized`, `generation`, `revision`, `deployedRevision`, `verifiedRevision`, `needsDeployment`, `activeAttemptId` を返します。公開完了は現在の `revision` と `verifiedRevision` の一致、`needsDeployment: false` を確認します。

`/v1/works?limit=50&after=<id>&status=unreviewed` の `limit` は1～100、既定50です。`after` は前ページの `nextCursor`、`status` は省略可能です。応答は `{generation,works,nextCursor}` で、終了時のカーソルはnullです。並行更新時は固定スナップショットのページ分割ではありません。

作品は `id,videoId,status,genreId,reviewMemo,manualConfirmedAt,createdAt,updatedAt,published,metadata` を含みます。`published` は**承認済み公開構成への所属**であり、現在のPages配信を実測した値ではありません。`metadata` はタイトル・チャンネル・長さ・取得状態・取得日時・保持期限・`expired` を含みます。期限切れのタイトル・チャンネル・長さはnullになります。

詳細応答は `{generation,work,discoveries,discoveriesTruncated}` です。発見経路は最大100件。`/v1/approved-configuration` は `{generation,movies,queue}` を返し、公開承認を全体置換する前の読取りに使います。

## URL候補登録と審査

`POST /v1/discoveries` の例：

```json
{"expectedGeneration":12,"videoUrl":"https://www.youtube.com/watch?v=AAAAAAAAAAA","source":"担当者の候補一覧"}
```

`videoUrl` は11文字の動画ID、または対応するHTTPS YouTube URLです。`youtu.be`、YouTubeのwatch・shorts・embed・live形式を受け付けます。任意の外部URLは取得しません。`source` は省略時 `manual`、最大200文字の人が付けた発見経路名です。APIタイトルや応答本文の保存先にしません。

応答は状態に `workId,created,discoveryAdded` を加えたものです。新規は `unreviewed` になり、APIメタデータは別の再取得で登録します。同じ動画の再登録は既存作品へ結び付け、採否・ジャンル・メモを上書きしません。同じ発見経路の再送は増殖しません。異なる経路は最大100件まで記録します。削除後の明示的な再登録は新しい未審査IDとなり、旧IDや公開状態を復活させません。

`POST /v1/works/{workId}/review` の例：

```json
{"expectedGeneration":13,"status":"held","reviewMemo":"担当者に確認中","genreId":null}
```

`status` は `unreviewed|held|rejected|approved`。`reviewMemo` は最大2,000文字、`genreId` は既存の有効なジャンルIDです。省略した任意項目は維持し、nullで消去します。メモの通常改行・タブ以外の制御文字は拒否します。審査は人が決め、候補登録や保守から自動採用しません。審査変更だけでは公開JSONを変えません。

## 公開構成の承認

`POST /v1/approvals` は差分追加ではなく、作品とキューの**全体置換**です。最大500作品・2,000キュー項目。配列順が公開順です。

```json
{
  "expectedGeneration":14,
  "movies":[
    {"id":"movie_001","genre":"映画","titleMode":"api"},
    {"id":"movie_002","genre":"短編","titleMode":"manual","manualTitle":"人が指定した上映名"}
  ],
  "queue":[{"id":"queue_001","movieId":"movie_001"}]
}
```

作品は既存の `approved` 状態で、利用可能なAPI情報が必要です。ジャンルは最大200文字、手動タイトルは最大500文字。`titleMode: api` はAPI更新に追従し、`manual` は承認値を維持します。APIタイトルをコピーしただけで保持規定上の由来が変わるわけではありません。

キューIDを別作品へ再利用しません。一度公開キューから外したIDは、同じ作品へ戻す場合も再利用不可です。新しいIDを使います。現在の項目の並び替えはIDを維持します。

`movies: []` と `queue: []` は全作品を非公開にする指定です。本番の動作確認に使いません。P0で初期化済みの環境にP1導入のための再初期化承認は不要です。

## API再取得と削除

`POST /v1/metadata/refresh`：

```json
{"workIds":["movie_001","movie_002"]}
```

重複なしの1～50件。YouTube動画IDやAPI応答本文をクライアントから注入しません。Workerが取得前の世代を記録し、同じ世代のときだけ反映します。応答の `refresh.ok,refresh.unavailable,refresh.apiError` を確認し、HTTP成功だけで全取得成功と判断しません。APIエラーは取得不能回数を増やさず、正常取得日時も延ばしません。

`POST /v1/maintenance/delete-eligible`：

```json
{"expectedGeneration":15}
```

これはドライランではありません。正常応答で24時間以上離れた取得不能が2回以上、または保持期限の削除猶予到来という条件で、全作品を評価して該当作品を削除します。応答には `removedCount` と状態が含まれます。監査には内部作品IDと処理結果を記録し、動画ID・URL・タイトルを残しません。

## 定期保守の実行記録

`GET /v1/maintenance/plan` は `workIds,dueCount,totalCount,refreshIntervalDays,retryHours` を返します。期限の近い順に最大50件です。標準設定では通常13日、失敗等の再試行間隔は24時間以上です。

開始本文は `{"runId":"123456789-1"}`。run IDはGitHubの `run_id-run_attempt` です。終了本文例：

```json
{
  "outcome":"partial",
  "errorCode":"api_error",
  "counts":{"batches":2,"ok":70,"unavailable":0,"apiError":3,"deleted":0,"refreshRequests":2}
}
```

`outcome` は `success|partial|failed`。エラーは定義済みコードだけです。`counts` は上記6キーの省略可能な集計で、値は0～1,000,000の整数です。完全に同じ終了通知を再送できます。

`GET /v1/maintenance/status` は `{lastRun,runs}`。各runに開始・終了時刻、状態、エラー、対象版、集計、`stale` を返します。実行中のまま2時間を超えると `stale: true` になりますが、自動終了やロック解除を意味しません。集計は受信応答に基づき、応答喪失を含む原子的な全件監査ではありません。

## 公開試行と復旧

`GET /v1/publication` は `{revision,libraryJson,queueJson}`。後者は完成済みJSON文字列です。API情報を含むためGitへコミットせず、専用Artifactだけへ書きます。

`begin` 本文は `{"attemptId":"123456789-1","expectedRevision":42}`。`authorize` 本文は `{}` で、Artifactアップロード後・Pages公開直前に呼びます。

`finish` の成功例：

```json
{"outcome":"verified","deployed":true,"libraryMatches":true,"queueMatches":true,"phase":"verify","retryCount":0}
```

結果は `verified|failed|superseded|uncertain`。`verified` には事前認可、配信、両本文一致が必要です。終端通知の完全な再送は可能ですが、異なる結果へ書き換えません。公開要求後のtimeout等でPages終了が不明なら `uncertain` としてロックを維持します。

`GET /v1/deployments/active` は `{attempt:null}`、または `{attempt:{attemptId,revision,authorized,startedAt,outcome}}` を返します。`recover` は信頼された公開workflowがGitHubの該当run・試行・job・Pages stepを検証してから使用します。

```json
{"runId":"123456789","runAttempt":1,"runConclusion":"success","pagesConclusion":"success"}
```

Pages側の根拠は `success` または `not_started` のみです。未実行はGitHubのPages stepが `skipped` と確認できた場合です。復旧記録と解除を一体で行いますが、これだけで検証済み版は進めません。現在の版を新しい試行で配信・照合します。手作業で根拠を推測したり、直接SQLで解除したりしません。

## エラー

本文は `{"error":{"code":"invalid_request"}}` のようなコードだけです。認証失敗401、権限不足403、入力不正400、JSON以外415、本文上限413、予算超過429、設定・保存障害503等。競合は409です。API応答本文、認証ヘッダー、YouTubeキーをログやチャットへ出力しません。
