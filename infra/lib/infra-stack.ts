import { Stack, App, Duration } from 'aws-cdk-lib'
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager'
import {
  PublicHostedZone,
  ARecord,
  RecordTarget,
} from 'aws-cdk-lib/aws-route53'
import {
  Vpc,
  InstanceType,
  SubnetType,
  Port,
  Peer,
} from 'aws-cdk-lib/aws-ec2'
import { Role, ServicePrincipal, PolicyStatement } from 'aws-cdk-lib/aws-iam'
import {
  TaskDefinition,
  Compatibility,
  EcsOptimizedImage,
  Cluster,
  AsgCapacityProvider,
  Ec2Service,
  LinuxParameters,
  ContainerImage,
  LogDriver,
  Protocol as ECSProtocol,
} from 'aws-cdk-lib/aws-ecs'
import {
  AutoScalingGroup,
} from 'aws-cdk-lib/aws-autoscaling'
import { RetentionDays } from 'aws-cdk-lib/aws-logs'
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  Protocol,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import { LoadBalancerTarget } from 'aws-cdk-lib/aws-route53-targets'

export class InfraStack extends Stack {
  constructor(scope: App, id: string) {
    super(scope, id, {
      env: {
        account: process.env.AWS_ACCOUNT_ID,
        region: process.env.AWS_DEFAULT_REGION,
      },
    })

    const vpc = new Vpc(this, 'AppVPC', {
      natGateways: 0,
    })

    const cluster = new Cluster(this, 'Cluster', { vpc })

    const taskRole = new Role(this, 'AppRole', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
    })

    taskRole.addToPolicy(
      new PolicyStatement({
        resources: ['*'],
        actions: [
          'logs:*',
          'cloudwatch:*',
        ],
      })
    )

    const taskDefinition = new TaskDefinition(this, 'AppTask', {
      taskRole,
      compatibility: Compatibility.EC2,
    })
    taskDefinition.obtainExecutionRole()

    const asg = new AutoScalingGroup(this, 'ASG', {
      instanceType: new InstanceType('t3.nano'),
      machineImage: EcsOptimizedImage.amazonLinux2(),
      associatePublicIpAddress: true,
      maxCapacity: 3,
      desiredCapacity: 0,
      minCapacity: 0,
      vpc: vpc,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      newInstancesProtectedFromScaleIn: false,
    })


    const capacityProvider = new AsgCapacityProvider(
      this,
      'EC2CapacityProvider',
      {
        autoScalingGroup: asg,
        enableManagedScaling: true,
        enableManagedTerminationProtection: false,
        targetCapacityPercent: 100,
      }
    )

    cluster.addAsgCapacityProvider(capacityProvider)

    const service = new Ec2Service(this, 'AppService', {
      taskDefinition,
      cluster,
      desiredCount: 1,
      minHealthyPercent: 0,
      capacityProviderStrategies: [
        {
          capacityProvider: capacityProvider.capacityProviderName,
          weight: 1,
          base: 0,
        },
      ],
    })

    const container = taskDefinition.addContainer('AppContainer', {
      linuxParameters: new LinuxParameters(this, 'AppLinuxParams'),
      image: ContainerImage.fromAsset('../app'),
      logging: LogDriver.awsLogs({
        streamPrefix: 'app',
        logRetention: RetentionDays.ONE_WEEK,
      }),
      environment: {
        NODE_ENV: 'production',
      },
      memoryReservationMiB: 200,
    })

    container.addPortMappings({
      containerPort: 3000,
      hostPort: 3000,
      protocol: ECSProtocol.TCP,
    })


    const domainCertificate = Certificate.fromCertificateArn(
      this,
      'AppCertificate',
      process.env.APP_CERTIFICATE_ARN!
    )

    const loadBalancer = new ApplicationLoadBalancer(
      this,
      'AppLoadBalancer',
      {
        vpc,
        internetFacing: true,
        vpcSubnets: { subnetType: SubnetType.PUBLIC },
      }
    )

    loadBalancer.addRedirect({
      sourcePort: 80,
      sourceProtocol: ApplicationProtocol.HTTP,
      targetPort: 443,
      targetProtocol: ApplicationProtocol.HTTPS,
    })

    loadBalancer.connections.allowToAnyIpv4(Port.allTcp(), 'All Out')


    const listener = loadBalancer.addListener('Listener', {
      port: 443,
      certificates: [domainCertificate],
      protocol: ApplicationProtocol.HTTPS,
    })

    listener.addTargets('AppTarget', {
      healthCheck: {
        enabled: true,
        protocol: Protocol.HTTP,
      },
      port: 3000,
      deregistrationDelay: Duration.seconds(3) as any,
      protocol: ApplicationProtocol.HTTP,
      targets: [service],
    })

    loadBalancer.connections.allowFromAnyIpv4(
      Port.tcp(80),
      'Ingress HTTP internet'
    )
    loadBalancer.connections.allowFromAnyIpv4(
      Port.tcp(443),
      'Ingress HTTPS internet'
    )

    for (const subnet of vpc.publicSubnets as any) {
      asg.connections.allowFrom(
        Peer.ipv4(subnet.ipv4CidrBlock),
        Port.tcp(3000),
        'Ingress from ALB to App'
      )
    }


    const hostedZone = PublicHostedZone.fromLookup(this, 'HostedZone', {
      domainName: 'divicent.com',
    })

    new ARecord(this, 'AppARecord', {
      zone: hostedZone,
      target: RecordTarget.fromAlias(
        new LoadBalancerTarget(loadBalancer as any)
      ),
      recordName: 'app',
    })
  }
}
