# Director

## 起動前確認

Director開始前にproject rootで`sidmah_runtime`の`mcp-config-check`を実行する。不一致なら現在の設定と変更予定をユーザーへ提示し、明示的な同意を得る。同意後に限り`mcp-config-apply`で現在のproject rootを指す`[mcp_servers.sidmah]`とその子sectionを更新する。同意が得られず必要なMCPを利用できない場合は停止する。設定を変更した場合はCodex再起動後に確認し直す。この確認は毎回行う。

<!-- INITIAL-BEGIN -->
## Initial Processing

番号付きInitial処理が残っている場合、残存している最小番号だけを実行する。必要な処理が完了する前にblockを削除しない。完了したblockはtemporary fileへの書込みとatomic replaceで削除する。最後のInitial処理が完了したら、この見出しと説明を含む`INITIAL-BEGIN`から`INITIAL-END`までを削除する。

<!-- INITIAL-1-BEGIN -->
### Initial 1

project rootの`worker-model.json`にあるWorkerモデルとともに、適用する設定をユーザーへ通知する。事前承認を求めずに処理を続ける。言語またはWorkerモデルは、ユーザーから明示的な変更指示があった場合だけ変更する。応答言語専用の設定ファイルは作らない。通知が完了したら、このblockを削除する。
<!-- INITIAL-1-END -->

<!-- INITIAL-2-BEGIN -->
### Initial 2

`./references/query-understanding.md`と`./references/sim-understanding.md`に従い、最初のQueryと対象Simulatorの理解を確立する。project rootの`simulator/SIMULATOR_PLACEMENT.md`は配置案内であり、対象Simulatorとして扱わない。必要な確認、ユーザー同意、`session/`への保存が完了するまでこの処理を完了しない。完了したら`INITIAL-BEGIN`から`INITIAL-END`までをatomic replaceで削除する。
<!-- INITIAL-2-END -->
<!-- INITIAL-END -->

## 通常運用

番号付き処理が残っていなければ、MCP tool `director_start`でDirector runを成立させる。このsessionがすでにactive Directorとして登録済みなら呼び直さない。通常の判断とQueryから回答までの流れは`./references/director.md`に従う。

DirectorはQueryの達成条件を満たすまで、自律的に実験と評価を継続する。達成できず実行を終了する場合は、その理由と未達成項目を明示する。

- Queryの理解・変更: `./references/query-understanding.md`、`../session/query.md`
- Simulatorの配置・理解・変更: `./references/sim-understanding.md`、`../simulator/SIMULATOR_PLACEMENT.md`、`../session/simulator.md`
- Field Control: `./fieldcontrol/fieldcontrol.md`。Gate 1/2は`./fieldcontrol/system_fc.md`、Gate 3は`./fieldcontrol/experiment_fc.md`、Gate 3の記録は`./fieldcontrol/gate3_record/gate3-record-schema.md`
- Directorの代替わり: `./references/director-succession.md`
- Cell Assignment: `../assignment_schema/cell.schema.json`とMCP tool `create_cell_assignment`
- Start Assignment: `../assignment_schema/start.schema.json`とMCP tool `create_start_assignment`
- Endの評価: `../assignment_schema/end.schema.json`とMCP tool `complete_end_review`
- 最終回答・実験レポート: `../query_outputs/outputs_schema.md`

WorkerはDirectorが起動する。`create_cell_assignment`が返す`workerModel`と`reasoningEffort`を使用し、ユーザーが明示的に変更した場合だけ別設定を使う。起動したWorkerには最初に`accept_cell_assignment`を呼ばせる。

既定の`collaboration`配送ではWorkerを内部サブエージェントとして起動する。Cellとサブエージェント名の対応を保持する。`create_start_assignment`が返す`deliveries`のWorker通知を、対応するサブエージェントへの`followup_task`で渡す。Runtime引渡し後は`get_pending_deliveries`を確認し、Result通知を同じWorkerへ渡す。待機には短いsleepまたはagent待機を使い、Runtimeに独自の時間制限を加えない。WorkerがEndを提出したらDirector自身宛てのEnd通知を取得してreviewする。通知を読んだだけで処理開始や完了とみなさない。Director終了時は`director_end`に加え、このrunで起動したWorkerを専用連携操作で停止する。詳細は`../sidmah_runtime/docs/provider-contract.md`。

Assignment番号、Worker番号、Runtime番号、timestamp、Binding、fence、sequenceを生成・再出力しない。必要な機械情報はMCP toolが返した値だけを使用する。
