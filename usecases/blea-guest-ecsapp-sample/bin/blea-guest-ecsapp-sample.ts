import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { devParameter } from '../parameter';
import { BLEAEcsAppSampleStack } from '../lib/stack/blea-guest-ecsapp-sample-stack';
import { BLEAEcsFrontendSampleStack } from '../lib/stack/blea-guest-ecsapp-frontend-stack';
import { BLEAEcsAppMonitoringSampleStack } from '../lib/stack/blea-guest-ecsapp-monitoring-stack';

const app = new App();

const ecsapp = new BLEAEcsAppSampleStack(app, 'BLEAEcsAppSampleDev', {
  // from parameter.ts
  monitoringNotifyEmail: devParameter.monitoringNotifyEmail,
  monitoringSlackWorkspaceId: devParameter.monitoringSlackWorkspaceId,
  monitoringSlackChannelId: devParameter.monitoringSlackChannelId,
  vpcCidr: devParameter.vpcCidr,
  hostedZoneId: devParameter.hostedZoneId,
  domainName: devParameter.domainName,
  albHostName: devParameter.albHostName,

  // props of cdk.Stack
  tags: {
    Repository: 'aws-samples/baseline-environment-on-aws',
    Environment: devParameter.envName,
  },
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  crossRegionReferences: true,
});

const frontend = new BLEAEcsFrontendSampleStack(app, 'BLEAEcsFrontendSampleDev', {
  // from parameter.ts
  hostedZoneId: devParameter.hostedZoneId,
  domainName: devParameter.domainName,
  albHostName: devParameter.albHostName,
  cloudFrontHostName: devParameter.cloudFrontHostName,

  // from EcsApp stack
  alarmTopic: ecsapp.alarmTopic,

  // props of cdk.Stack
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  crossRegionReferences: true,
});

new BLEAEcsAppMonitoringSampleStack(app, 'BLEAEcsMonitoringSampleDev', {
  // from parameter.ts
  appEndpoint: `${devParameter.cloudFrontHostName}.${devParameter.domainName}`,
  dashboardName: devParameter.dashboardName,

  // from EcsApp stack
  alarmTopic: ecsapp.alarmTopic,
  albFullName: ecsapp.albFullName,
  albTargetGroupName: ecsapp.albTargetGroupName,
  albTargetGroupUnhealthyHostCountAlarm: ecsapp.albTargetGroupUnhealthyHostCountAlarm,
  ecsClusterName: ecsapp.ecsClusterName,
  ecsServiceName: ecsapp.ecsServiceName,
  ecsScaleOnRequestCount: ecsapp.ecsScaleOnRequestCount,
  ecsTargetUtilizationPercent: ecsapp.ecsTargetUtilizationPercent,
  dbClusterName: ecsapp.dbClusterName,

  // from Frontend stack
  distributionId: frontend.distributionId,

  // props of cdk.Stack
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  crossRegionReferences: true,
});
