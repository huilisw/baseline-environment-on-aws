import * as cdk from '@aws-cdk/core';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as iam from '@aws-cdk/aws-iam';
import { Duration, Tags, RemovalPolicy, SecretValue } from '@aws-cdk/core';

export interface GcInvestigationInstanceStackProps extends cdk.StackProps {
  prodVpc: ec2.Vpc,
  environment: string,
}

export class GcInvestigationInstanceStack extends cdk.Stack {
  public readonly InvestigationInstanceSecurityGroup: ec2.SecurityGroup;

  constructor(scope: cdk.Construct, id: string, props: GcInvestigationInstanceStackProps) {
    super(scope, id, props);

    // Security Group
    const securityGroupForEc2 = new ec2.SecurityGroup(this, 'SgEC2', {
      vpc: props.prodVpc
    });

    // InstanceProfile
    const ssmInstanceRole = new iam.Role(this, 'ssm-instance-role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      path: '/',
      managedPolicies: [
        { managedPolicyArn: 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore' },
        { managedPolicyArn: 'arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy' },
      ],
    });

    // UserData
    const userData = ec2.UserData.forLinux({shebang: '#!/bin/bash'});
    userData.addCommands(
      "sudo yum -y install mariadb",
    );

    const instance = new ec2.Instance(this, 'Investigation', {
      vpc: props.prodVpc,
      vpcSubnets: props.prodVpc.selectSubnets({
        subnetGroupName: 'Protected'
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO
      ),
      machineImage: new ec2.AmazonLinuxImage({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2
      }),
      securityGroup: securityGroupForEc2,
      role: ssmInstanceRole,
      userData: userData,
    });

    // Tag
    Tags.of(instance).add('Environment', props.environment);
    Tags.of(instance).add('Name', 'Investigation');
  }
}
