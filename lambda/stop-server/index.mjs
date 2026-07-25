import {
  EC2Client,
  DescribeInstancesCommand,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';

const ec2 = new EC2Client({});

/**
 * 26:00 (翌 2:00) JST: 稼働中の Stardew サーバーインスタンスを終了する。
 * データは永続 EBS / S3 バックアップにあるため terminate してよい。
 */
export const handler = async () => {
  const tag = process.env.SERVER_TAG ?? 'stardew-server';

  const found = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: 'tag:Name', Values: [tag] },
        { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] },
      ],
    }),
  );

  const ids = (found.Reservations ?? [])
    .flatMap((r) => r.Instances ?? [])
    .map((i) => i.InstanceId)
    .filter(Boolean);

  if (ids.length === 0) {
    console.log('No running Stardew instances found.');
    return { terminated: [] };
  }

  await ec2.send(new TerminateInstancesCommand({ InstanceIds: ids }));
  console.log(`Terminated: ${ids.join(', ')}`);
  return { terminated: ids };
};
