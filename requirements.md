# Stardew Valley Dedicated Server — 要件定義 (requirements.md)

## 1. 目的・背景

Stardew Valley（Steam版）のマルチプレイ用デディケートサーバーを AWS 上に構築する。
公式にはデディケートサーバー機能が存在しないため、**SMAPI + Dedicated Server 系 MOD** を用いてヘッドレス運用する。

既存プロジェクト `cdk-valheim` の運用パターンを踏襲し、TypeScript CDK (AWS CDK v2) で新規プロジェクト `cdk-stardew` を構築する。

### 前提

| 項目 | 値 |
|------|----|
| プロジェクト名 | `cdk-stardew` |
| 言語 | TypeScript (AWS CDK v2) |
| リージョン | `ap-northeast-1` |
| 想定同時接続 | 最大 4 人（Stardew Valley のマルチプレイ上限） |

---

## 2. アーキテクチャ要件

### 2.1 コンピュート (EC2)

- **EC2 スポットインスタンス**で運用（コスト最適化）。
- インスタンスタイプ: **`t4g.small`** (Graviton / ARM64) を第一候補とする。
  - 2 vCPU / 2 GiB RAM。Stardew Valley のサーバー用途としては十分な見込み。
- AMI: **Amazon Linux 2023 (ARM64)**。
  - ⚠️ SMAPI/Mono/.NET の ARM64 動作要件を要検証。動作しない場合は **x86_64 (`t3.small`) へフォールバック**する設計余地を残す（`instanceType` / `machineImage` / `architecture` をパラメータ化）。
- 起動時に以下を **user-data → systemd サービス**で自動化:
  1. EBS ボリュームのアタッチ・マウント
  2. SteamCMD による Stardew Valley 本体のインストール（未導入時のみ）
  3. SMAPI の導入
  4. Dedicated Server 系 MOD の導入
  5. Route53 DNS レコードの更新
  6. ゲームサーバープロセス（SMAPI ヘッドレス）の起動

### 2.2 ストレージ (EBS)

- ワールドデータ（セーブファイル・MOD・ゲーム本体）は **EBS ボリューム**に永続化。
- インスタンスはスポットで都度作成・破棄する前提だが、**EBS はインスタンスのライフサイクルと切り離して永続化**し、起動時にアタッチする。
- **誤削除保護を必須とする**（Valheim 運用時に `cdk destroy` で手動作成リソースを誤削除した反省）。
  - `RemovalPolicy.RETAIN` を設定。
  - CloudFormation の `DeletionPolicy: Retain` / `UpdateReplacePolicy: Retain` 相当。
- ボリュームサイズ: 20 GiB (gp3) を初期値とする（ゲーム本体 ~1GB + MOD + セーブで十分な余裕）。
- AZ 固定: EBS は単一 AZ に固定されるため、スポットインスタンスも同一 AZ に配置する必要がある（設計上の制約として明記）。

### 2.3 起動・停止スケジュール

- 稼働時間: **22:00〜翌 2:00 (26:00) JST のみ**。
- **EventBridge Scheduler (cron)** で以下をトリガー（すべて Lambda 経由）:

| 時刻 (JST) | 処理 | 実装 |
|-----------|------|------|
| 22:00 | スポットインスタンスのリクエスト・起動 | StartServer Lambda |
| 25:55 (翌 1:55) | S3 バックアップトリガー（停止前） | Backup Lambda（またはインスタンス内 cron/systemd timer） |
| 26:00 (翌 2:00) | インスタンス停止 / 終了処理 | StopServer Lambda |

- **スポット中断（中断通知）対応**:
  - EBS は永続なので中断されてもデータ消失しない前提を明記。
  - 中断通知（2 分前）を受けてセーブ→S3 バックアップを試みる（best-effort）。
  - 中断後に稼働時間帯であれば再リクエストを試みる方針（設計判断としてリストアップ）。
- スケジューラのタイムゾーン: EventBridge Scheduler の `timezone` に `Asia/Tokyo` を指定（cron を JST で直接記述）。

### 2.4 DNS 自動更新 (Route53)

- Valheim と同方式: インスタンス起動時に systemd サービスが EC2 のパブリック IP を取得し、Route53 レコードを **UPSERT** で更新。
- 既存 Hosted Zone を利用:
  - Zone: `valheim-one.click`
  - Hosted Zone ID: `Z08886551UA8ZDKXGFXG0`
- サブドメイン: **`stardew.valheim-one.click`**（新規）。
- レコード: A レコード、TTL 60 秒。
- IAM 権限は **該当ホストゾーンへの UPSERT のみ**に最小化。

### 2.5 S3 バックアップ（セーブデータのみ）

- バックアップ対象は **セーブデータのみ**（ゲーム本体・MOD バイナリは対象外）。
- セーブデータパス（Linux/SMAPI 環境）: `~/.config/StardewValley/Saves/` 配下を想定（実環境で要確認）。
- **新規 S3 バケット**を作成。
  - 命名規則は Valheim 運用（`valheim-plugins-385455859924` 等）を参考に、**アカウント ID を含む一意名**とする。例: `stardew-saves-<ACCOUNT_ID>`。
