# Cinema Catalog Manager — Stage 1 P0

CCM v0.1 Draft 6 のうち、公開データの整合性に関する P0 の4項目を実装するためのコードです。Cloudflare D1 を正本とし、認証付き Worker を介して公開状態を更新し、GitHub Actions から Pages へ配信します。

| 対象 | この実装の役割 |
|---|---|
| P0-1 公開スナップショット | 承認済みの作品・タイトル方式・ジャンル・キューを保持し、未承認の編集から分離する |
| P0-2 API更新・削除の公開連動 | 承認済み公開構成から新しい版を生成し、作品・関連キュー・監査・公開要求を一体で更新する |
| P0-3 検証結果のD1記録 | デプロイ試行ごとに両JSONの照合結果を記録し、結果保存失敗を成功にしない |
| P0-4 公開直前の版確認 | Artifact作成後に対象版を再確認し、古い版の公開や結果通知による状態の巻き戻りを防ぐ |

**既存の `ccm-db` にそのまま新規作成用DDLを流さないでください。** 提供された既存DDLに対する追加マイグレーションを使います。従来の `publication_snapshots.snapshot_json` は、手動タイトルとAPIタイトルを判別できないため自動移行しません。最初の公開構成を管理者が明示的に承認する必要があります。

- [セットアップと既存環境への移行](docs/setup.md)
- [API契約と呼び出し例](docs/api.md)
- [通常運用・失敗時の確認](docs/operations.md)
- [Stage 1の範囲・保証・残る制約](docs/scope.md)

## 構成

```text
管理者 / 運用オペレーター
  └─ Bearer: CCM_ADMIN_TOKEN ─→ Worker ─→ D1
                                     ├─ 管理中のデータ
                                     ├─ 承認済み公開構成
                                     ├─ 現在の公開スナップショット
                                     └─ 公開要求・デプロイ試行・削除監査

GitHub Actions
  └─ Bearer: CCM_DEPLOY_TOKEN ─→ Worker
  └─ Pages Artifact ─→ GitHub Pages ─→ 公開URL照合 ─→ 結果をWorkerへ
```

Worker の D1 binding は `DB` です。Actions に D1 全体の書込みトークンを渡す必要はありません。管理・公開トークンと YouTube API キーは Secrets に登録し、Git・チャット・公開 Artifact へ含めません。

公開形式は Draft 6 の `library.json` と `queue.json` を維持します。内部のリビジョンや取得状態は公開JSONへ追加しません。

このコードのローカル試験と、本番への適用・実URLの検証は別です。D1への本番マイグレーション、Worker公開、Secrets登録、Pagesデプロイを自動的に済ませたものではありません。

## 開発時の入口

Node.js 22.15 以降と npm、デプロイスクリプトの試験には Python 3 を使用します。依存パッケージはロックファイルに従ってインストールしてください。

```powershell
npm ci
npm test
```

ローカルD1の準備、Worker起動、追加の検証コマンドは [セットアップ](docs/setup.md) を参照してください。テストは合成データを使用します。

P1の Artifact 専用ディレクトリ化・Museの定期実行と障害復旧の実証・探索から削除までの全体結合テスト、P2の過去作品探索・高速審査UIは含みません。
