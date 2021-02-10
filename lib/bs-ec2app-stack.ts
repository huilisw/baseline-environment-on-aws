import * as cdk from '@aws-cdk/core';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as autoscaling from '@aws-cdk/aws-autoscaling';
import * as elbv2 from '@aws-cdk/aws-elasticloadbalancingv2';
import * as s3 from '@aws-cdk/aws-s3';
import * as iam from '@aws-cdk/aws-iam';
import { Duration, Tags, RemovalPolicy, SecretValue } from '@aws-cdk/core';
import * as kms from '@aws-cdk/aws-kms';

export interface BsEc2appStackProps extends cdk.StackProps {
  prodVpc: ec2.Vpc,
  environment: string,
  logBucket: s3.Bucket,
  appKey: kms.IKey,
}

export class BsEc2appStack extends cdk.Stack {
  public readonly appServerSecurityGroup: ec2.SecurityGroup;

  constructor(scope: cdk.Construct, id: string, props: BsEc2appStackProps) {
    super(scope, id, props);


    // --- Security Groups ---

    //Security Group of ALB for App
    const securityGroupForAlb = new ec2.SecurityGroup(this, 'security-group-for-alb', {
      vpc: props.prodVpc,
      allowAllOutbound: false,
    });
    securityGroupForAlb.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80));
    securityGroupForAlb.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.allTcp());

    //Security Group for Instance of App
    const securityGroupForApp = new ec2.SecurityGroup(this, 'security-group-for-app', {
      vpc: props.prodVpc,
      allowAllOutbound: false,
    });
    securityGroupForApp.addIngressRule(securityGroupForAlb, ec2.Port.tcp(80));
    securityGroupForApp.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.allTcp());
    this.appServerSecurityGroup = securityGroupForApp;

    //Security Group for RDS
    // const securityGroupForRDS = new ec2.SecurityGroup(this, 'security-group-for-rds', {
    //   vpc: props.prodVpc,
    //   allowAllOutbound: false,
    // });
    // securityGroupForRDS.addIngressRule(securityGroupForApp, ec2.Port.tcp(3306));
    // securityGroupForRDS.addEgressRule(securityGroupForApp, ec2.Port.allTcp());


    // ------------ S3 Bucket for Web Contents ---------------

    const webContentBucket = new s3.Bucket(this, 'web-content-bucket', {
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
      encryptionKey: props.appKey,
      encryption: s3.BucketEncryption.KMS
    });

    // Prevent access without SSL
    webContentBucket.addToResourcePolicy(new iam.PolicyStatement({
      effect:     iam.Effect.DENY,
      principals: [ new iam.AnyPrincipal() ],
      actions:    [ 's3:*' ],
      resources:  [ webContentBucket.bucketArn ],
      conditions: {
        'Bool' : {
          'aws:SecureTransport': 'false'
        }}
    }));

    // Prevent putting data without encryption
    webContentBucket.addToResourcePolicy(new iam.PolicyStatement({
      effect:     iam.Effect.DENY,
      principals: [ new iam.AnyPrincipal() ],
      actions:    [ 's3:PutObject' ],
      resources:  [ webContentBucket.arnForObjects('*') ],
      conditions: {
        "StringNotEquals": {
          "s3:x-amz-server-side-encryption": "AES256"
        }}
    }));


    // ------------ AppServers (AutoScaling) ---------------

    // InstanceProfile for AppServers
    const ssmInstanceRole = new iam.Role(this, 'ssm-instance-role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      path: '/',
      managedPolicies: [
        { managedPolicyArn: 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore' },
        { managedPolicyArn: 'arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy' },
      ],
    });

    // UserData for AppServer (setup httpd)
    const userDataForApp = ec2.UserData.forLinux({shebang: '#!/bin/bash'});
    userDataForApp.addCommands(
      "sudo yum -y install httpd",
      "sudo systemctl enable httpd",
      "sudo systemctl start httpd",
      "touch /var/www/html/index.html",
      "chown apache.apache /var/www/html/index.html",
    );

    // Auto Scaling Group for AppServers
    const fleetForApp = new autoscaling.AutoScalingGroup(this, 'auto-scaling-group-app', {
      minCapacity: 2,
      maxCapacity: 4,
      vpc: props.prodVpc,
      vpcSubnets: props.prodVpc.selectSubnets({
        subnetGroupName: 'ProdPrivateSubnet'
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO
      ),
      machineImage: new ec2.AmazonLinuxImage({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2
      }),
      securityGroup: securityGroupForApp,
      role: ssmInstanceRole, 
      userData: userDataForApp,
      healthCheck: autoscaling.HealthCheck.elb({
        grace: Duration.seconds(60)
      }),
    })

    // AutoScaling Policy
    fleetForApp.scaleOnCpuUtilization('keepSpareCPU', {
      targetUtilizationPercent: 50
    })

    // Tags for AppServers
    Tags.of(fleetForApp).add('Environment', props.environment, {applyToLaunchedInstances: true,});
    Tags.of(fleetForApp).add('Name', 'AppServer', {applyToLaunchedInstances: true,});
    Tags.of(fleetForApp).add('Role', 'FRA_AppServer', {applyToLaunchedInstances: true,});


    // ------------ Application LoadBalancer ---------------

    // S3 Bucket for ALB Logging (Needs SSE-S3)
    // https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-access-logs.html#access-logging-bucket-permissions
    const albLogBucket = new s3.Bucket(this, 'alb-log-bucket', {
      accessControl: s3.BucketAccessControl.PRIVATE,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL        
    });

    // ALB for App Server
    const lbForApp = new elbv2.ApplicationLoadBalancer(this, 'alb-for-app', {
      vpc: props.prodVpc,
      internetFacing: true,
      securityGroup: securityGroupForAlb,
      vpcSubnets: props.prodVpc.selectSubnets({
        subnetGroupName: 'ProdPublicSubnet'
      }),
    });
    lbForApp.logAccessLogs(albLogBucket);
    Tags.of(lbForApp).add('Environment', props.environment);

    // TargetGroup for App Server
    const tgForApp = new elbv2.ApplicationTargetGroup(this, 'tg-for-app', {
      vpc: props.prodVpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.INSTANCE,
      healthCheck: {
        enabled: true,
        path: "/index.html"
      },
      deregistrationDelay: Duration.seconds(60),
    }); 
    Tags.of(tgForApp).add('Environment', props.environment);    


    // ALB Listener - TargetGroup 
    lbForApp.addListener('alb-listener-for-app', {
      port: 80, 
      open: true,
      defaultTargetGroups: [tgForApp], 
    });

    // TargetGroup - AutoScalingGroup
    fleetForApp.attachToApplicationTargetGroup(tgForApp);

  }
}
