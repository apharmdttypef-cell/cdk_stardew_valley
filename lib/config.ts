/**
 * 環境固定値の集約。
 * requirements.md / CLAUDE.md の「環境固定値」と対応。
 */

export type Architecture = 'arm64' | 'x86_64';

export interface StardewConfig {
  /** デプロイ先リージョン */
  readonly region: string;
  /**
   * EBS/インスタンスを固定する AZ。
   * EBS は単一 AZ 固定のため、スポットインスタンスも同一 AZ に配置する必要がある。
   */
  readonly availabilityZone: string;

  /** アーキテクチャ。ARM64 で SMAPI が動かない場合は 'x86_64' に切替（§6.2）。 */
  readonly architecture: Architecture;
  /** arm64: t4g.small / x86_64: t3.small */
  readonly instanceType: string;

  /** データ用 EBS ボリュームサイズ (GiB) */
  readonly dataVolumeSizeGiB: number;

  /** Route53 */
  readonly hostedZoneName: string;
  readonly hostedZoneId: string;
  readonly recordName: string;

  /** ゲーム接続ポート（要実機確認 §6.5）。Stardew デフォルト想定 UDP 24642。 */
  readonly gamePort: number;

  /** 稼働スケジュール（JST, EventBridge Scheduler timezone=Asia/Tokyo） */
  readonly schedule: {
    /** 起動 cron（分 時 日 月 曜） */
    readonly startCron: string;
    /** バックアップ cron */
    readonly backupCron: string;
    /** 停止 cron */
    readonly stopCron: string;
    readonly timezone: string;
  };
}

/**
 * アーキテクチャに応じたインスタンスタイプを返す。
 */
function instanceTypeFor(arch: Architecture): string {
  return arch === 'arm64' ? 't4g.small' : 't3.small';
}

// 切替ポイント: ARM64 検証が NG の場合は 'x86_64' に変更するだけでよい。
const ARCHITECTURE: Architecture = 'arm64';

export const config: StardewConfig = {
  region: 'ap-northeast-1',
  availabilityZone: 'ap-northeast-1a',

  architecture: ARCHITECTURE,
  instanceType: instanceTypeFor(ARCHITECTURE),

  dataVolumeSizeGiB: 20,

  hostedZoneName: 'valheim-one.click',
  hostedZoneId: 'Z08886551UA8ZDKXGFXG0',
  recordName: 'stardew.valheim-one.click',

  gamePort: 24642,

  schedule: {
    // 22:00 JST 起動
    startCron: 'cron(0 22 * * ? *)',
    // 25:55 (翌 1:55) JST バックアップ
    backupCron: 'cron(55 1 * * ? *)',
    // 26:00 (翌 2:00) JST 停止
    stopCron: 'cron(0 2 * * ? *)',
    timezone: 'Asia/Tokyo',
  },
};
