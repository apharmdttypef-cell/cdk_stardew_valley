# CLAUDE.md — cdk-stardew steering file

このファイルは Claude Code がこのリポジトリで作業する際の指針（steering file）です。
Valheim / Palworld プロジェクトと同様の形式で、プロジェクトの前提・規約・注意点をまとめます。

---

## プロジェクト概要

Stardew Valley（Steam版）のマルチプレイ用デディケートサーバーを AWS 上に
AWS CDK v2 (TypeScript) で構築する。公式にデディケートサーバー機能が無いため、
**SMAPI + Dedicated Server 系 MOD** でヘッドレス運用する。

- 詳細な要件は [`requirements.md`](./requirements.md) を参照（唯一の要件ソース）。
- 既存の `cdk-valheim` の運用パターンを踏襲する。

---

## 技術スタック

| 項目 | 値 |
|------|----|
| IaC | AWS CDK v2 (TypeScript) |
| Node | 20.x 以上 |
| リージョン | `ap-northeast-1` |
| デプロイ単位 | 複数スタック（Storage / Compute / Scheduler） |

---

## リポジトリ構成

```
cdk-stardew/
├── bin/
│   └── cdk-stardew.ts        # CDK アプリのエントリポイント
├── lib/
│   ├── storage-stack.ts      # EBS / S3（永続リソース）
│   ├── compute-stack.ts      # Launch Template / IAM / SG
│   ├── scheduler-stack.ts    # EventBridge Scheduler / Lambda
│   └── config.ts             # 環境固定値（Hosted Zone ID 等）
├── lambda/
│   ├── start-server/         # 22:00 起動
│   ├── stop-server/          # 26:00 停止
│   └── backup/               # 25:55 バックアップトリガー
├── assets/
│   ├── user-data.sh          # EC2 起動スクリプト
│   └── systemd/              # systemd unit ファイル群
├── requirements.md
├── CLAUDE.md
├── cdk.json
├── package.json
└── tsconfig.json
```

---

## 重要な規約・注意点（MUST）

### 永続リソースの保護
- **EBS ボリューム / S3 バケットは絶対に `cdk destroy` で消えてはならない。**
  - `RemovalPolicy.RETAIN` を必ず設定する。
  - CloudFormation の `DeletionPolicy: Retain` / `UpdateReplacePolicy: Retain` 相当を確認する。
- StorageStack は他スタックから独立させ、誤操作の影響範囲を最小化する。
- 過去に Valheim で `cdk destroy` により手動作成リソースを誤削除した事故がある。**破壊的操作は常に慎重に。**

### IAM は最小権限
- インスタンスロールは「対象 EBS のアタッチ/デタッチ」「対象 S3 の読み書き」「対象 Route53 ホストゾーンの UPSERT」に限定。
- ワイルドカード `*` リソースは避け、可能な限り ARN で限定する。

### シークレットの扱い
- Steam クレデンシャル / 2FA シークレットは **Secrets Manager** に格納。
- user-data・リポジトリ・ログに平文で出力しない。

### タイムゾーン
- スケジュールは JST 基準。EventBridge Scheduler の `timezone` に `Asia/Tokyo` を指定し、cron を JST で直接記述する。
- 稼働時間: 22:00〜翌 2:00 JST。

### AZ 制約
- EBS は単一 AZ 固定。スポットインスタンスも同一 AZ に配置すること。

---

## よく使うコマンド

```bash
npm install            # 依存インストール
npm run build          # TypeScript ビルド
npx cdk synth          # CloudFormation テンプレート生成
npx cdk diff           # 差分確認
npx cdk deploy --all   # 全スタックデプロイ

# 個別デプロイ（Storage は独立して安定運用）
npx cdk deploy StardewStorageStack
npx cdk deploy StardewComputeStack
npx cdk deploy StardewSchedulerStack
```

> ⚠️ `cdk destroy` を実行する場合は、対象スタックを明示し、Storage スタックを巻き込まないこと。

---

## 環境固定値

| キー | 値 |
|------|----|
| Hosted Zone (name) | `valheim-one.click` |
| Hosted Zone ID | `Z08886551UA8ZDKXGFXG0` |
| サブドメイン | `stardew.valheim-one.click` |
| リージョン | `ap-northeast-1` |
| S3 バケット名 | `stardew-saves-<ACCOUNT_ID>` |

（値は `lib/config.ts` に集約する。）

---

## 未解決の設計判断（実装時に確認）

`requirements.md` §6 を参照。特に:
1. **Steam ヘッドレス認証（Steam Guard / 2FA）** — 最重要。
2. ARM64 (t4g) での SMAPI 動作可否 → ダメなら x86_64 (t3.small)。
3. Dedicated Server 系 MOD の最新動作要件。
4. セーブデータパス・接続ポートの実機確認。

これらは未確定のまま実装を進める場合、コード内に `// TODO(design):` コメントで明示し、
仮の値・切替可能なパラメータとして実装すること。
