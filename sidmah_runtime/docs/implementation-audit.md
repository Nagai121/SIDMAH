# 第二回テストから第三実装への反映

## 正式仕様として維持した事項

DB先行のCell Assignment、filesystem先行のResult固定、WorkerのCell外write禁止、active Director最大1、Starter引渡し時点でStart完了、Result優先の再提示、Manager間失敗の内部retry、archive 3回、resource management非担当、Snapshotのatomic固定を維持した。

## 第二実装の欠陥として排除した事項

- Session Controllerの`queue / active / seen / deadline / valid`をprocess memoryへ置く設計。
- enqueue後にRuntime ManagementがResultを無条件でactiveへする更新。
- active Resultが見つからない際に最新DB rowをEnd対象へ選ぶfallback。
- 300秒のLLM action timeoutと、無応答をsession deathとみなす挙動。
- `delivery_pending` Endを回収しない復旧経路。

## 環境適応と一時回避の扱い

Codexがtaskごとにstdio MCP processを作る点は恒久的な環境条件として採用し、全状態をSQLiteから再構築する。Node導入・MCP登録は配備作業でありSIDMAH状態機械には含めない。24時間timeout、旧session IDの手動退避、Cell 2への迂回は一時回避であり第三実装へ継承しない。

第三実装は旧実装の修正ではなく、所有境界と状態遷移を新規に構築した。既存の役割文書、Assignment schema、Simulator配置規約は、機械interfaceと矛盾しない箇所を原文のまま流用した。

## ZIP監査後の配送補修

- logical source IDとdelivery attempt IDを分離した。後任Worker／Directorには新しいdelivery IDを発行し、同一sessionへのretryでは同じIDを維持する。
- providerのprocessing-started先着を`submitting → active`として受理し、deliver応答はCASでactiveを巻き戻さない。
- `worker_delivery_attempts`と`director_delivery_attempts`へ対象session別の試行履歴を保存する。
- `SidmahSystem`とRuntime ManagementからCell SQLiteの直接照会を除き、Cell Managementの`currentBoundCellNumbers()`を使用する。
