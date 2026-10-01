# Provider contract

Worker LLM sessionの起動はDirectorの責務であり、Provider outboxはspawn要求を持たない。`create_cell_assignment`はCell、provisioning Worker、Binding、fence、pending assignmentを永続化し、Directorへmodel、reasoning effort、bootstrap、assignment payloadを返す。

DirectorがWorkerを起動した後、そのWorkerは最初に`accept_cell_assignment`を呼ぶ。Workerはbootstrapに含まれる`assignmentId`をそのまま渡す。ManagerはMCP requestのthread identityと指定IDを使い、active Director runに属する対応するpending Cell Assignmentをclaimする。ID省略時は後方互換のためpendingがちょうど1件の場合だけ受け付ける。指定IDが別Workerに属する場合や、ID省略時にpendingが0件または複数の場合はfail-closedする。

Provider境界が扱うのは次だけである。

- `delivery/<deliveryId>.json`: Start、Result、Endのsession配送。再送は同じdelivery IDを使う。
- `terminate/<providerSessionId>.json`: Director終了等による明示的session終了要求の永続記録。OutboxProvider単体では外部consumerが必要である。
- `delivery-started`: providerが処理開始したことの通知。
- `session-ended`: provider session終了の通知。

ManagerのSQLiteがdurable state、dedupe、Binding、fence、active slotの正本であり、provider process memoryは正本にしない。

## 内部サブエージェントの配送（既定）

project rootに`provider-config.json`がなければ`collaboration`方式を使う。明示する場合は`{"mode":"collaboration"}`。MCP serverと独立executorは同じ選択関数を使う。run中は設定を変更せず、変更後はMCPを再起動する。

既定providerはOutboxProviderで、通知のdurable enqueueまでを担当する。`accepted: true, processingStarted: false`はoutbox保存の受付であり、Workerへの通知成功や計算開始の証明ではない。Managerは対応するslotをsubmittedとして保持する。`codex queue`、`thread/resume`、`thread/archive`は内部サブエージェントに呼ばない。

DirectorはCellと起動したサブエージェント名の対応を保持し、`create_start_assignment`が返す`deliveries`を対応するWorkerへの`followup_task`で渡す。Runtime実行中は`get_pending_deliveries`でResult通知を確認して同じWorkerへ渡す。WorkerのEnd通知はDirector自身が同toolから取得しreviewする。これらの専用連携操作は親エージェントが実行する。Node providerが専用ツールを直接呼ぶことはない。親が動作していない間の自動wakeは提供しない。

`get_pending_deliveries`は現在のsubmitted slotだけを返し、取得自体ではclaimしない。Workerには自身のcurrent Bindingの通知だけ、Directorには自身のactive runのWorker通知と自身宛てEndだけを返す。古いoutboxファイルを全件再配送しない。正常な`starter`、`create_end_assignment`、`complete_end_review`によって初めてactiveへ進む。連携通知が失敗した場合もsubmittedのままで、同じdeliveryを再通知できる。既存のfence、source、session照合と二重実行防止を維持する。

終了要求はoutboxのterminate/へ保存する。Directorは`director_end`後に自身が起動したWorkerを専用のinterrupt操作で停止する。outboxへの終了要求保存を、実際のサブエージェント停止済みと報告してはいけない。

## 通常チャットのCodex配送アダプター（明示選択）

独立した通常チャットをWorkerにする統合では`provider-config.json`に`{"mode":"codex-queue"}`を指定する。内部サブエージェントはこの方式の対応対象ではない。拒否時に成功扱いへ自動fallbackしない。

標準の`CodexQueueProvider`は、まず上記delivery JSONを固定し、`codex queue --thread <providerSessionId> --message <固定通知>`を呼ぶ。通知にはdelivery IDと参照先を含める。`queued/<deliveryId>.json`はqueue成功の記録であり、同じ配送試行のwake失敗ではqueueを重複させない。次に`codex app-server proxy`経由で`initialize`と`thread/resume`を送り、休止中の対象チャットを起こす。CLIが失敗したときはManagerのitemをpendingへ戻し、`last_error`とmachine logに残す。起動時のrecoveryや別のMCP操作はこの配送失敗に巻き込まない。

`queue`の成功は**処理開始の証明ではない**。Workerの`starter`／`create_end_assignment`、Directorの`complete_end_review`が対象のBinding、session、inbox kindを照合して初めてactiveへ進める。既存の`delivery-started`イベントも互換経路として受け付ける。遅れたprovider応答でactiveをsubmittedへ戻さない。

queueまたはresumeの失敗はその場で最大3回再試行し、Managerも稼働中に2秒、10秒、30秒後の再配送を最大3回試す。`submitted`のままMCP受信確認がない場合は5分、15分、30分後に同じdelivery IDの通知を再送する。受信確認済みのitemは再送しない。WorkerのBindingまたはDirector runが変わったitemへは旧セッション宛ての再送をしない。CLIまたは接続先app-serverが利用できない場合もdelivery JSONとpending stateは保持される。再試行上限後に残ったitemはmachine logとDB stateを調べる。

## 保証範囲

再通知は同じdelivery IDのCodexメッセージを複数回投入し得る。SIDMAH側の受信処理は現在のsession、BindingまたはDirector run、inbox kindとsource、fenceで照合し、同じRuntimeを二重に実行しない。app-serverのresume成功やCodex turnの完了はMCP受信確認に代わらない。これは稼働中セッション向けのat-least-once通知とSIDMAH側の冪等化であり、分散トランザクションではない。

PCまたはCodex再起動後の未確認配送の自動再開は今回の範囲外である。DBとdelivery JSONは残るが、再起動だけで対象チャットが起きる保証はない。実チャットを用いた無人配送の結合試験も別環境で必要である。

`CodexQueueProvider.terminate()`は終了要求を保存した後、同じapp-server proxyで`thread/archive`を呼ぶ。Codexは対象の稼働中threadをshutdownし、履歴をarchiveする。終了RPCの失敗はDirector終了の返り値とmachine logへ記録する。実Codexでのsession終了の結合試験は別環境で必要である。
