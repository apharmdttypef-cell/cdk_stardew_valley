# cdk-stardew

Stardew Valley（Steam版）のマルチプレイ用**デディケートサーバー**を AWS 上に
AWS CDK v2 (TypeScript) で構築するプロジェクト。公式にデディケートサーバー機能が
無いため、**SMAPI + Dedicated Server 系 MOD** でヘッドレス運用する。

- 要件: [`requirements.md`](./requirements.md)
- steering file: [`CLAUDE.md`](./CLAUDE.md)

## アーキテクチャ概要

```
EventBridge Scheduler (JST)          Route53
  22:00 ─▶ StartServer Lambda ─┐   stardew.valheim-one.click (A, UPSERT)
  25:55 ─▶ Backup Lambda ───┐  │                ▲
  26:00 ─▶ StopServer Lambda│  │                │ (起動時に systemd が更新)
                            │  ▼                │
                     ┌──────┴──────────────────┴───────┐
                     │  EC2 Spot (t4g.small / AL2023)   │
                     │  SteamCMD→Stardew→SMAPI→MOD       │
                     │  systemd: install/server/backup  │
                     └───┬───────────────────────┬──────┘
                attach   │                        │ sync (saves only)
                     ┌───▼────┐              ┌─────▼──────────────┐
                     │  EBS   │ (RETAIN)     │ S3 stardew-saves-* │ (RETAIN)
                     │ 永続    │              │  バックアップ        │
                     └────────┘              └────────────────────┘
```

## スタック

| スタック | 内容 |
|---------|------|
| `StardewStorageStack` | EBS Volume / S3 Bucket（永続・`RETAIN` 保護） |
| `StardewComputeStack` | Launch Template / IAM Role / Security Group / user-data |
| `StardewSchedulerStack` | EventBridge Scheduler / Start・Stop・Backup Lambda |

## セットアップ

```bash
npm install
npm run build
npx cdk synth
npx cdk deploy StardewStorageStack     # 最初に永続リソース
npx cdk deploy StardewComputeStack
npx cdk deploy StardewSchedulerStack
```

> ⚠️ `cdk destroy` 時は Storage スタックを巻き込まないこと。EBS / S3 は `RETAIN` 保護済み。

## デプロイ前に確定が必要な事項

`requirements.md` §6 を参照。特に **Steam のヘッドレス認証（Steam Guard/2FA）** は
デプロイ前に方式を確定し、クレデンシャルを Secrets Manager（`stardew/steam`）へ登録すること。

| 論点 | 対応 |
|------|------|
| Steam Guard / 2FA | Secrets Manager + `steamguard-cli`（§6.1） |
| ARM64 で SMAPI 動作可否 | NG なら `config.ts` の `architecture` を `x86_64` に（§6.2） |
| Dedicated Server MOD | 最新の動作要件・入手方法を確定（§6.3） |
| セーブパス / 接続ポート | 実機で確定（§6.4 / §6.5） |
