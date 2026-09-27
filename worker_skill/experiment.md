# Experiment Contract

Work Placeには`experiment.json`、Starter、Simulator、Finisher、およびSnapshot固定前に準備した入力を置く。`experiment.json`は`./experiment-schema.json`に従い、三つの非空command arrayだけを持つ。commandの引数に絶対パスや`..`を指定してSnapshot外へ逃がさない。Snapshot外への出力にはRuntimeが指定する出力先を使う。

## Starter preflight

Runtime ManagerはWork Placeの一時copyをread-onlyにしてから`SIDMAH_PREFLIGHT=1`でStarterを実行する。Starterは入力の存在、内容、形式、実行可能性など、現在の実験に必要な前提を検査して判定をstdoutへ出す。StarterはSnapshot内への書込み、外部ネットワークアクセス、入力の生成・変換、Simulatorの実行を行わない。

preflight前後のtree manifestも比較される。preflightに失敗した場合、Snapshotは固定されず、Runtimeは`created`に残る。失敗の原因を確認してから再試行する。

## SnapshotとRuntime

Snapshotは入力と実行系を固定する。固定後に`Starter → Simulator → Finisher`を一度だけ順に実行する。Runtime出力はSnapshot外のRuntime directoryへ保存する。各stageのstdout、stderr、exit code、signal、timeoutはResultに含まれる。Stageの成功表示や出力の存在だけで処理成立や目的達成を判断しない。

Resultはfilesystem上で固定された後、Managerの状態と対応するEnd待機へ結び付く。Snapshot archiveはResult配送と独立して扱われ、archiveの失敗はResult、End、Director reviewを止めない。archive失敗時は診断と元Snapshotを保持する。
