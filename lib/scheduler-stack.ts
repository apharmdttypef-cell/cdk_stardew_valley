import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as path from 'path';
import { StardewConfig } from './config';

export interface SchedulerStackProps extends cdk.StackProps {
  readonly config: StardewConfig;
  readonly launchTemplate: ec2.LaunchTemplate;
  readonly saveBucket: s3.Bucket;
}

/**
 * 自動起動 / 停止 / バックアップ。
 * EventBridge Scheduler（timezone=Asia/Tokyo）→ Lambda。
 *
 *  22:00 JST  StartServer  : Launch Template からスポットインスタンスを起動
 *  25:55 JST  Backup       : SSM 経由で稼働中インスタンスにバックアップ実行
 *  26:00 JST  StopServer   : 稼働中インスタンスを終了
 */
export class SchedulerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SchedulerStackProps) {
    super(scope, id, props);
    const { config, launchTemplate, saveBucket } = props;

    const commonEnv = {
      LAUNCH_TEMPLATE_ID: launchTemplate.launchTemplateId ?? '',
      AVAILABILITY_ZONE: config.availabilityZone,
      SERVER_TAG: 'stardew-server',
      SAVE_BUCKET: saveBucket.bucketName,
    };

    // --- StartServer Lambda ------------------------------------------------
    const startFn = new lambda.Function(this, 'StartServerFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'start-server')),
      timeout: cdk.Duration.minutes(2),
      environment: commonEnv,
    });
    startFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ec2:RunInstances', 'ec2:CreateTags'],
        resources: ['*'],
      }),
    );
    // RunInstances でインスタンスロールを渡すため PassRole が必要
    startFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' },
        },
      }),
    );

    // --- StopServer Lambda -------------------------------------------------
    const stopFn = new lambda.Function(this, 'StopServerFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'stop-server')),
      timeout: cdk.Duration.minutes(2),
      environment: commonEnv,
    });
    stopFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ec2:DescribeInstances', 'ec2:TerminateInstances'],
        resources: ['*'],
      }),
    );

    // --- Backup Lambda（SSM SendCommand でインスタンス内バックアップを実行）-
    const backupFn = new lambda.Function(this, 'BackupFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'backup')),
      timeout: cdk.Duration.minutes(2),
      environment: commonEnv,
    });
    backupFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ec2:DescribeInstances', 'ssm:SendCommand'],
        resources: ['*'],
      }),
    );

    // --- EventBridge Scheduler ---------------------------------------------
    // Scheduler が各 Lambda を呼び出すためのロール
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    for (const fn of [startFn, stopFn, backupFn]) {
      fn.grantInvoke(new iam.ServicePrincipal('scheduler.amazonaws.com'));
      schedulerRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [fn.functionArn],
        }),
      );
    }

    const mkSchedule = (
      idSuffix: string,
      cron: string,
      fnArn: string,
    ): scheduler.CfnSchedule =>
      new scheduler.CfnSchedule(this, `Schedule${idSuffix}`, {
        flexibleTimeWindow: { mode: 'OFF' },
        scheduleExpression: cron,
        scheduleExpressionTimezone: config.schedule.timezone,
        target: {
          arn: fnArn,
          roleArn: schedulerRole.roleArn,
        },
      });

    mkSchedule('Start', config.schedule.startCron, startFn.functionArn);
    mkSchedule('Backup', config.schedule.backupCron, backupFn.functionArn);
    mkSchedule('Stop', config.schedule.stopCron, stopFn.functionArn);
  }
}
