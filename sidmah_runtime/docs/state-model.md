# 状態所有モデル

## 所有境界

- Cell Management: Cell、Worker、Binding、Cell Assignment、Worker session inbox全体、Worker active slotの唯一の所有者。
- Runtime Management: Start、Runtime、Result参照、Result Context、End、Director inboxとそのactive slotの所有者。
- Session Controller: statelessなprovider境界。queue、active、seen、timeoutをprocess memoryへ保持しない。
- provider: sessionのspawn・配送・終了を実行し、filesystem sandboxとtool allow-listを強制する。
- Worker model: project rootの`worker-model.json`を設定正本とし、Cell ManagementがCell Assignment作成時にDirectorへ返す。Worker sessionの起動はDirectorが行い、Manager/provider outboxはspawnしない。

Manager間引渡しは送信側SQLiteのdurable dispatch rowから始まり、受信側はsource machine IDの一意制約で冪等登録する。送信側は登録成功後にregisteredへ進める。再起動時は未完了rowを同じIDで再試行する。

## Worker inbox

各有効Worker sessionのslotは最大1件である。優先順は、未完了Result、Starter未完了Start、未配送Start。`submitting`はproviderへの再送可能状態、`submitted`はprovider受理済みだが処理開始前、`active`はLLM処理開始後である。完全なtool callだけが処理を完了する。streamingや内部retryを時刻で完了扱いにしない。

`source_id`は論理仕事の同一性、`delivery_id`は配送先sessionごとの試行を表す。同じsessionへのretryは同じdelivery IDを使い、WorkerまたはDirectorの後任sessionへ再提示するときだけ新規delivery IDを発行する。各試行はdelivery attempts表へ保存する。

providerのprocessing-started通知は`submitting`と`submitted`の両方から`active`へ進める。遅れて戻ったdeliver応答はCAS更新により`active`を`submitted`へ戻さない。

Worker終了はproviderの明示イベントだけで確定する。処理中のStart/ResultはCellへ戻し、後任Bindingへ同じsource IDで再提示する。elapsed timeだけでWorkerを失効させない。

## RuntimeとResult

StarterはWork Placeをtemporary Snapshotへ複製・検証し、atomic renameで固定する。DBを`launching`へ進めて独立executorへ引き渡した時点でStartを完了する。executorは`starter → simulator → finisher`を順次実行する。

Resultは`result.json`とSHA-256付き`result.manifest.json`をfilesystemへatomicに固定した後、単一SQLite transactionでRuntime finished、Result参照、End meaning_pending、Result Contextを確定する。再起動時にはmanifestを検証してDBを収束させる。

EndはWorkerのactive Result ContextだけからRuntimeへ結合する。最新rowや複数active rowから推定しない。Directorにも最大1件のactive Endだけを提示し、`complete_end_review`後に次を提示する。

Snapshot archiveは最大3回試行する。成功時だけ原Snapshotを削除する。失敗時は`failed`として原Snapshotを保持し、ResultとEndは継続する。`archive(runtimeId)`を管理者が明示的に再実行できる。

## v1.0.2の復旧と時間制限

`create_start_assignment.timeoutMs`は任意入力であり、ユーザー指定時だけ正の整数を渡す。省略時は既存DBの`timeout_ms=0`で無制限を表す。Starter preflightにも同じ指定を適用し、独立した30秒の上限は設けない。

`created + commit_pending`で正式Snapshotが存在する場合、保存したmanifestとの同一性と現在のWorker処理権を確認して`launching + fixed`へ収束させる。一時Snapshotだけなら次回Starterで再利用し、両方なければ再構築する。不一致の正式Snapshotは採用せず、次回Starterで再構築する。

`finished + archive fixed + cleanup未完了`も復旧対象とし、固定archiveが読み出せることを確認して元Snapshotの削除だけを再試行する。archiveが欠落・破損していれば元Snapshotを保持し、診断を残す。
