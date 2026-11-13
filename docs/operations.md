# 運用と失敗時の確認

## 定期保守

`Maintain CCM catalog`（`maintenance.yml`）は `main` で6時間ごと、毎日03:17・09:17・15:17・21:17 JSTに起動予定です。`CCM_MAINTENANCE_ENABLED` が文字列 `true` のときだけ実行します。手動起動にも同じ条件が適用されます。

1. D1に実行IDを記録し、期限の近い対象から最大50作品ずつ再取得する。
2. 通常は最終正常取得から13日後を目安に対象とする。新規・取得失敗・取得不能は前回試行から24時間以上空ける。未審査・保留・却下・採用のすべてを対象にする。
3. APIエラーや予算不足があっても、保持期限に基づく削除条件を独立して評価する。
4. 実行結果をD1へ保存し、公開待ちまたは残った公開ロックがあれば共通の公開workflowを呼ぶ。一部失敗しても、確定済み更新・削除の公開を試みる。

再取得は1回の実行につき最大100バッチです。各作品の `last_attempt_at` を進捗に使うため、失敗した先頭の作品だけを同じ実行内で繰り返しません。停止後は次回に未処理・期限到来の作品から再開します。APIエラーで正常取得日時や保持期限を延ばしません。

削除条件はP0と同じです。正常API応答による取得不能が24時間以上離れて2回以上確認された場合、または通常30日の保持期限に対し72時間の削除猶予へ到達した場合に、作品・API情報・関連キュー・公開構成を一体で除去します。日数はWorker設定に従います。

## 監視

Muse向け指示は[muse-p1.md](muse-p1.md)を参照してください。

| 確認先・状態 | 判断 |
|---|---|
| `GET /v1/maintenance/status` | 最新20件の保守run。`lastRun` の日時・結果・件数を確認する |
| `status: partial/failed` | 取得・削除・結果記録等の問題を調べる。公開結果とは分けて報告する |
| `stale: true` | `running` のまま2時間超過。元のActions実行を確認する |
| 長時間runが追加されない | 予定時刻、GitHub履歴、有効化変数、workflowの有効状態を照合する |
| `needsDeployment: true` | 現在の公開版の反映が未完了 |
| `activeAttemptId` あり | その試行が公開権を保持中。強制上書きしない |
| `verifiedRevision === revision` かつ `needsDeployment: false` | 現在の版の照合結果がD1に記録されている |

保守の `counts` は `batches`, `ok`, `unavailable`, `apiError`, `deleted`, `refreshRequests` です。受信できた応答を集計した値で、通信断直前にD1へ確定した処理まで漏れなく数える監査ではありません。`refreshRequests` は送信試行数であり、YouTube消費量の確定値ではありません。タイトル、API応答本文、認証ヘッダーはログに出しません。

GitHub Actionsは予定実行が遅延・欠落する場合があります。公開リポジトリでは60日間活動がないと定期workflowが無効化されるため、長期運用では稼働確認が必要です。[GitHub公式：schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

## 人の承認と公開

URL候補登録と審査は[API契約](api.md)に従います。採否は人が決めます。審査状態やメモだけを変えても、公開構成は変わりません。公開する作品・順番・ジャンル・タイトル方式・キュー全体を別途承認します。

`Deploy CCM public JSON` を `main` で起動します。任意の `revision` には現在の版を指定します。空欄なら開始時点の最新版が対象です。本文が変わらず `generation` だけ増えた更新では、再公開が不要な場合があります。

```text
旧ロックの確認・復旧 → prepare → check-artifact → Artifactアップロード
  → authorize → Pages配信 → verify → finish
```

公開Artifactには `public-artifact/library.json` と `public-artifact/queue.json` だけを含めます。余分なファイル、シンボリックリンク・ハードリンク、作成後に変わった本文を拒否します。試行文脈は `RUNNER_TEMP` に置き、トークンや公開本文を含めません。

配信後2分・10分・30分を目安に照合します。片方だけ一致しても成功にしません。D1への結果保存が失敗した場合も公開完了とは報告しません。検証間隔は配信時間の保証ではありません。

## 公開ロックの復旧

公開workflowは最初に `scripts/ccm_recover.py` を実行します。ロックが残っている場合、記録された `run_id-run_attempt` に対応するGitHub実行・job・Pages stepを読みます。

| 確認できた事実 | 動作 |
|---|---|
| 対象実行・jobが終了し、Pages stepが `success` | 事前認可と一致する場合に復旧記録を残して解除し、新しい試行で現在の版を配信・照合 |
| 対象実行・jobが終了し、Pages stepが `skipped` | 公開要求が出ていない根拠を記録し、新しい試行で現在の版を公開 |
| 実行中、情報不足、対象を特定できない | 停止してロック維持 |
| Pages stepが `failure`・`cancelled`・`timed_out` 等 | 外部Pages処理の終了を断定せず、ロック維持 |

GitHubの成功だけで `verifiedRevision` を進めません。復旧は新しい公開試行へ進むための手続きです。公開用トークンを持つworkflowを報告元として信頼する点はP0の `finish` と同じです。

不明なケースは元run、Pages状態、公開本文を運用担当者が確認します。DBのロックを直接NULLにする、履歴を消す、推測した根拠で `recover` を呼ぶ操作は行いません。根拠なしの強制解除機能はありません。

同じ終端通知・復旧根拠の再送は可能です。確定済み結果を別の本文へ書き換えたり、終了した試行IDを新しい試行に使ったりしません。古い通知が最新版を検証済みにすることもありません。

## 停止・期限超過の対応

定期処理を止める場合は `CCM_MAINTENANCE_ENABLED` を `false` にします。変数変更は実行中の外部処理を停止させないため、実行中runを別途確認します。

期限が迫っても公開待ちが解消しない場合は保守障害として扱います。D1削除とCDN・VRChatを含む全コピーの消去は同義ではありません。非常時のサイト停止は今回の対象外です。

Museを含む通常操作はWorker経由に統一します。旧JSONをGitへ戻したりD1へ直接書き込んだりせず、現在のデータを改めてレビューして新しい公開版を作ります。

`workers.dev` で403が出たときは認証だけでなくUser-Agentも確認します。付属スクリプトは `CCM-Publication/0.1` を使用し、リダイレクトを拒否します。[Cloudflareの公式説明](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/)
