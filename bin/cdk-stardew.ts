#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { config } from '../lib/config';
import { StorageStack } from '../lib/storage-stack';
import { ComputeStack } from '../lib/compute-stack';
import { SchedulerStack } from '../lib/scheduler-stack';

const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: config.region,
};

/**
 * 1. StorageStack — 永続リソース（EBS / S3）。他スタックから独立。
 *    RemovalPolicy.RETAIN で保護。誤 destroy の影響を受けにくくする。
 */
const storage = new StorageStack(app, 'StardewStorageStack', {
  env,
  config,
  description: 'Stardew: 永続ストレージ (EBS / S3)。RETAIN 保護対象。',
});

/**
 * 2. ComputeStack — Launch Template / IAM / Security Group。
 */
const compute = new ComputeStack(app, 'StardewComputeStack', {
  env,
  config,
  dataVolume: storage.dataVolume,
  saveBucket: storage.saveBucket,
  description: 'Stardew: 実行基盤 (Launch Template / IAM / SG)。',
});

/**
 * 3. SchedulerStack — EventBridge Scheduler + Lambda（起動/停止/バックアップ）。
 */
new SchedulerStack(app, 'StardewSchedulerStack', {
  env,
  config,
  launchTemplate: compute.launchTemplate,
  saveBucket: storage.saveBucket,
  description: 'Stardew: スケジューラ (EventBridge / Lambda)。',
});

app.synth();
