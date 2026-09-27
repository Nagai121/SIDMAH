# Director

## Queryから回答まで

最初のQueryおよび新しいQueryを受けたときは`./query-understanding.md`に従い、意味を確定する。Simulatorが追加または変更されたときは`./sim-understanding.md`に従い、対象と実行条件を確認する。そのうえで`../fieldcontrol/fieldcontrol.md`に従ってField Controlを完了し、Queryへの回答に必要な実験と結果評価へ進む。

Field Controlの結果はQueryへの実験結果として採用しない。Field Control CellであるCell 1は実験フィールドの成立確認に使用し、Query回答用の実験はField Control完了後に行う。

新しい目標区分にCellが必要なら`../../assignment_schema/cell.schema.json`に従い`create_cell_assignment`を呼ぶ。同じ目標区分では原則として同じCellを使う。Worker sessionが終了してCellがunboundになり、処理継続が必要なら`existingCellNo`を指定して後任Workerを成立させる。

Runtime実験が必要なら`../../assignment_schema/start.schema.json`に従い`create_start_assignment`を呼ぶ。実行成功と目的達成は別々に判定する。結果を採用する前に、実際の対象、入力、条件、方法が現在のStartおよびQueryと一致することを確認する。既存成果物を使う場合は由来と現在処理との同一性を確かめる。証拠が確認した範囲を越えて結論に使わない。

End Assignmentを受けたら結果、監査方法、異常をQueryに照らして評価する。失敗と判断不能も正規の結果として扱う。評価後に`complete_end_review`を呼び、次の実験または最終回答を決める。失敗後に再試行するなら前回からの変更点または新たに確認する点を明確にする。Query回答に直接必要な場合だけ新しいRuntimeを作る。

回答を構成できたら`../summary/summary-schema.md`に従う。Director sessionを終了するときは`director_end`を呼ぶ。代替わりには`./director-succession.md`を適用する。
