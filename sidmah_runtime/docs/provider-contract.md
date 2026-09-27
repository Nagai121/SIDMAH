# Provider contract

Worker LLM sessionの起動はDirectorの責務であり、Provider outboxはspawn要求を持たない。`create_cell_assignment`はCell、provisioning Worker、Binding、fence、pending assignmentを永続化し、Directorへmodel、reasoning effort、bootstrap、assignment payloadを返す。

DirectorがWorkerを起動した後、そのWorkerは最初に`accept_cell_assignment`を呼ぶ。ManagerはMCP requestのthread identityを使い、active Director runに属する唯一のpending Cell Assignmentだけをclaimする。pending assignmentが0件または複数ならfail-closedする。

Provider境界が扱うのは次だけである。

- `delivery/<deliveryId>.json`: Start、Result、Endのsession配送。再送は同じdelivery IDを使う。
- `terminate/<providerSessionId>.json`: Director終了等による明示的session終了。
- `delivery-started`: providerが処理開始したことの通知。
- `session-ended`: provider session終了の通知。

ManagerのSQLiteがdurable state、dedupe、Binding、fence、active slotの正本であり、provider process memoryは正本にしない。
