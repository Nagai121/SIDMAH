# Provider contract

Worker LLM sessionの起動はDirectorの責務であり、Provider outboxはspawn要求を持たない。`create_cell_assignment`はCell、provisioning Worker、Binding、fence、pending assignmentを永続化し、Directorへmodel、reasoning effort、bootstrap、assignment payloadを返す。

DirectorがWorkerを起動した後、そのWorkerは最初に`accept_cell_assignment`を呼ぶ。ManagerはMCP requestのthread identityを使い、active Director runに属する唯一のpending Cell Assignmentだけをclaimする。pending assignmentが0件または複数ならfail-closedする。

Provider境界が扱うのは次だけである。

- `delivery/<deliveryId>.json`: Start、Result、Endのsession配送。再送は同じdelivery IDを使う。
- `terminate/<providerSessionId>.json`: Director終了等による明示的session終了。
- `delivery-started`: providerが処理開始したことの通知。
- `session-ended`: provider session終了の通知。

ManagerのSQLiteがdurable state、dedupe、Binding、fence、active slotの正本であり、provider process memoryは正本にしない。

## Codex配送アダプター

標準の`CodexQueueProvider`は、まず上記delivery JSONを固定し、`codex queue --thread <providerSessionId> --message <固定通知>`を呼ぶ。通知にはdelivery IDと参照先を含める。`queued/<deliveryId>.json`はqueue成功の記録であり、同じ配送試行のwake失敗ではqueueを重複させない。次に`codex app-server proxy`経由で`initialize`と`thread/resume`を送り、休止中の対象チャットを起こす。CLIが失敗したときはManagerのitemをpendingへ戻し、`last_error`とmachine logに残す。起動時のrecoveryや別のMCP操作はこの配送失敗に巻き込まない。

`queue`の成功は**処理開始の証明ではない**。Workerの`starter`／`create_end_assignment`、Directorの`complete_end_review`が対象のBinding、session、inbox kindを照合して初めてactiveへ進める。既存の`delivery-started`イベントも互換経路として受け付ける。遅れたprovider応答でactiveをsubmittedへ戻さない。

queueまたはresumeの失敗はその場で最大3回再試行し、Managerも稼働中に2秒、10秒、30秒後の再配送を最大3回試す。`submitted`のままMCP受信確認がない場合は5分、15分、30分後に同じdelivery IDの通知を再送する。受信確認済みのitemは再送しない。WorkerのBindingまたはDirector runが変わったitemへは旧セッション宛ての再送をしない。CLIまたは接続先app-serverが利用できない場合もdelivery JSONとpending stateは保持される。再試行上限後に残ったitemはmachine logとDB stateを調べる。

## 保証範囲

再通知は同じdelivery IDのCodexメッセージを複数回投入し得る。SIDMAH側の受信処理は現在のsession、BindingまたはDirector run、inbox kindとsource、fenceで照合し、同じRuntimeを二重に実行しない。app-serverのresume成功やCodex turnの完了はMCP受信確認に代わらない。これは稼働中セッション向けのat-least-once通知とSIDMAH側の冪等化であり、分散トランザクションではない。

PCまたはCodex再起動後の未確認配送の自動再開は今回の範囲外である。DBとdelivery JSONは残るが、再起動だけで対象チャットが起きる保証はない。実チャットを用いた無人配送の結合試験も別環境で必要である。
