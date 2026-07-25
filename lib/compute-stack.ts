import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as fs from 'fs';
import * as path from 'path';
import { StardewConfig } from './config';

export interface ComputeStackProps extends cdk.StackProps {
  readonly config: StardewConfig;
  readonly dataVolume: ec2.CfnVolume;
  readonly saveBucket: s3.Bucket;
}

/**
 * 実行基盤スタック。
 * - Launch Template（スポット指定・user-data 埋め込み）
 * - インスタンスロール（最小権限: EBS attach/detach, S3 R/W, Route53 UPSERT）
 * - セキュリティグループ（ゲームポートのみ開放、SSH は開けず SSM 保守）
 */
export class ComputeStack extends cdk.Stack {
  public readonly launchTemplate: ec2.LaunchTemplate;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);
    const { config, dataVolume, saveBucket } = props;

    // デフォルト VPC を利用（Valheim 運用踏襲。専用 VPC が必要なら差し替え）。
    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });

    // --- IAM ロール（最小権限） --------------------------------------------
    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Stardew EC2 instance role (least privilege)',
    });

    // SSM Session Manager 保守（SSH ポートを開けないため）
    role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
    );

    // 対象 EBS ボリュームの attach/detach のみ（リソース ARN で限定）
    const volumeArn = cdk.Stack.of(this).formatArn({
      service: 'ec2',
      resource: 'volume',
      resourceName: dataVolume.ref,
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AttachDetachDataVolume',
        actions: ['ec2:AttachVolume', 'ec2:DetachVolume'],
        resources: [
          volumeArn,
          // AttachVolume は instance ARN も必要
          cdk.Stack.of(this).formatArn({
            service: 'ec2',
            resource: 'instance',
            resourceName: '*',
          }),
        ],
      }),
    );
    // DescribeVolumes はリソースレベル権限をサポートしないため * が必要
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DescribeVolumes',
        actions: ['ec2:DescribeVolumes'],
        resources: ['*'],
      }),
    );

    // 対象 S3 バケットの読み書き
    saveBucket.grantReadWrite(role);

    // 対象 Route53 ホストゾーンへの UPSERT のみ
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'Route53Upsert',
        actions: ['route53:ChangeResourceRecordSets'],
        resources: [
          `arn:aws:route53:::hostedzone/${config.hostedZoneId}`,
        ],
      }),
    );
    // GetChange / ListResourceRecordSets（変更確認用）は * が必要
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'Route53Read',
        actions: [
          'route53:GetHostedZone',
          'route53:ListResourceRecordSets',
          'route53:GetChange',
        ],
        resources: ['*'],
      }),
    );

    // --- セキュリティグループ ----------------------------------------------
    const sg = new ec2.SecurityGroup(this, 'ServerSg', {
      vpc,
      description: 'Stardew dedicated server SG',
      allowAllOutbound: true,
    });
    // ゲームポート（要実機確認 §6.5）。デフォルト UDP 24642 を想定。
    sg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.udp(config.gamePort),
      'Stardew game port (UDP)',
    );
    // TODO(design §6.5): Steam P2P に依存する場合、追加ポートをここで開放する。
    // SSH(22) は開けない。保守は SSM Session Manager 経由。

    // --- scripts / systemd units を S3 アセットとして配布 ------------------
    // インスタンスは user-data で download-bundle → /usr/local/bin と
    // /etc/systemd/system に配置する。
    const bundle = new s3assets.Asset(this, 'ServerBundle', {
      path: path.join(__dirname, '..', 'assets'),
      // user-data.sh 自体はバンドルに含めても害はないが除外して混乱を避ける
      exclude: ['user-data.sh'],
    });
    bundle.grantRead(role);

    // --- user-data ---------------------------------------------------------
    const userDataScript = fs.readFileSync(
      path.join(__dirname, '..', 'assets', 'user-data.sh'),
      'utf8',
    );
    const userData = ec2.UserData.custom(
      userDataScript
        .replace(/__DATA_VOLUME_ID__/g, dataVolume.ref)
        .replace(/__SAVE_BUCKET__/g, saveBucket.bucketName)
        .replace(/__HOSTED_ZONE_ID__/g, config.hostedZoneId)
        .replace(/__RECORD_NAME__/g, config.recordName)
        .replace(/__AWS_REGION__/g, config.region)
        .replace(/__GAME_PORT__/g, String(config.gamePort))
        .replace(/__ASSETS_BUCKET__/g, bundle.s3BucketName)
        .replace(/__ASSETS_KEY__/g, bundle.s3ObjectKey),
    );

    // --- マシンイメージ（アーキテクチャに応じた AL2023） -------------------
    const cpuType =
      config.architecture === 'arm64'
        ? ec2.AmazonLinuxCpuType.ARM_64
        : ec2.AmazonLinuxCpuType.X86_64;
    const machineImage = ec2.MachineImage.latestAmazonLinux2023({
      cpuType,
    });

    // --- Launch Template（スポット） --------------------------------------
    this.launchTemplate = new ec2.LaunchTemplate(this, 'ServerLaunchTemplate', {
      launchTemplateName: 'stardew-server',
      instanceType: new ec2.InstanceType(config.instanceType),
      machineImage,
      role,
      securityGroup: sg,
      userData,
      requireImdsv2: true,
      // スポット設定: 中断時は stop ではなく terminate（EBS は別管理で永続）
      spotOptions: {
        requestType: ec2.SpotRequestType.ONE_TIME,
        interruptionBehavior: ec2.SpotInstanceInterruption.TERMINATE,
      },
      // ルートボリューム（OS 用）。データは別 EBS。
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(8, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],
    });

    new cdk.CfnOutput(this, 'LaunchTemplateId', {
      value: this.launchTemplate.launchTemplateId ?? '',
      description: 'Stardew Launch Template ID',
      exportName: 'StardewLaunchTemplateId',
    });
  }
}
