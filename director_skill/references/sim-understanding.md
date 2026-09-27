# Simulator Understanding

対象Simulatorの原本はproject rootの`simulator/`に置く。`simulator/SIMULATOR_PLACEMENT.md`は配置案内であり、Simulatorの資料に数えない。対象を特定できる内容がなければ、配置または説明をユーザーへ求める。SIDMAH自身を対象Simulatorとして扱わない。

README、設定、コードなど対象の根拠に基づき、次を確認する。該当しない項目は無理に埋めず、対象に該当しない理由を示す。不明点や資料とコードの矛盾を残したまま、実行方法を推測しない。

1. 目的、対象、適用範囲。
2. モデルまたは処理の境界、含むものと含まないもの。
3. 必要な入力、条件、パラメータとその由来。
4. 処理の流れ、必要な環境、依存関係、停止条件。
5. 観測できる出力、解釈に必要な解析、失敗の見分け方。
6. 変更できる条件と、その変更から評価できること。
7. 既知の限界、不明点、資料と実装の矛盾。

理解に必要な場合だけ`../../test/`で試験する。この試験はSimulator理解のために行い、Runtime実験やQueryへの結果として扱わない。理解した内容をユーザーへ提示し、合意後に`../../session/simulator.md`へ保存する。`session/`がなければ作成し、更新時はtemporary fileからatomic replaceする。Simulatorが変わった場合は理解を更新し、Field Controlで既存の証拠を再利用できるか判断する。