- 停止直前（25:55 JST）に `aws s3 sync` を実行。
- ライフサイクル: **基本 Standard のまま**（Glacier 等への自動移行は不要。頻繁参照するバックアップのため）。
- バージョニング有効化を推奨（誤上書き対策）。
- バケットは永続リソースとして `RemovalPolicy.RETAIN`。

### 2.6 IAM / セキュリティ

- **インスタンスロール**には以下の最小権限のみ付与:
  - 対象 EBS ボリュームの `AttachVolume` / `DetachVolume`（リソース ARN で限定）。
  - 対象 S3 バケットへの読み書き（`GetObject` / `PutObject` / `ListBucket`）。
  - 対象 Route53 ホストゾーンへの `ChangeResourceRecordSets`（UPSERT）。
  - （運用補助）SSM Session Manager 用の `AmazonSSMManagedInstanceCore`（SSH ポートを開けずに保守するため。任意）。
- **セキュリティグループ**はゲームクライアント接続に必要なポートのみ開放。
  - Stardew Valley のデフォルトポート: **UDP 24642**（要確認）。
  - Steam の P2P/LAN Server 機能に依存する場合は追加ポート確認が必要（設計判断としてリストアップ）。
  - SSH (22) は原則開けず、SSM 経由の保守を推奨。

---

## 3. スタック構成

Valheim / Palworld プロジェクトの構成パターンを踏襲し、以下に分割する:

| # | スタック | 責務 | 主要リソース |
|---|---------|------|-------------|
| 1 | **StorageStack** | 永続リソース（他スタックから独立） | EBS Volume, S3 Bucket |
| 2 | **ComputeStack** | 実行基盤 | Launch Template, IAM Role/InstanceProfile, Security Group, VPC 参照 |
| 3 | **SchedulerStack** | 自動起動/停止/バックアップ | EventBridge Scheduler, Lambda (Start/Stop/Backup) |
| 4 | **DnsStack**（または ComputeStack に統合） | Route53 連携 | IAM ポリシー（UPSERT 権限）。レコード自体はインスタンスが動的更新 |

- スタック間参照は CloudFormation Export/Import ではなく、CDK のクロススタック参照（props 渡し）を基本とする。
- StorageStack は最も安定・独立させ、誤 destroy の影響を受けにくくする。

---

## 4. 成果物

1. `requirements.md` — 本ドキュメント（要件精緻化）
2. `CLAUDE.md` — プロジェクトの steering file
3. CDK スタック実装一式（TypeScript）
4. EC2 起動時の user-data / systemd サービス設計
5. 未確定事項・設計判断ポイントのリスト（本ドキュメント §6）

---

## 5. 非機能・運用要件

- **コスト**: 稼働は 1 日約 4 時間のみ。スポット + 短時間稼働で月額を最小化。
- **可用性**: 稼働時間帯のみベストエフォート。スポット中断時はデータ保全を最優先し、再起動は best-effort。
- **保守性**: SSM Session Manager でのアクセスを標準とし、SSH ポートは閉じる。
- **観測性**: 起動/停止/バックアップの各 Lambda・systemd サービスのログを CloudWatch Logs に集約。

---

## 6. 未確定事項・設計判断ポイント（要調査 / 申し送り）

> 実装を進めつつ、以下は設計上の重要論点として個別に判断・検証する。

### 6.1 Steam ライセンス認証（ヘッドレス）— **最重要**
- SteamCMD での Stardew Valley インストールには **ライセンス保有アカウントでのログインが必須**。
- ヘッドレス環境での **Steam Guard / 2FA** 対応が課題。
- 検討案:
  - (a) 事前に対話ログイン済みの Steam `config`（`sentry`/`ssfn` ファイル）を用意し、EBS または Secrets Manager 経由で持ち込む。
  - (b) Steam Guard を無効化した専用アカウント（非推奨・規約リスク）。
  - (c) `steamguard-cli` 等で TOTP を自動生成（shared_secret を Secrets Manager 管理）。
- **クレデンシャルは Secrets Manager に格納**し、user-data には平文で置かない方針を必須とする。

### 6.2 ARM64 (t4g) での SMAPI 動作
- SMAPI は Mono/.NET 前提。ARM64 での動作可否を要検証。
- 動作しない場合は **x86_64 (`t3.small`) へ切替**できるよう、CDK 側で `architecture` をパラメータ化しておく。

### 6.3 Dedicated Server 系 MOD
- 例: Nexus Mods の "Dedicated Server" 系 MOD。
- 最新の動作要件・対応 Stardew/SMAPI バージョンを要確認。
- MOD のダウンロード自動化（Nexus は認証が必要な場合あり）方式を検討。

### 6.4 セーブデータパス
- `~/.config/StardewValley/Saves/` を想定するが、SMAPI/実行ユーザーにより変動しうるため実環境で確定する。

### 6.5 接続ポート
- Stardew のデフォルトポート（UDP 24642 想定）と、Steam P2P 依存の有無を実機で確認しセキュリティグループを確定する。

### 6.6 スポット中断時の再起動戦略
- 稼働時間帯内での自動再リクエストを行うか、その日は諦めるか（コスト vs 可用性）を運用ポリシーとして決定する。
