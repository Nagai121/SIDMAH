# SIDMAH → SIDERA 中間体: 機械制御の分離（作業中）

この文書は、[Issue #3](https://github.com/Nagai121/SIDMAH/issues/3) の訂正後の前提を記録したものであり、未決定の設計を確定するものではない。

## 確定した範囲

- **マルチエージェントは維持**する。Director / Sub-Director / Worker の役割構造を対象とする。
- 撤廃するのは **機械制御**。Binding、fence、claim、inbox占有、配送再送・二重実行防止、状態照合などの強制的な処理統制を再設計の対象とする。
- Start、End、Cell Assignment の意味内容は保つ。Runtimeに必要な機械記録は開始・終了・伝播とReportの関連付けを中心とする。
- 実験結果の保護に該当する Snapshot の固定、事前検査、結果のハッシュ検証を残す。
- Query理解、Simulator理解、Gate 3、結果の監査・報告、Query履歴・統合検索は継承対象。
- 既存のSIDMAH mainは変更しない。

## このブランチで実施した変更

- `src/runtime/snapshot.ts`：実験契約の検査、Snapshot固定関連ユーティリティ、read-only preflight、診断をRuntimeManagerから独立させた。
- `src/runtime/result-integrity.ts`：固定済みResultの検証をRuntimeManagerから独立させた。
- `src/manager/runtime-manager.ts`：上記関数を利用するよう既存コードを更新。現段階では旧機械制御は残っている。
- `test/sidera-artifacts.test.ts`：配送やCell管理に依存しないSnapshot / Result検査のテストを追加。

これらは分離の準備であり、**機械制御の撤廃が完了したという意味ではない**。

## 続く実装で扱う範囲

- CellManager、RuntimeManager、ProviderとSystemの厳格な状態管理・配送の除去と、意味上の役割／実験の保持。
- RuntimeManager内に残るSnapshot確定、結果の固定とarchive処理の、統制依存部分からの分離。
- Manager DBを前提にしたIntegratedStoreの同期先変更。
- Gate 1/2の既存機械制御前提の見直し。
- 既存テストを配送統制の検査と成果物検証の検査に分ける。

## 未決定のまま扱う事項

SIDERA通信方式、コネクター詳細、ハーネスインデックスの評価方法、最終配置先、新規リポジトリ化、SIDERAとの接続方式、旧Gate 1/2の新しい検査契約などは、ユーザーの決定を得るまで確定しない。

## 検証状況

分離モジュールと追加テストはブランチに保存済み。実行環境の制約により、この会話の時点ではリポジトリのテストスイートを実行したという記録はない。テスト未実行を実行成功とみなさない。
