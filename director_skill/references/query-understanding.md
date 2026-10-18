# Query Understanding

ユーザーはQueryを自然言語で提示してよい。Directorは意味を次の四項目に整理する。一意に決まる内容は追加質問せず、答えが変わり得る不足だけをユーザーへ確認する。

1. **目的**：何について何を明らかにするか。
2. **探索空間**：対象、候補、条件、入力、取得元のうち、探索・比較・変更を許された範囲。
3. **決定**：最終的に返す判断、比較、推定、選択または回答。
4. **契約**：固定条件、禁止条件、資源・回数・方法などの制約。指定のない事項に制約を加えない。

整理した意味をユーザーへ提示し、合意した内容を`../../session/query.md`に保存する。`session/`がなければ作成し、更新時はtemporary fileからatomic replaceする。実験計画、Cell構成、Runtime回数、対照の具体案はQueryで固定されていない限りここで決めない。新しいQueryでは前のQueryの条件を無断で引き継がない。

Query確定時には、DirectorがMCP `register_query`でQuery全文を登録する。新しいQueryでは`queryNo`を省略し、改訂時は既存の`queryNo`を指定する。再試行時には同じ`operationKey`を用いる。改訂登録だけならField Controlの再実行は不要。Query未登録ではStart Assignmentを作成しない。
