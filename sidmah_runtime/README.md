# SIDMAH Runtime

SIDMAHのCell、Runtime、Assignment配送と状態を管理する。Node.js 24以降を使用し、外部依存は持たない。Worker LLM sessionの起動はDirectorが行い、Managerは状態とclaimを管理する。

- MCP起動: `node --experimental-strip-types src/mcp/server.ts ..`
- provider通知: `node --experimental-strip-types src/provider/events.ts <root> <delivery-started|session-ended> <id> [value]`
- 状態export: `node --experimental-strip-types src/maintenance/state-export.ts .. <destination>`
- Project MCP設定確認（Codex／OpenCode）: `node --experimental-strip-types src/maintenance/mcp-config-sync.ts .. check`
- Project MCP設定同期（Codex／OpenCode）: `node --experimental-strip-types src/maintenance/mcp-config-sync.ts .. apply`

各コマンドは`sidmah_runtime/`から実行する。`..`はSIDMAHのproject rootを指す。MCP設定同期はproject rootの`.codex/config.toml`内の`[mcp_servers.sidmah]`と`opencode.json`内の`mcp.sidmah`だけを対象とし、その他の設定は保持する。どちらも相対パスと`cwd = "."`でproject rootを基準にMCPサーバーを起動する。プロジェクトを複製・移動しても再同期は不要。クライアントがproject rootを作業ディレクトリとして認識している必要がある。古い`~/.codex/config.toml`の絶対パス指定は自動削除しない。`SIDMAH_CODEX_CONFIG`による別の設定ファイルの明示指定は維持する。OpenCodeの`timeout`はMCPの起動・ツール一覧取得用であり、Codexの`tool_timeout_sec`と同一の設定ではない。設定を変更する前に`director_skill/SKILL.md`に従い、変更予定を提示してユーザーの同意を得る。設定変更後は利用中のMCPクライアントを再起動する。

project rootの`mcp-config.json`がMCP設定の入力である。`worker-model.json`の`model`と`reasoning_effort`をCell Assignment作成時に読み、Directorへ`workerModel`と`reasoningEffort`として返す。WorkerのEnd Assignmentには出力の確認内容と方法を`outputAudit`として含める。

既定providerは`collaboration`方式でStart、Result、Endを`state/provider-outbox/delivery/`へ保存する。Directorは`create_start_assignment`の返す通知と`get_pending_deliveries`を使い、内部サブエージェントのWorkerへ専用の`followup_task`で通知する。保存やpollだけでは処理開始にならず、対応するMCP tool callの受信で確定する。独立したCodex通常チャット向けの旧queue方式はproject rootの`provider-config.json`に`{"mode":"codex-queue"}`を指定した場合だけ使う。内部サブエージェントに旧方式を使わない。設定変更はMCP再起動後に反映する。詳細は`docs/provider-contract.md`を参照する。

MCP tool callの`_meta.threadId`をcaller identityの入口としてManager DBから内部sessionを解決する。MCPのinitialize、ping、tools/listではcaller identityを要求しない。Manager初期化とrecoveryはtool call時まで遅延する。

SQLiteとmachine logはproject rootの`state/`、Cellの作業物、Snapshot、Resultは`works/`へ実行時に生成する。これらは初期配置に含めない。稼働中のSQLiteを保全するときはstate export経路を使用する。

## Integrated SQLite / SQL RAG

派生データベース`state/integrated.sqlite`には既存のCell/Runtime DB、Query履歴、および`result.json`が統合されます。外部CSVやSnapshotなどの生データは統合しません。

MCP `register_query`でQuery全文を保存します。新規なら`queryNo`を省略し、改訂なら既存の番号を指定します。再試行には同じ`operationKey`を使用し、各RuntimeのQuery RevisionはStart時点で固定されます。

v2.0.1では、登録済みのQuery番号・RevisionをRuntime DBの`query_context`に保持し、StartとそのQueryの対応を同じトランザクションで`runtime_queries`に保存します。既存テーブルの定義は変更しません。統合DBの一時障害でStartを取り消さず、復旧後の同期で対応を反映します。v2.0.0の既存Runtimeの対応付けは起動時に移行します。Queryの新規登録・改訂には統合DBが必要です。

MCP `list_integrated_sessions`で現在のDBと`shared_databases/`にユーザーが配置した外部SQLiteを一覧化できます。DB内のセッションUUIDを指定して`query_integrated_sql`で読み取り専用SQLを実行します。`search_fts`はQuery・Start・End・result.jsonを対象とするFTS5索引です。外部セッションのファイルパスは有効な参照先ではありません。稼働中のDBを共有する場合はSQLiteの整合性のあるバックアップを配置してください。

`search_fts MATCH ?`または`search_fts.content MATCH ?`に単独の1〜2文字の文字・数字を渡した場合は、trigram索引が扱えないためSQL実行時に部分一致へ切り替えます（例: `収束`、`酢酸`）。SQL文字列中の検索語にも対応します。FTSの複合式内に短い語を含める場合や、列の別名・式を使う場合は、`content LIKE ?`へ`%収束%`を渡す形で条件を組み立てます。検索の実行時間・出力量制限は共通です。

分離した実行用プロセスもCOMMIT後に同期し、正常終了時は予約済みの同期を実行してからDBを閉じます。状態exportには`integrated.sqlite`も含みます。

Node.js 24.10以上が必要です。各MCPクライアントが`node`をPATHから起動できる環境を用意してください。Embeddingモデルとベクトル検索拡張は使用しません。
