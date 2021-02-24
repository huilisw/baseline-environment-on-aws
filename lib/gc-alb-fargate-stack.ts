import * as cdk from '@aws-cdk/core';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as elbv2 from '@aws-cdk/aws-elasticloadbalancingv2';
import * as s3 from '@aws-cdk/aws-s3';
import * as iam from '@aws-cdk/aws-iam';
import { Duration, Tags, RemovalPolicy, SecretValue } from '@aws-cdk/core';
import * as kms from '@aws-cdk/aws-kms';
import * as ecs_patterns from '@aws-cdk/aws-ecs-patterns';
import * as ecs from '@aws-cdk/aws-ecs';
import * as wafv2 from "@aws-cdk/aws-wafv2";
import * as cloudfront from "@aws-cdk/aws-cloudfront";
import * as origins from "@aws-cdk/aws-cloudfront-origins";
import * as sns from '@aws-cdk/aws-sns';
import * as cw from '@aws-cdk/aws-cloudwatch';
import * as cw_actions from '@aws-cdk/aws-cloudwatch-actions';

export interface GcAlbFargateStackProps extends cdk.StackProps {
  prodVpc: ec2.Vpc,
  environment: string,
  logBucket: s3.Bucket,
  appKey: kms.IKey,
  alarmTopic: sns.Topic,
}

export class GcAlbFargateStack extends cdk.Stack {
  public readonly appServerSecurityGroup: ec2.SecurityGroup;

