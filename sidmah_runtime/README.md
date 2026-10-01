# SIDMAH Runtime

SIDMAHのCell、Runtime、Assignment配送と状態を管理する。Node.js 24以降を使用し、外部依存は持たない。Worker LLM sessionの起動はDirectorが行い、Managerは状態とclaimを管理する。

- MCP起動: `node --experimental-strip-types src/mcp/server.ts ..`
- provider通知: `node --experimental-strip-types src/provider/events.ts <root> <delivery-started|session-ended> <id> [value]`
- 状態export: `node --experimental-strip-types src/maintenance/state-export.ts .. <destination>`
- Codex MCP設定確認: `node --experimental-strip-types src/maintenance/mcp-config-sync.ts .. check`
- Codex MCP設定同期: `node --experimental-strip-types src/maintenance/mcp-config-sync.ts .. apply`

各コマンドは`sidmah_runtime/`から実行する。`..`はSIDMAHのproject rootを指す。MCP設定同期では現在のルートを解決し、`~/.codex/config.toml`の`[mcp_servers.sidmah]`とその子sectionだけを更新する。設定を変更する前に`director_skill/SKILL.md`に従い、変更予定を提示してユーザーの同意を得る。設定変更後はCodexを再起動する。

project rootの`mcp-config.json`がMCP設定の入力である。`worker-model.json`の`model`と`reasoning_effort`をCell Assignment作成時に読み、Directorへ`workerModel`と`reasoningEffort`として返す。WorkerのEnd Assignmentには出力の確認内容と方法を`outputAudit`として含める。

既定providerは`collaboration`方式でStart、Result、Endを`state/provider-outbox/delivery/`へ保存する。Directorは`create_start_assignment`の返す通知と`get_pending_deliveries`を使い、内部サブエージェントのWorkerへ専用の`followup_task`で通知する。保存やpollだけでは処理開始にならず、対応するMCP tool callの受信で確定する。独立した通常チャット向けの旧queue方式はproject rootの`provider-config.json`に`{"mode":"codex-queue"}`を指定した場合だけ使う。内部サブエージェントに旧方式を使わない。設定変更はMCP再起動後に反映する。詳細は`docs/provider-contract.md`を参照する。

MCP tool callの`_meta.threadId`をcaller identityの入口としてManager DBから内部sessionを解決する。MCPのinitialize、ping、tools/listではcaller identityを要求しない。Manager初期化とrecoveryはtool call時まで遅延する。

SQLiteとmachine logはproject rootの`state/`、Cellの作業物、Snapshot、Resultは`works/`へ実行時に生成する。これらは初期配置に含めない。稼働中のSQLiteを保全するときはstate export経路を使用する。
