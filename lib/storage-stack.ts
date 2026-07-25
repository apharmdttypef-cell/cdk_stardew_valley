import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { StardewConfig } from './config';

export interface StorageStackProps extends cdk.StackProps {
  readonly config: StardewConfig;
}

/**
 * 永続リソースを保持するスタック。
 *
 * ⚠️ EBS ボリューム・S3 バケットは絶対に cdk destroy で消えてはならない。
 *    RemovalPolicy.RETAIN を必ず設定する（CLAUDE.md / requirements.md §2.2, §2.5）。
 *
 * 他スタックから独立させ、誤操作の影響範囲を最小化する。
 */
export class StorageStack extends cdk.Stack {
  public readonly dataVolume: ec2.CfnVolume;
  public readonly saveBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);
    const { config } = props;

    // --- データ用 EBS ボリューム（ゲーム本体 / MOD / セーブ） ---------------
    // インスタンスのライフサイクルと切り離して永続化。起動時にアタッチする。
    // AZ 固定: EBS は単一 AZ のため、インスタンスも同 AZ に配置する必要がある。
    this.dataVolume = new ec2.CfnVolume(this, 'DataVolume', {
      availabilityZone: config.availabilityZone,
      size: config.dataVolumeSizeGiB,
      volumeType: 'gp3',
      encrypted: true,
      tags: [
        { key: 'Name', value: 'stardew-data' },
        { key: 'Project', value: 'cdk-stardew' },
      ],
    });

    // 誤削除保護（最重要）。スタック削除・置換時も保持する。
    this.dataVolume.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN, {
      applyToUpdateReplacePolicy: true,
    });

    // --- セーブデータ用 S3 バケット ----------------------------------------
    // 命名: stardew-saves-<ACCOUNT_ID>（アカウント ID を含む一意名）。
    this.saveBucket = new s3.Bucket(this, 'SaveBucket', {
      bucketName: `stardew-saves-${cdk.Stack.of(this).account}`,
      versioned: true, // 誤上書き対策
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // Glacier 等への自動移行は不要（頻繁参照するバックアップ）。Standard のまま。
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // --- Outputs -----------------------------------------------------------
    new cdk.CfnOutput(this, 'DataVolumeId', {
      value: this.dataVolume.ref,
      description: 'Stardew データ用 EBS ボリューム ID',
      exportName: 'StardewDataVolumeId',
    });
    new cdk.CfnOutput(this, 'SaveBucketName', {
      value: this.saveBucket.bucketName,
      description: 'Stardew セーブデータ用 S3 バケット名',
      exportName: 'StardewSaveBucketName',
    });
  }
}
