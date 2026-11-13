# MuseへのP1運用指示

定期処理の実行主体はGitHub Actionsです。Museは起動・監視を担当し、独自の二重スケジュールやD1への直接更新を作りません。P1の本番切替・資格情報設定が完了してから使用します。

## 接続と権限

- リポジトリ：`qiqiqiqiqiq/cinema-catalog-manager`
- 管理API：`https://ccm-stage1-api.diceplus162.workers.dev`
- [保守workflow](https://github.com/qiqiqiqiqiq/cinema-catalog-manager/actions/workflows/maintenance.yml)
- [公開workflow](https://github.com/qiqiqiqiqiq/cinema-catalog-manager/actions/workflows/deploy.yml)
- APIはHTTPS、Bearer認証、`User-Agent: CCM-Muse/0.1` を使用し、リダイレクトを追わない。
- 通常の監視は保守トークンを安全な資格情報設定から参照する。GitHubは対象リポジトリのActionsを読む権限、手動起動時だけActions書込み権限が必要。
- 管理トークンは、人から候補登録・審査・公開承認を明示的に依頼されたときだけ使う。公開結果通知用トークンはworkflowに任せる。秘密の値はチャットやログへ出さない。

## 通常監視に使う指示文

```text
CCMのP1運用を監視してください。定期処理はGitHub Actionsに任せ、
独自の定期処理やD1への直接SQL更新は作らないでください。

1. GET /v1/maintenance/status と GET /v1/state を読み、
   GitHubの maintenance.yml / deploy.yml の実行履歴と照合してください。
2. 保守の最新runの開始・終了、status、errorCode、counts、staleを確認してください。
   通常予定は03:17/09:17/15:17/21:17 JSTです。
   遅延や欠落があり得るので、予定時刻を過ぎただけで障害確定とせず履歴を調べてください。
3. 保守の開始記録が12時間以上増えない、stale=true、一部失敗、公開待ちの継続を見つけたら、
   対象runへのリンク、最後の正常時刻、エラーコード、対象revisionを報告してください。
   12時間は監視上の目安で、コード内の自動復旧期限ではありません。
4. 再実行を依頼されたらmainの保守workflowを新しく起動し、終了まで確認してください。
   CCM_MAINTENANCE_ENABLEDがtrueであることを確認し、
   停止中の設定はユーザーの指示なしに有効化しないでください。
5. 公開完了はverifiedRevisionが現在のrevisionと一致し、
   needsDeployment=falseとなったことを確認して報告してください。
   保守成功と公開成功は別々に確認してください。
6. activeAttemptIdが残っている場合は対象runを調べ、公開workflowの復旧判定に従ってください。
   timeout等でPages終了が不明ならロックを維持して報告してください。
   直接SQL、推測したrecover/finish通知、履歴削除で解除しないでください。

報告は件数・時刻・runリンク・revision・エラーコードに絞ってください。
API本文、タイトル一覧、認証ヘッダー、キーをログへ出さないでください。
countsは応答を受け取れた処理の集計で、応答喪失を含む完全な監査ではありません。
```

## 候補登録・審査を依頼する場合

```text
指定したYouTube URLを /v1/discoveries から候補として登録してください。
既存作品への再発見なら、審査・ジャンル・メモを変更しないでください。
必要なAPIメタデータは /v1/metadata/refresh で取得してください。

採用・保留・却下と公開内容は私が判断します。
私の指定がない限り自動採用・自動承認しないでください。
公開承認の前に /v1/approved-configuration を読み、
公開する全作品・順番・ジャンル・タイトル方式・キューを確認してください。
/v1/approvalsは全体置換なので、既存作品を意図せず落とさないでください。
競合時は状態を読み直し、変更内容を再確認してください。

works[].publishedは承認済み構成への所属です。
実際のPages反映は /v1/state と公開workflowの結果で確認してください。
```

キーワード・チャンネル・再生リストの自動探索や、P2の過去作品探索・審査UIはこのP1実装に含みません。

GitHubの定期実行は遅延・欠落があり、公開リポジトリでは60日間活動がないと無効化されます。Museからの一度の監視だけで長期無人運転を保証せず、workflow有効状態も継続して確認してください。[GitHub公式：schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