  constructor(scope: cdk.Construct, id: string, props: GcAlbFargateStackProps) {
    super(scope, id, props);

    // CORS Allowed Domain
    const allowdOrigins = [
      'https://example.com',
      'https://www.example.com'
    ];

    // --- Security Groups ---

    //Security Group of ALB for App
    const securityGroupForAlb = new ec2.SecurityGroup(this, 'SgAlb', {
      vpc: props.prodVpc,
      allowAllOutbound: false,
    });
    securityGroupForAlb.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80));
    securityGroupForAlb.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.allTcp());

 
   // ------------ S3 Bucket for Web Contents ---------------

   const webContentBucket = new s3.Bucket(this, 'WebBucket', {
    accessControl: s3.BucketAccessControl.PRIVATE,
    lifecycleRules: [{
      enabled: true,
      expiration: Duration.days(2555),
      transitions: [{
        storageClass: s3.StorageClass.GLACIER,
        transitionAfter: Duration.days(90),
      }],
    }],
    removalPolicy: RemovalPolicy.DESTROY,
    versioned: false,
    // See Also: Encryption on CloudFront + S3
    //   https://aws.amazon.com/jp/premiumsupport/knowledge-center/s3-rest-api-cloudfront-error-403/
    encryption: s3.BucketEncryption.S3_MANAGED,
    cors: [{
        allowedOrigins: allowdOrigins,
        allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD]
    }],
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL
});

  // Prevent access without SSL
  webContentBucket.addToResourcePolicy(new iam.PolicyStatement({
    effect:     iam.Effect.DENY,
    principals: [ new iam.AnyPrincipal() ],
    actions:    [ 's3:*' ],
    resources:  [ webContentBucket.bucketArn+'/*' ],
    conditions: {
      'Bool' : {
        'aws:SecureTransport': 'false'
      }}
  }));

    // CloudFront Distrubution
    //  with CORS
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(webContentBucket),
        originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN
      }
    });


    // ------------ Application LoadBalancer ---------------

    // S3 Bucket for ALB Logging (Needs SSE-S3)
    // https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-access-logs.html#access-logging-bucket-permissions
    const albLogBucket = new s3.Bucket(this, 'alb-log-bucket', {
      accessControl: s3.BucketAccessControl.PRIVATE,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL        
    });

    // ALB for App Server
    const lbForApp = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.prodVpc,
      internetFacing: true,
      securityGroup: securityGroupForAlb,
      vpcSubnets: props.prodVpc.selectSubnets({
        subnetGroupName: 'Public'
      }),
    });
    lbForApp.logAccessLogs(albLogBucket);
    Tags.of(lbForApp).add('Environment', props.environment);


    // --------------------- Fargate Cluster ----------------------------

    const cluster = new ecs.Cluster(this, 'Cluster', { 
      vpc: props.prodVpc,
      containerInsights: true
    });

    const albFargate = new ecs_patterns.ApplicationLoadBalancedFargateService(this, "AlbFargate", {
      cluster: cluster,
      loadBalancer: lbForApp,
      taskSubnets: props.prodVpc.selectSubnets({
        subnetGroupName: 'Private'
      }),
      taskImageOptions: {
        image: ecs.ContainerImage.fromRegistry("amazon/amazon-ecs-sample"),
      },
    });

    // How to set attibute to TargetGroup - example) Modify deregistration delay
    albFargate.targetGroup.setAttribute("deregistration_delay.timeout_seconds", "30");


    // ----------------------- Alarms for ECS -----------------------------
    albFargate.service.metricCpuUtilization({
      period: cdk.Duration.minutes(1),
      statistic: cw.Statistic.AVERAGE,
    }).createAlarm(this, 'FargateCpuUtil', {
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      threshold: 80,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      actionsEnabled: true
    }).addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));

    // RunningTaskCount - CloudWatch Container Insights metric (Custom metric)
    // This is a sample of full set configuration for Metric and Alarm
    // See: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/AlarmThatSendsEmail.html#alarm-evaluation
    new cw.Metric({
      metricName: 'RunningTaskCount',
      namespace: 'ECS/ContainerInsights',
      dimensions: {
        ClusterName: cluster.clusterName,
        ServiceName: albFargate.service.serviceName,
      },
      period: cdk.Duration.minutes(1),
      statistic: cw.Statistic.AVERAGE,
    }).createAlarm(this, 'RunningTaskCount', {
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      threshold: 1,
      comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
      actionsEnabled: true
    }).addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));



    // ----------------------- Alarms for ALB -----------------------------

    // Alarm for ALB - ResponseTime 
    lbForApp.metricTargetResponseTime({
      period: cdk.Duration.minutes(1),
      statistic: cw.Statistic.AVERAGE,
    }).createAlarm(this, 'AlbResponseTime', {      
      evaluationPeriods: 3,
      threshold: 100,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      actionsEnabled: true
    }).addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));

    // Alarm for ALB - HTTP 4XX Count
    lbForApp.metricHttpCodeElb(elbv2.HttpCodeElb.ELB_4XX_COUNT, {
      period: cdk.Duration.minutes(1),
      statistic: cw.Statistic.SUM,
    }).createAlarm(this, 'AlbHttp4xx', {
      evaluationPeriods: 3,
      threshold: 10,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      actionsEnabled: true
    }).addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));

    // Alarm for ALB - HTTP 5XX Count
    lbForApp.metricHttpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, {
      period: cdk.Duration.minutes(1),
      statistic: cw.Statistic.SUM,
    }).createAlarm(this, 'AlbHttp5xx', {
      evaluationPeriods: 3,
      threshold: 10,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      actionsEnabled: true
    }).addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));

    // Alarm for ALB TargetGroup - HealthyHostCount
    albFargate.targetGroup.metricHealthyHostCount({
      period: cdk.Duration.minutes(1),
      statistic: cw.Statistic.AVERAGE,
    }).createAlarm(this, 'AlbTgHealthyHostCount', {
      evaluationPeriods: 3,
      threshold: 2,
      comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
      actionsEnabled: true
    }).addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));
  



    // WAFv2 for ALB
    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      defaultAction: { allow: {}},
      name: "GcWebAcl",
      scope: "REGIONAL",
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "GcWebAcl",
        sampledRequestsEnabled: true
      },
      rules: [
        {
          priority: 1,
          overrideAction: { count: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "AWS-AWSManagedRulesCommonRuleSet"
          },
          name: "AWSManagedRulesCommonRuleSet",
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet"
            }
          }
        },
        {
          priority: 2,
          overrideAction: { count: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "AWS-AWSManagedRulesKnownBadInputsRuleSet"
          },
          name: "AWSManagedRulesKnownBadInputsRuleSet",
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesKnownBadInputsRuleSet"
            }
          }
        },
        {
          priority: 3,
          overrideAction: { count: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "AWS-AWSManagedRulesAmazonIpReputationList"
          },
          name: "AWSManagedRulesAmazonIpReputationList",
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesAmazonIpReputationList"
            }
          }
        },
        {
          priority: 4,
          overrideAction: { count: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "AWS-AWSManagedRulesLinuxRuleSet"
          },
          name: "AWSManagedRulesLinuxRuleSet",
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesLinuxRuleSet"
            }
          }
        },
        {
          priority: 5,
          overrideAction: { count: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "AWS-AWSManagedRulesSQLiRuleSet"
          },
          name: "AWSManagedRulesSQLiRuleSet",
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesSQLiRuleSet"
            }
          }
        },        
      ],
    });

    new wafv2.CfnWebACLAssociation(this, 'BsWebAclAssociation', {
      resourceArn: lbForApp.loadBalancerArn,
      webAclArn: webAcl.attrArn
    })


  }
}
