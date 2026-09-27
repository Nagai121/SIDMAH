# System Field Control

## Gate 1: 制御系

SIDMAHのMCP toolとManagerへアクセスでき、Director runが有効で、Cell 1を通常の管理経路で成立させられることを確認する。Cellの番号、Binding、fenceなどはtoolの返答を使用する。確認できない場合は停止して状態を記録する。研究処理の一部としてNode導入、MCP登録、Manager DB修理、権限変更を行わない。

## Gate 2: Runtime経路

対象Simulatorの計算を含まない最小の実験系を、Cell 1の通常経路で一度流す。Workerを起動してCell Assignmentを受理させ、`Start → Snapshot → Starter → Simulator → Finisher → Result → End → review`が成立することを確認する。

- Starterのpreflightがread-only copy上で成功し、入力の検査中にSnapshotへ書き込まない。
- SimulatorとFinisherの出力がSnapshot外のRuntime directoryへ保存される。
- 各stageのstdout、stderr、exit codeと失敗状態がResultに残る。
- Resultが対応するWorkerへ届き、WorkerのEndがDirectorへ届いてreviewを完了できる。
- Snapshot archiveの故障が起きてもResult、End、reviewが継続し、故障診断と元Snapshotが残る。

Archive故障の確認には実データを使わず、Runtime側が備える故障注入経路を使用する。故障注入のためにsandbox権限を変えない。

最初の完全な通過後、新しいQueryではGate 1とGate 2を順番に再確認する。簡略確認を使う場合は、前回の完全な通過記録が参照でき、現在のMCP、Manager、Cell/Worker配送経路とRuntime契約に変化や障害の徴候がないことを確かめ、確認した範囲を残す。根拠が不足する場合は通常経路でGateを通し直す。
