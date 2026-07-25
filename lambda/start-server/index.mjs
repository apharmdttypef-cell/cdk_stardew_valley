import { EC2Client, RunInstancesCommand } from '@aws-sdk/client-ec2';

const ec2 = new EC2Client({});

/**
 * 22:00 JST: Launch Template からスポットインスタンスを 1 台起動する。
 * EBS は user-data 側でアタッチするため、ここでは起動のみ。
 * AZ を固定（EBS と同一 AZ である必要がある）。
 */
export const handler = async () => {
  const templateId = process.env.LAUNCH_TEMPLATE_ID;
  const az = process.env.AVAILABILITY_ZONE;
  const tag = process.env.SERVER_TAG ?? 'stardew-server';

  const res = await ec2.send(
    new RunInstancesCommand({
      LaunchTemplate: { LaunchTemplateId: templateId, Version: '$Latest' },
      MinCount: 1,
      MaxCount: 1,
      Placement: { AvailabilityZone: az },
      TagSpecifications: [
        {
          ResourceType: 'instance',
          Tags: [
            { Key: 'Name', Value: tag },
            { Key: 'Project', Value: 'cdk-stardew' },
          ],
        },
      ],
    }),
  );

  const instanceId = res.Instances?.[0]?.InstanceId;
  console.log(`Started instance: ${instanceId}`);
  return { instanceId };
};
