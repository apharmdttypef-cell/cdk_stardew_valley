import {
  EC2Client,
  DescribeInstancesCommand,
} from '@aws-sdk/client-ec2';
import { SSMClient, SendCommandCommand } from '@aws-sdk/client-ssm';

const ec2 = new EC2Client({});
const ssm = new SSMClient({});

/**
 * 25:55 (翌 1:55) JST: 停止直前にセーブデータを S3 へ sync する。
 * SSM RunCommand で稼働中インスタンス上の backup サービスを実行する。
 * （インスタンス内 systemd timer でも同等の処理を持たせる二重化を推奨）
 */
export const handler = async () => {
  const tag = process.env.SERVER_TAG ?? 'stardew-server';
  const bucket = process.env.SAVE_BUCKET;

  const found = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: 'tag:Name', Values: [tag] },
        { Name: 'instance-state-name', Values: ['running'] },
      ],
    }),
  );

  const ids = (found.Reservations ?? [])
    .flatMap((r) => r.Instances ?? [])
    .map((i) => i.InstanceId)
    .filter(Boolean);

  if (ids.length === 0) {
    console.log('No running Stardew instances to back up.');
    return { backedUp: [] };
  }

  // セーブデータパスは実環境で要確認（§6.4）。
  await ssm.send(
    new SendCommandCommand({
      InstanceIds: ids,
      DocumentName: 'AWS-RunShellScript',
      Comment: 'Stardew save backup to S3',
      Parameters: {
        commands: [
          'set -euo pipefail',
          'SAVE_DIR="/mnt/stardew/home/.config/StardewValley/Saves"',
          `aws s3 sync "$SAVE_DIR" "s3://${bucket}/saves/" --delete`,
        ],
      },
    }),
  );

  console.log(`Backup command sent to: ${ids.join(', ')}`);
  return { backedUp: ids };
};
