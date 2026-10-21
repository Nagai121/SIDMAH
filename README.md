# SIDMAH

現在のバージョン: **v2.0.2**
SIDMAHは、ユーザーから与えられた目的に基づいて計算実験を構築・実行・監査するためのマルチエージェント・ハーネスです。

## Setup

```bash
git clone https://github.com/Nagai121/SIDMAH.git
cd SIDMAH
```

Node.js 24.10以降をインストールし、`node`がPATHから呼び出せる状態にします。SIDMAHのproject rootをCodexまたはOpenCodeで開きます。

MCP設定はproject rootの`.codex/config.toml`（Codex）と`opencode.json`（OpenCode）に同梱されています。いずれも絶対パスを含まず、開いているproject rootを作業ディレクトリとして使用します。Codexではprojectを信頼済みにする必要があります。ユーザー共通の旧MCP設定が残る場合は、そちらが古いSIDMAHを指していないか確認してください。

## Usage

通常の自然言語で実験目的、クエリを入力します。

```text
このSimulatorを使用して、〜について調べてください。
```

初回起動時にSIDMAHがMCP設定とWorkerモデルを確認します。MCP設定の変更が必要な場合のみ確認を求め、変更後は使用中のMCPクライアントを再起動して同じproject rootから再開します。Codex／OpenCode側がMCPプロセスの作業ディレクトリを別の場所に設定していると、相対パスでの起動は失敗します。

このとき、あらかじめ対象となるSimulatorを `simulator/` に配置していても良いし、もしくは存在しなかったらクエリをもとにSIDMAHがsimulator をセットアップします。

```text
SIDMAH/
└── simulator/
    ├── SIMULATOR_PLACEMENT.md
    └── <Simulator>
```

## Workflow

基本的な実験フローは以下の通りです。

```text
Query理解/Simulator理解
↓
Field Control
↓
本番実験
↓
結果評価
↓
Queryごとの成果物をquery_outputs/へ保存
```

Field Controlでは、本番実験へ進む前に実験系が成立していることを確認します。

## Execution

SIDMAHでは、1つのWorkerが1つのWork Cellを担当し、各Cellから複数のRuntimeを使用できます。

## Structure

```text
SIDMAH/
├── AGENTS.md
├── .codex/config.toml
├── opencode.json
├── mcp-config.json
├── worker-model.json
│
├── assignment_schema/
│   ├── cell.schema.json
│   ├── start.schema.json
│   └── end.schema.json
│
├── director_skill/
│   ├── SKILL.md
│   ├── references/
│   │   ├── director.md
│   │   ├── director-succession.md
│   │   ├── query-understanding.md
│   │   └── sim-understanding.md
│   └── fieldcontrol/
│       ├── fieldcontrol.md
│       ├── system_fc.md
│       ├── experiment_fc.md
│       └── gate3_record/
│           └── gate3-record-schema.md
│
├── worker_skill/
│   ├── SKILL.md
│   ├── worker.md
│   ├── experiment.md
│   ├── experiment-schema.json
│   └── summary/
│       └── summary-schema.md
│
├── query_outputs/
│   └── outputs_schema.md
│
├── sidmah_runtime/
│   ├── package.json
│   ├── README.md
│   ├── docs/
│   ├── src/
│   └── test/
│
├── simulator/
│   └── SIMULATOR_PLACEMENT.md
│
└── test/
    └── TEST_PLACEMENT.md
```

- Workerのデフォルトモデルは `worker-model.json` で指定します。
- Worker同士は原則として直接通信せず、Directorによる割り当てを通じて作業します。
