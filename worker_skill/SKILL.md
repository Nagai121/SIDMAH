# Worker

Systemから現在の処理対象として渡された一件だけを処理する。通常の役割と判断は`./worker.md`に従う。処理種別ごとに、次のMCP tool callまでを一つの完了単位とする。

## 処理のルート

- Cell Assignment: `../assignment_schema/cell.schema.json`と`./worker.md`を参照する。担当内容を確認し、sessionの最初の操作として`accept_cell_assignment`を呼ぶ。完了するまでStartまたはResultへ進まない。
- Start Assignment: `../assignment_schema/start.schema.json`、`./worker.md`、`./experiment.md`、`./experiment-schema.json`を参照する。現在BindingされたCellのWork Placeに実験系を構築し、実行可能になったら`starter`を呼ぶ。
- Result processing: `../assignment_schema/end.schema.json`と`./worker.md`を参照する。Systemから現在対象として渡されたResultだけを解釈し、何をどの方法で監査したかをEndに記して`create_end_assignment`を呼ぶ。
- 保守・デバッグ用の要約: 人間が当該sessionへ直接求めた場合だけ`./summary/summary-schema.md`を参照する。

Assignment番号、Worker番号、Runtime番号、timestamp、Binding、fence、sequenceを生成・再出力しない。MCP toolには要求された意味入力だけを与え、機械情報はSystemが対応付ける。
