# Cinema Catalog Manager — Stage 1 P0 / P1

CCM v0.1 Draft 6を基に、Cloudflare D1を正本として作品・公開状態を管理します。認証付きWorkerが更新を受け付け、GitHub Actionsが保守とGitHub Pagesへの公開を行います。MuseはActionsの起動・監視と、人が指示した管理操作を担当します。

| 実装単位 | 内容 |
|---|---|
| P0 | 承認済み公開スナップショット、API更新・削除との連動、検証結果のD1記録、公開直前の版確認 |
| P1 | 公開Artifactを2つのJSONに限定、定期保守と根拠に基づく公開ロック復旧、URL候補登録から審査・公開・削除までの結合試験 |

P0の既存環境を引き継ぐ追加実装です。P1の本番マイグレーション・Worker更新・main反映・定期実行の有効化は、ローカル検証とは別です。既存の公開構成を初期化し直す必要はありません。

- [セットアップとP0環境からの更新](docs/setup.md)
- [API契約](docs/api.md)
- [通常運用・障害復旧](docs/operations.md)
- [Museへの指示](docs/muse-p1.md)
- [実装範囲と検証の限界](docs/scope.md)
- [P1の受入試験記録](docs/p1-acceptance.md)

## 処理の流れ

人がURL候補を登録し、審査結果と公開構成を承認します。その後はActionsが期限に応じたAPI再取得・削除判定を行い、公開が必要なら共通の公開workflowを呼びます。公開Artifactは `public-artifact/library.json` と `public-artifact/queue.json` だけです。Pagesの両URLを照合してから結果をD1へ記録します。

定期保守は `main` で、Repository Variable `CCM_MAINTENANCE_ENABLED` が文字列 `true` のときだけ動きます。予定時刻は毎日03:17・09:17・15:17・21:17 JSTです。各作品を毎回取得するのではなく、通常は最終正常取得から13日後、失敗・取得不能は前回試行から24時間以上後に対象とします。

管理・保守・公開は別のトークンを使います。ActionsにD1の直接書込み資格情報、管理トークン、YouTubeキーを渡す必要はありません。公開形式は既存の `library.json` と `queue.json` のままです。

## 開発

Node.js 22.15以降、npm、Python 3を使用します。

```powershell
npm ci
npm test
npm run check:bundle
```

試験は合成データとローカルD1を使用します。URL単体の候補登録から削除までを検証しますが、キーワード・チャンネル・再生リストの新着自動探索、P2の過去作品探索・高速審査UIは今回の対象外です。長期間の無人運転を実証済みとは扱いません。
