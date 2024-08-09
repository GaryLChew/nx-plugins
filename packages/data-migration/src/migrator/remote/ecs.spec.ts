import { vi } from 'vitest';

const execSyncMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  execSync: execSyncMock,
}));

const { mkdirSyncMock, copyFileSyncMock, existsSyncMock } = vi.hoisted(() => ({
  mkdirSyncMock: vi.fn(),
  copyFileSyncMock: vi.fn(),
  existsSyncMock: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();

  return {
    ...actual,
    default: {
      mkdirSync: mkdirSyncMock,
      copyFileSync: copyFileSyncMock,
      existsSync: existsSyncMock,
    },
  };
});

const esbuildMock = vi.hoisted(() => vi.fn());

vi.mock('esbuild', () => ({
  default: {
    build: esbuildMock,
  },
}));

const spawmMock = vi.hoisted(() => vi.fn());

vi.mock('cross-spawn', () => ({
  default: {
    sync: spawmMock,
  },
}));

import '../../__mocks__/dynamoose.mock';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import {
  ECRClient,
  DescribeRepositoriesCommand,
  CreateRepositoryCommand,
} from '@aws-sdk/client-ecr';
import {
  ECSClient,
  RegisterTaskDefinitionCommand,
  DeregisterTaskDefinitionCommand,
  DescribeTasksCommand,
  RunTaskCommand,
} from '@aws-sdk/client-ecs';
import {
  CloudWatchLogsClient,
  DeleteLogGroupCommand,
  GetLogEventsCommand,
  CreateLogGroupCommand,
} from '@aws-sdk/client-cloudwatch-logs';

import { mockClient } from 'aws-sdk-client-mock';
import { EcsRemoteRunner } from './ecs';
import { CLILogger } from '../logger';
import { LifecycleHook } from '../types';
import path from 'path';

class AwsErrorMock extends Error {
  constructor(public name: string) {
    super(name);
  }
}

describe('ecs remote runner', () => {
  const accountId = '123456789012';
  const originalEnv = process.env;
  const migrationBase = {
    namespace: 'test',
    name: 'test1',
    version: 20230510,
    lifecycleHook: LifecycleHook.BEFORE_DEPLOY,
    path: 'apps/test/src/migrations/20230510-test1.ts',
    distPath: 'dist/apps/test/src/migrations/20230510-test1.ts',
    sleep: () => Promise.resolve(),
    remote: {
      config: {
        cluster: {
          value: 'test-cluster',
        },
        subnetIds: {
          value: 'subnet-1,subnet-2',
        },
        securityGroupId: {
          value: 'sg-1',
        },
        executionRoleArn: {
          value: 'arn:aws:iam::123456789012:role/ecsTaskExecutionRole',
        },
        taskRoleArn: {
          value: 'arn:aws:iam::123456789012:role/ecsTaskRole',
        },
        networkMode: 'awsvpc',
        cpu: 1024,
        memory: 2048,
      },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers().setSystemTime(
      new Date('2021-05-10T12:00:00Z').getTime(),
    );
    process.env = {
      ...originalEnv,
      ENV: 'test',
    };

    existsSyncMock.mockReturnValue(true);
  });

  it('should be defined', () => {
    expect(EcsRemoteRunner).toBeDefined();
  });

  describe('run', () => {
    it('should run the migration', async () => {
      delete process.env.AWS_REGION;
      const stsMock = mockClient(STSClient);
      const ecrMock = mockClient(ECRClient);
      const ecsMock = mockClient(ECSClient);
      const cloudWatchLogsMock = mockClient(CloudWatchLogsClient);

      stsMock.on(GetCallerIdentityCommand).resolves({
        Account: accountId,
      });

      ecrMock
        .on(DescribeRepositoriesCommand)
        .rejectsOnce(new AwsErrorMock('RepositoryNotFoundException'));

      spawmMock
        .mockReturnValueOnce({
          status: 0,
        })
        .mockReturnValueOnce({
          status: 0,
        })
        .mockReturnValueOnce({
          status: 0,
        });

      ecsMock.on(RegisterTaskDefinitionCommand).resolvesOnce({
        taskDefinition: {
          taskDefinitionArn:
            'arn:aws:ecs:us-east-1:123456789012:task-definition/test-test1-202305101:1',
        },
      });

      ecsMock.on(RunTaskCommand).resolvesOnce({
        tasks: [
          {
            taskArn:
              'arn:aws:ecs:us-east-1:123456789012:task/test-test1-202305101',
          },
        ],
      });

      ecsMock
        .on(DescribeTasksCommand)
        .resolvesOnce({
          tasks: [
            {
              taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/abc123',
              lastStatus: 'PENDING',
              containers: [
                {
                  name: 'migration',
                  lastStatus: 'PENDING',
                  exitCode: 0,
                },
              ],
            },
          ],
        })
        .resolvesOnce({
          tasks: [
            {
              taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/abc123',
              lastStatus: 'STOPPED',
              containers: [
                {
                  name: 'migration',
                  lastStatus: 'STOPPED',
                  exitCode: 0,
                },
              ],
            },
          ],
        });

      cloudWatchLogsMock
        .on(GetLogEventsCommand)
        .resolvesOnce({
          events: [
            {
              message: 'test1',
              timestamp: Date.now() + 1,
            },
          ],
        })
        .resolvesOnce({
          events: [
            {
              message: 'test2',
              timestamp: Date.now() + 2,
            },
          ],
        });

      const runner = new EcsRemoteRunner(
        new CLILogger('info'),
        migrationBase as never,
      );

      await runner.run();

      expect(stsMock).toHaveReceivedCommandTimes(GetCallerIdentityCommand, 1);
      expect(execSyncMock).toHaveBeenCalledTimes(2);
      expect(execSyncMock).toHaveBeenNthCalledWith(
        1,
        `aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws`,
        { stdio: 'inherit' },
      );
      expect(execSyncMock).toHaveBeenNthCalledWith(
        2,
        `aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin ${accountId}.dkr.ecr.us-east-1.amazonaws.com`,
        { stdio: 'inherit' },
      );
      expect(ecrMock).toHaveReceivedNthCommandWith(
        DescribeRepositoriesCommand,
        1,
        {
          repositoryNames: ['migrations'],
        },
      );
      expect(ecrMock).toHaveReceivedNthCommandWith(CreateRepositoryCommand, 1, {
        repositoryName: 'migrations',
      });
      expect(mkdirSyncMock).toHaveBeenCalledWith(
        'dist/apps/test/src/migrations/remote',
        { recursive: true },
      );
      expect(copyFileSyncMock).toHaveBeenCalledWith(
        path.join(__dirname, 'Dockerfile'),
        'dist/apps/test/src/migrations/remote/Dockerfile',
      );

      expect(esbuildMock).toHaveBeenCalledTimes(2);
      expect(esbuildMock).toHaveBeenNthCalledWith(1, {
        format: 'cjs',
        bundle: true,
        minify: false,
        sourcemap: false,
        target: ['node18'],
        entryPoints: [path.join(__dirname, 'wrapper.ts')],
        outfile: 'dist/apps/test/src/migrations/remote/wrapper.js',
        platform: 'node',
      });
      expect(esbuildMock).toHaveBeenNthCalledWith(2, {
        format: 'cjs',
        bundle: true,
        minify: false,
        sourcemap: false,
        target: ['node18'],
        entryPoints: ['apps/test/src/migrations/20230510-test1.ts'],
        outfile: 'dist/apps/test/src/migrations/remote/migration.js',
        platform: 'node',
      });

      expect(spawmMock).toHaveBeenCalledTimes(3);
      expect(spawmMock).toHaveBeenNthCalledWith(
        1,
        'docker',
        ['build', '--platform=linux/amd64', '-t', 'test-test1-20230510', '.'],
        {
          cwd: 'dist/apps/test/src/migrations/remote',
          stdio: 'inherit',
        },
      );
      expect(spawmMock).toHaveBeenNthCalledWith(
        2,
        'docker',
        [
          'tag',
          'test-test1-20230510',
          `${accountId}.dkr.ecr.us-east-1.amazonaws.com/migrations:test-test1-20230510`,
        ],
        {
          cwd: 'dist/apps/test/src/migrations/remote',
          stdio: 'inherit',
        },
      );
      expect(spawmMock).toHaveBeenNthCalledWith(
        3,
        'docker',
        [
          'push',
          `${accountId}.dkr.ecr.us-east-1.amazonaws.com/migrations:test-test1-20230510`,
        ],
        {
          cwd: 'dist/apps/test/src/migrations/remote',
          stdio: 'inherit',
        },
      );
      expect(cloudWatchLogsMock).toHaveReceivedNthCommandWith(
        CreateLogGroupCommand,
        1,
        {
          logGroupName: `/ecs/test/test1/20230510`,
          tags: {
            namespace: 'test',
            name: 'test1',
            version: '20230510',
            source: 'migration',
          },
        },
      );

      expect(ecsMock).toHaveReceivedNthCommandWith(
        RegisterTaskDefinitionCommand,
        1,
        {
          containerDefinitions: [
            {
              environment: [
                {
                  name: 'LOG_LEVEL',
                  value: 'info',
                },
                {
                  name: 'ENV',
                  value: 'test',
                },
                {
                  name: 'MIGRATION_FILE_NAME',
                  value: 'migration.js',
                },
                {
                  name: 'OPERATION',
                  value: 'run',
                },
              ],
              image:
                '123456789012.dkr.ecr.us-east-1.amazonaws.com/migrations:test-test1-20230510',
              logConfiguration: {
                logDriver: 'awslogs',
                options: {
                  'awslogs-group': '/ecs/test/test1/20230510',
                  'awslogs-region': 'us-east-1',
                  'awslogs-stream-prefix': 'ecs',
                },
              },
              name: 'migration',
            },
          ],
          cpu: '1024',
          executionRoleArn:
            'arn:aws:iam::123456789012:role/ecsTaskExecutionRole',
          family: 'migration-test-test1-20230510-task',
          memory: '2048',
          networkMode: 'awsvpc',
          requiresCompatibilities: ['FARGATE'],
          taskRoleArn: 'arn:aws:iam::123456789012:role/ecsTaskRole',
        },
      );
      expect(ecsMock).toHaveReceivedNthCommandWith(RunTaskCommand, 1, {
        cluster: 'test-cluster',
        count: 1,
        launchType: 'FARGATE',
        networkConfiguration: {
          awsvpcConfiguration: {
            assignPublicIp: 'DISABLED',
            securityGroups: ['sg-1'],
            subnets: ['subnet-1', 'subnet-2'],
          },
        },
        startedBy: 'migration',
        taskDefinition:
          'arn:aws:ecs:us-east-1:123456789012:task-definition/test-test1-202305101:1',
      });
      expect(ecsMock).toHaveReceivedNthCommandWith(DescribeTasksCommand, 1, {
        cluster: 'test-cluster',
        tasks: ['arn:aws:ecs:us-east-1:123456789012:task/test-test1-202305101'],
      });
      expect(ecsMock).toHaveReceivedNthCommandWith(DescribeTasksCommand, 2, {
        cluster: 'test-cluster',
        tasks: ['arn:aws:ecs:us-east-1:123456789012:task/test-test1-202305101'],
      });

      expect(cloudWatchLogsMock).toHaveReceivedNthCommandWith(
        GetLogEventsCommand,
        1,
        {
          endTime: Date.now(),
          logGroupName: '/ecs/test/test1/20230510',
          logStreamName: 'ecs/migration/abc123',
          startTime: Date.now(),
        },
      );
      expect(cloudWatchLogsMock).toHaveReceivedNthCommandWith(
        GetLogEventsCommand,
        2,
        {
          endTime: Date.now(),
          logGroupName: '/ecs/test/test1/20230510',
          logStreamName: 'ecs/migration/abc123',
          startTime: Date.now() + 2,
        },
      );

      expect(cloudWatchLogsMock).toHaveReceivedNthCommandWith(
        DeleteLogGroupCommand,
        1,
        {
          logGroupName: '/ecs/test/test1/20230510',
        },
      );
      expect(ecsMock).toHaveReceivedNthCommandWith(
        DeregisterTaskDefinitionCommand,
        1,
        {
          taskDefinition:
            'arn:aws:ecs:us-east-1:123456789012:task-definition/test-test1-202305101:1',
        },
      );
    });

    it('should run the migration with wrapper.js', async () => {
      delete process.env.AWS_REGION;
      const stsMock = mockClient(STSClient);
      const ecrMock = mockClient(ECRClient);
      const ecsMock = mockClient(ECSClient);
      const cloudWatchLogsMock = mockClient(CloudWatchLogsClient);

      stsMock.on(GetCallerIdentityCommand).resolves({
        Account: accountId,
      });

      ecrMock
        .on(DescribeRepositoriesCommand)
        .rejectsOnce(new AwsErrorMock('RepositoryNotFoundException'));

      spawmMock
        .mockReturnValueOnce({
          status: 0,
        })
        .mockReturnValueOnce({
          status: 0,
        })
        .mockReturnValueOnce({
          status: 0,
        });

      ecsMock.on(RegisterTaskDefinitionCommand).resolvesOnce({
        taskDefinition: {
          taskDefinitionArn:
            'arn:aws:ecs:us-east-1:123456789012:task-definition/test-test1-202305101:1',
        },
      });

      ecsMock.on(RunTaskCommand).resolvesOnce({
        tasks: [
          {
            taskArn:
              'arn:aws:ecs:us-east-1:123456789012:task/test-test1-202305101',
          },
        ],
      });

      ecsMock
        .on(DescribeTasksCommand)
        .resolvesOnce({
          tasks: [
            {
              taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/abc123',
              lastStatus: 'PENDING',
              containers: [
                {
                  name: 'migration',
                  lastStatus: 'PENDING',
                  exitCode: 0,
                },
              ],
            },
          ],
        })
        .resolvesOnce({
          tasks: [
            {
              taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/abc123',
              lastStatus: 'STOPPED',
              containers: [
                {
                  name: 'migration',
                  lastStatus: 'STOPPED',
                  exitCode: 0,
                },
              ],
            },
          ],
        });

      cloudWatchLogsMock
        .on(GetLogEventsCommand)
        .resolvesOnce({
          events: [
            {
              message: 'test1',
              timestamp: Date.now() + 1,
            },
          ],
        })
        .resolvesOnce({
          events: [
            {
              message: 'test2',
              timestamp: Date.now() + 2,
            },
          ],
        });

      existsSyncMock.mockReturnValue(false);

      const runner = new EcsRemoteRunner(
        new CLILogger('info'),
        migrationBase as never,
      );

      await runner.run();

      expect(stsMock).toHaveReceivedCommandTimes(GetCallerIdentityCommand, 1);
      expect(execSyncMock).toHaveBeenCalledTimes(2);
      expect(execSyncMock).toHaveBeenNthCalledWith(
        1,
        `aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws`,
        { stdio: 'inherit' },
      );
      expect(execSyncMock).toHaveBeenNthCalledWith(
        2,
        `aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin ${accountId}.dkr.ecr.us-east-1.amazonaws.com`,
        { stdio: 'inherit' },
      );
      expect(ecrMock).toHaveReceivedNthCommandWith(
        DescribeRepositoriesCommand,
        1,
        {
          repositoryNames: ['migrations'],
        },
      );
      expect(ecrMock).toHaveReceivedNthCommandWith(CreateRepositoryCommand, 1, {
        repositoryName: 'migrations',
      });
      expect(mkdirSyncMock).toHaveBeenCalledWith(
        'dist/apps/test/src/migrations/remote',
        { recursive: true },
      );
      expect(copyFileSyncMock).toHaveBeenCalledWith(
        path.join(__dirname, 'Dockerfile'),
        'dist/apps/test/src/migrations/remote/Dockerfile',
      );

      expect(esbuildMock).toHaveBeenCalledTimes(2);
      expect(esbuildMock).toHaveBeenNthCalledWith(1, {
        format: 'cjs',
        bundle: true,
        minify: false,
        sourcemap: false,
        target: ['node18'],
        entryPoints: [path.join(__dirname, 'wrapper.js')],
        outfile: 'dist/apps/test/src/migrations/remote/wrapper.js',
        platform: 'node',
      });
      expect(esbuildMock).toHaveBeenNthCalledWith(2, {
        format: 'cjs',
        bundle: true,
        minify: false,
        sourcemap: false,
        target: ['node18'],
        entryPoints: ['apps/test/src/migrations/20230510-test1.ts'],
        outfile: 'dist/apps/test/src/migrations/remote/migration.js',
        platform: 'node',
      });

      expect(spawmMock).toHaveBeenCalledTimes(3);
      expect(spawmMock).toHaveBeenNthCalledWith(
        1,
        'docker',
        ['build', '--platform=linux/amd64', '-t', 'test-test1-20230510', '.'],
        {
          cwd: 'dist/apps/test/src/migrations/remote',
          stdio: 'inherit',
        },
      );
      expect(spawmMock).toHaveBeenNthCalledWith(
        2,
        'docker',
        [
          'tag',
          'test-test1-20230510',
          `${accountId}.dkr.ecr.us-east-1.amazonaws.com/migrations:test-test1-20230510`,
        ],
        {
          cwd: 'dist/apps/test/src/migrations/remote',
          stdio: 'inherit',
        },
      );
      expect(spawmMock).toHaveBeenNthCalledWith(
        3,
        'docker',
        [
          'push',
          `${accountId}.dkr.ecr.us-east-1.amazonaws.com/migrations:test-test1-20230510`,
        ],
        {
          cwd: 'dist/apps/test/src/migrations/remote',
          stdio: 'inherit',
        },
      );
      expect(cloudWatchLogsMock).toHaveReceivedNthCommandWith(
        CreateLogGroupCommand,
        1,
        {
          logGroupName: `/ecs/test/test1/20230510`,
          tags: {
            namespace: 'test',
            name: 'test1',
            version: '20230510',
            source: 'migration',
          },
        },
      );

      expect(ecsMock).toHaveReceivedNthCommandWith(
        RegisterTaskDefinitionCommand,
        1,
        {
          containerDefinitions: [
            {
              environment: [
                {
                  name: 'LOG_LEVEL',
                  value: 'info',
                },
                {
                  name: 'ENV',
                  value: 'test',
                },
                {
                  name: 'MIGRATION_FILE_NAME',
                  value: 'migration.js',
                },
                {
                  name: 'OPERATION',
                  value: 'run',
                },
              ],
              image:
                '123456789012.dkr.ecr.us-east-1.amazonaws.com/migrations:test-test1-20230510',
              logConfiguration: {
                logDriver: 'awslogs',
                options: {
                  'awslogs-group': '/ecs/test/test1/20230510',
                  'awslogs-region': 'us-east-1',
                  'awslogs-stream-prefix': 'ecs',
                },
              },
              name: 'migration',
            },
          ],
          cpu: '1024',
          executionRoleArn:
            'arn:aws:iam::123456789012:role/ecsTaskExecutionRole',
          family: 'migration-test-test1-20230510-task',
          memory: '2048',
          networkMode: 'awsvpc',
          requiresCompatibilities: ['FARGATE'],
          taskRoleArn: 'arn:aws:iam::123456789012:role/ecsTaskRole',
        },
      );
      expect(ecsMock).toHaveReceivedNthCommandWith(RunTaskCommand, 1, {
        cluster: 'test-cluster',
        count: 1,
        launchType: 'FARGATE',
        networkConfiguration: {
          awsvpcConfiguration: {
            assignPublicIp: 'DISABLED',
            securityGroups: ['sg-1'],
            subnets: ['subnet-1', 'subnet-2'],
          },
        },
        startedBy: 'migration',
        taskDefinition:
          'arn:aws:ecs:us-east-1:123456789012:task-definition/test-test1-202305101:1',
      });
      expect(ecsMock).toHaveReceivedNthCommandWith(DescribeTasksCommand, 1, {
        cluster: 'test-cluster',
        tasks: ['arn:aws:ecs:us-east-1:123456789012:task/test-test1-202305101'],
      });
      expect(ecsMock).toHaveReceivedNthCommandWith(DescribeTasksCommand, 2, {
        cluster: 'test-cluster',
        tasks: ['arn:aws:ecs:us-east-1:123456789012:task/test-test1-202305101'],
      });

      expect(cloudWatchLogsMock).toHaveReceivedNthCommandWith(
        GetLogEventsCommand,
        1,
        {
          endTime: Date.now(),
          logGroupName: '/ecs/test/test1/20230510',
          logStreamName: 'ecs/migration/abc123',
          startTime: Date.now(),
        },
      );
      expect(cloudWatchLogsMock).toHaveReceivedNthCommandWith(
        GetLogEventsCommand,
        2,
        {
          endTime: Date.now(),
          logGroupName: '/ecs/test/test1/20230510',
          logStreamName: 'ecs/migration/abc123',
          startTime: Date.now() + 2,
        },
      );

      expect(cloudWatchLogsMock).toHaveReceivedNthCommandWith(
        DeleteLogGroupCommand,
        1,
        {
          logGroupName: '/ecs/test/test1/20230510',
        },
      );
      expect(ecsMock).toHaveReceivedNthCommandWith(
        DeregisterTaskDefinitionCommand,
        1,
        {
          taskDefinition:
            'arn:aws:ecs:us-east-1:123456789012:task-definition/test-test1-202305101:1',
        },
      );
    });

    it('should run the migration with assignPublicIp to ENABLED', async () => {
      delete process.env.AWS_REGION;
      const stsMock = mockClient(STSClient);
      const ecrMock = mockClient(ECRClient);
      const ecsMock = mockClient(ECSClient);
      const cloudWatchLogsMock = mockClient(CloudWatchLogsClient);

      stsMock.on(GetCallerIdentityCommand).resolves({
        Account: accountId,
      });

      ecrMock
        .on(DescribeRepositoriesCommand)
        .rejectsOnce(new AwsErrorMock('RepositoryNotFoundException'));

      spawmMock
        .mockReturnValueOnce({
          status: 0,
        })
        .mockReturnValueOnce({
          status: 0,
        })
        .mockReturnValueOnce({
          status: 0,
        });

      ecsMock.on(RegisterTaskDefinitionCommand).resolvesOnce({
        taskDefinition: {
          taskDefinitionArn:
            'arn:aws:ecs:us-east-1:123456789012:task-definition/test-test1-202305101:1',
        },
      });

      ecsMock.on(RunTaskCommand).resolvesOnce({
        tasks: [
          {
            taskArn:
              'arn:aws:ecs:us-east-1:123456789012:task/test-test1-202305101',
          },
        ],
      });

      ecsMock
        .on(DescribeTasksCommand)
        .resolvesOnce({
          tasks: [
            {
              taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/abc123',
              lastStatus: 'PENDING',
              containers: [
                {
                  name: 'migration',
                  lastStatus: 'PENDING',
                  exitCode: 0,
                },
              ],
            },
          ],
        })
        .resolvesOnce({
          tasks: [
            {
              taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/abc123',
              lastStatus: 'STOPPED',
              containers: [
                {
                  name: 'migration',
                  lastStatus: 'STOPPED',
                  exitCode: 0,
                },
              ],
            },
          ],
        });

      cloudWatchLogsMock
        .on(GetLogEventsCommand)
        .resolvesOnce({
          events: [
            {
              message: 'test1',
              timestamp: Date.now() + 1,
            },
          ],
        })
        .resolvesOnce({
          events: [
            {
              message: 'test2',
              timestamp: Date.now() + 2,
            },
          ],
        });

      const runner = new EcsRemoteRunner(new CLILogger('info'), {
        ...migrationBase,
        remote: {
          ...migrationBase.remote,
          config: {
            ...migrationBase.remote.config,
            assignPublicIp: 'ENABLED',
          },
        },
      } as never);

      await runner.run();

      expect(stsMock).toHaveReceivedCommandTimes(GetCallerIdentityCommand, 1);
      expect(execSyncMock).toHaveBeenCalledTimes(2);
      expect(execSyncMock).toHaveBeenNthCalledWith(
        1,
        `aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws`,
        { stdio: 'inherit' },
      );
      expect(execSyncMock).toHaveBeenNthCalledWith(
        2,
        `aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin ${accountId}.dkr.ecr.us-east-1.amazonaws.com`,
        { stdio: 'inherit' },
      );
      expect(ecrMock).toHaveReceivedNthCommandWith(
        DescribeRepositoriesCommand,
        1,
        {
          repositoryNames: ['migrations'],
        },
      );
      expect(ecrMock).toHaveReceivedNthCommandWith(CreateRepositoryCommand, 1, {
        repositoryName: 'migrations',
      });
      expect(mkdirSyncMock).toHaveBeenCalledWith(
        'dist/apps/test/src/migrations/remote',
        { recursive: true },
      );
      expect(copyFileSyncMock).toHaveBeenCalledWith(
        path.join(__dirname, 'Dockerfile'),
        'dist/apps/test/src/migrations/remote/Dockerfile',
      );

      expect(esbuildMock).toHaveBeenCalledTimes(2);
      expect(esbuildMock).toHaveBeenNthCalledWith(1, {
        format: 'cjs',
        bundle: true,
        minify: false,
        sourcemap: false,
        target: ['node18'],
        entryPoints: [path.join(__dirname, 'wrapper.ts')],
        outfile: 'dist/apps/test/src/migrations/remote/wrapper.js',
        platform: 'node',
      });
      expect(esbuildMock).toHaveBeenNthCalledWith(2, {
        format: 'cjs',
        bundle: true,
        minify: false,
        sourcemap: false,
        target: ['node18'],
        entryPoints: ['apps/test/src/migrations/20230510-test1.ts'],
        outfile: 'dist/apps/test/src/migrations/remote/migration.js',
        platform: 'node',
      });

      expect(spawmMock).toHaveBeenCalledTimes(3);
      expect(spawmMock).toHaveBeenNthCalledWith(
        1,
        'docker',
        ['build', '--platform=linux/amd64', '-t', 'test-test1-20230510', '.'],
        {
          cwd: 'dist/apps/test/src/migrations/remote',
          stdio: 'inherit',
        },
      );
      expect(spawmMock).toHaveBeenNthCalledWith(
        2,
        'docker',
        [
          'tag',
          'test-test1-20230510',
          `${accountId}.dkr.ecr.us-east-1.amazonaws.com/migrations:test-test1-20230510`,
        ],
        {
          cwd: 'dist/apps/test/src/migrations/remote',
          stdio: 'inherit',
        },
      );
      expect(spawmMock).toHaveBeenNthCalledWith(
        3,
        'docker',
        [
          'push',
          `${accountId}.dkr.ecr.us-east-1.amazonaws.com/migrations:test-test1-20230510`,
        ],
        {
          cwd: 'dist/apps/test/src/migrations/remote',
          stdio: 'inherit',
        },
      );
      expect(cloudWatchLogsMock).toHaveReceivedNthCommandWith(
        CreateLogGroupCommand,
        1,
        {
          logGroupName: `/ecs/test/test1/20230510`,
          tags: {
            namespace: 'test',
            name: 'test1',
            version: '20230510',
            source: 'migration',
          },
        },
      );

      expect(ecsMock).toHaveReceivedNthCommandWith(
        RegisterTaskDefinitionCommand,
        1,
        {
          containerDefinitions: [
            {
              environment: [
                {
                  name: 'LOG_LEVEL',
                  value: 'info',
                },
                {
                  name: 'ENV',
                  value: 'test',
                },
                {
                  name: 'MIGRATION_FILE_NAME',
                  value: 'migration.js',
                },
                {
                  name: 'OPERATION',
                  value: 'run',
                },
              ],
              image:
                '123456789012.dkr.ecr.us-east-1.amazonaws.com/migrations:test-test1-20230510',
              logConfiguration: {
                logDriver: 'awslogs',
                options: {
                  'awslogs-group': '/ecs/test/test1/20230510',
                  'awslogs-region': 'us-east-1',
                  'awslogs-stream-prefix': 'ecs',
                },
              },
              name: 'migration',
            },
          ],
          cpu: '1024',
          executionRoleArn:
            'arn:aws:iam::123456789012:role/ecsTaskExecutionRole',
          family: 'migration-test-test1-20230510-task',
          memory: '2048',
          networkMode: 'awsvpc',
          requiresCompatibilities: ['FARGATE'],
          taskRoleArn: 'arn:aws:iam::123456789012:role/ecsTaskRole',
        },
      );
      expect(ecsMock).toHaveReceivedNthCommandWith(RunTaskCommand, 1, {
        cluster: 'test-cluster',
        count: 1,
        launchType: 'FARGATE',
        networkConfiguration: {
          awsvpcConfiguration: {
            assignPublicIp: 'ENABLED',
            securityGroups: ['sg-1'],
            subnets: ['subnet-1', 'subnet-2'],
          },
        },
        startedBy: 'migration',
        taskDefinition:
          'arn:aws:ecs:us-east-1:123456789012:task-definition/test-test1-202305101:1',
      });
      expect(ecsMock).toHaveReceivedNthCommandWith(DescribeTasksCommand, 1, {
        cluster: 'test-cluster',
        tasks: ['arn:aws:ecs:us-east-1:123456789012:task/test-test1-202305101'],
      });
      expect(ecsMock).toHaveReceivedNthCommandWith(DescribeTasksCommand, 2, {
        cluster: 'test-cluster',
        tasks: ['arn:aws:ecs:us-east-1:123456789012:task/test-test1-202305101'],
      });

      expect(cloudWatchLogsMock).toHaveReceivedNthCommandWith(
        GetLogEventsCommand,
        1,
        {
          endTime: Date.now(),
          logGroupName: '/ecs/test/test1/20230510',
          logStreamName: 'ecs/migration/abc123',
          startTime: Date.now(),
        },
      );
      expect(cloudWatchLogsMock).toHaveReceivedNthCommandWith(
        GetLogEventsCommand,
        2,
        {
          endTime: Date.now(),
          logGroupName: '/ecs/test/test1/20230510',
          logStreamName: 'ecs/migration/abc123',
          startTime: Date.now() + 2,
        },
      );

      expect(cloudWatchLogsMock).toHaveReceivedNthCommandWith(
        DeleteLogGroupCommand,
        1,
        {
          logGroupName: '/ecs/test/test1/20230510',
        },
      );
      expect(ecsMock).toHaveReceivedNthCommandWith(
        DeregisterTaskDefinitionCommand,
        1,
        {
          taskDefinition:
            'arn:aws:ecs:us-east-1:123456789012:task-definition/test-test1-202305101:1',
        },
      );
    });

    it('should throw an exception when ecr cannot be described', async () => {
      process.env.AWS_REGION = 'us-east-1';
      const stsMock = mockClient(STSClient);
      const ecrMock = mockClient(ECRClient);
      const ecsMock = mockClient(ECSClient);
      const cloudWatchLogsMock = mockClient(CloudWatchLogsClient);

      stsMock.on(GetCallerIdentityCommand).resolves({
        Account: accountId,
      });

      ecrMock
        .on(DescribeRepositoriesCommand)
        .rejectsOnce(new Error('Invalid parameter'));

      const runner = new EcsRemoteRunner(
        new CLILogger('info'),
        migrationBase as never,
      );

      await expect(runner.run()).rejects.toThrow('Invalid parameter');

      expect(stsMock).toHaveReceivedCommandTimes(GetCallerIdentityCommand, 1);
      expect(execSyncMock).toHaveBeenCalledTimes(2);
      expect(execSyncMock).toHaveBeenNthCalledWith(
        1,
        `aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws`,
        { stdio: 'inherit' },
      );
      expect(execSyncMock).toHaveBeenNthCalledWith(
        2,
        `aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin ${accountId}.dkr.ecr.us-east-1.amazonaws.com`,
        { stdio: 'inherit' },
      );
      expect(ecrMock).toHaveReceivedNthCommandWith(
        DescribeRepositoriesCommand,
        1,
        {
          repositoryNames: ['migrations'],
        },
      );
      expect(ecrMock).not.toHaveReceivedCommand(CreateRepositoryCommand);
      expect(mkdirSyncMock).not.toHaveBeenCalled();
      expect(copyFileSyncMock).not.toHaveBeenCalled();
      expect(esbuildMock).not.toHaveBeenCalled();
      expect(spawmMock).not.toHaveBeenCalled();
      expect(cloudWatchLogsMock).not.toHaveReceivedCommand(
        CreateLogGroupCommand,
      );
      expect(ecsMock).not.toHaveReceivedCommand(RegisterTaskDefinitionCommand);
      expect(ecsMock).not.toHaveReceivedCommand(RunTaskCommand);
      expect(ecsMock).not.toHaveReceivedCommand(DescribeTasksCommand);
      expect(cloudWatchLogsMock).not.toHaveReceivedCommand(GetLogEventsCommand);
      expect(cloudWatchLogsMock).not.toHaveReceivedCommand(
        DeleteLogGroupCommand,
      );
      expect(ecsMock).not.toHaveReceivedCommand(
        DeregisterTaskDefinitionCommand,
      );
    });

    it('should throw an exception when docker build command returns exit code != 0', async () => {
      process.env.AWS_REGION = 'us-east-1';
      const stsMock = mockClient(STSClient);
      const ecrMock = mockClient(ECRClient);
      const ecsMock = mockClient(ECSClient);
      const cloudWatchLogsMock = mockClient(CloudWatchLogsClient);

      stsMock.on(GetCallerIdentityCommand).resolves({
        Account: accountId,
      });

      ecrMock.on(DescribeRepositoriesCommand).resolvesOnce({});

      spawmMock.mockReturnValueOnce({
        status: 9,
      });

      const runner = new EcsRemoteRunner(
        new CLILogger('info'),
        migrationBase as never,
      );

      await expect(runner.run()).rejects.toThrow(
        'Failed to build docker image',
      );

      expect(stsMock).toHaveReceivedCommandTimes(GetCallerIdentityCommand, 1);
      expect(execSyncMock).toHaveBeenCalledTimes(2);
      expect(execSyncMock).toHaveBeenNthCalledWith(
        1,
        `aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws`,
        { stdio: 'inherit' },
      );
      expect(execSyncMock).toHaveBeenNthCalledWith(
        2,
        `aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin ${accountId}.dkr.ecr.us-east-1.amazonaws.com`,
        { stdio: 'inherit' },
      );
      expect(ecrMock).toHaveReceivedNthCommandWith(
        DescribeRepositoriesCommand,
        1,
        {
          repositoryNames: ['migrations'],
        },
      );
      expect(ecrMock).not.toHaveReceivedCommand(CreateRepositoryCommand);
      expect(mkdirSyncMock).toHaveBeenCalledWith(
        'dist/apps/test/src/migrations/remote',
        { recursive: true },
      );
      expect(copyFileSyncMock).toHaveBeenCalledWith(
        path.join(__dirname, 'Dockerfile'),
        'dist/apps/test/src/migrations/remote/Dockerfile',
      );

      expect(esbuildMock).toHaveBeenCalledTimes(2);
      expect(esbuildMock).toHaveBeenNthCalledWith(1, {
        format: 'cjs',
        bundle: true,
        minify: false,
        sourcemap: false,
        target: ['node18'],
        entryPoints: [path.join(__dirname, 'wrapper.ts')],
        outfile: 'dist/apps/test/src/migrations/remote/wrapper.js',
        platform: 'node',
      });
      expect(esbuildMock).toHaveBeenNthCalledWith(2, {
        format: 'cjs',
        bundle: true,
        minify: false,
        sourcemap: false,
        target: ['node18'],
        entryPoints: ['apps/test/src/migrations/20230510-test1.ts'],
        outfile: 'dist/apps/test/src/migrations/remote/migration.js',
        platform: 'node',
      });
      expect(spawmMock).toHaveBeenCalledTimes(1);
      expect(spawmMock).toHaveBeenNthCalledWith(
        1,
        'docker',
        ['build', '--platform=linux/amd64', '-t', 'test-test1-20230510', '.'],
        {
          cwd: 'dist/apps/test/src/migrations/remote',
          stdio: 'inherit',
        },
      );
      expect(cloudWatchLogsMock).not.toHaveReceivedCommand(
        CreateLogGroupCommand,
      );
      expect(ecsMock).not.toHaveReceivedCommand(RegisterTaskDefinitionCommand);
      expect(ecsMock).not.toHaveReceivedCommand(RunTaskCommand);
      expect(ecsMock).not.toHaveReceivedCommand(DescribeTasksCommand);
      expect(cloudWatchLogsMock).not.toHaveReceivedCommand(GetLogEventsCommand);
      expect(cloudWatchLogsMock).not.toHaveReceivedCommand(
        DeleteLogGroupCommand,
      );
      expect(ecsMock).not.toHaveReceivedCommand(
        DeregisterTaskDefinitionCommand,
      );
    });

    it('should throw an exception when docker tag command returns exit code != 0', async () => {
      process.env.AWS_REGION = 'us-east-1';
      const stsMock = mockClient(STSClient);
      const ecrMock = mockClient(ECRClient);
      const ecsMock = mockClient(ECSClient);
      const cloudWatchLogsMock = mockClient(CloudWatchLogsClient);

      stsMock.on(GetCallerIdentityCommand).resolves({
        Account: accountId,
      });

      ecrMock.on(DescribeRepositoriesCommand).resolvesOnce({});

      spawmMock
        .mockReturnValueOnce({
          status: 0,
        })
        .mockReturnValueOnce({
          status: 9,
        });

      const runner = new EcsRemoteRunner(
        new CLILogger('info'),
        migrationBase as never,
      );

      await expect(runner.run()).rejects.toThrow(
        'Failed to tag the docker image',
      );

      expect(stsMock).toHaveReceivedCommandTimes(GetCallerIdentityCommand, 1);
      expect(execSyncMock).toHaveBeenCalledTimes(2);
      expect(execSyncMock).toHaveBeenNthCalledWith(
        1,
        `aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws`,
        { stdio: 'inherit' },
      );
      expect(execSyncMock).toHaveBeenNthCalledWith(
        2,
        `aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin ${accountId}.dkr.ecr.us-east-1.amazonaws.com`,
        { stdio: 'inherit' },
      );
      expect(ecrMock).toHaveReceivedNthCommandWith(
        DescribeRepositoriesCommand,
        1,
        {
          repositoryNames: ['migrations'],
        },
      );
      expect(ecrMock).not.toHaveReceivedCommand(CreateRepositoryCommand);
      expect(mkdirSyncMock).toHaveBeenCalledWith(
        'dist/apps/test/src/migrations/remote',
        { recursive: true },
      );
      expect(copyFileSyncMock).toHaveBeenCalledWith(
        path.join(__dirname, 'Dockerfile'),
        'dist/apps/test/src/migrations/remote/Dockerfile',
      );

      expect(esbuildMock).toHaveBeenCalledTimes(2);
      expect(esbuildMock).toHaveBeenNthCalledWith(1, {
        format: 'cjs',
        bundle: true,
        minify: false,
        sourcemap: false,
        target: ['node18'],
        entryPoints: [path.join(__dirname, 'wrapper.ts')],
        outfile: 'dist/apps/test/src/migrations/remote/wrapper.js',
        platform: 'node',
      });
      expect(esbuildMock).toHaveBeenNthCalledWith(2, {
        format: 'cjs',
        bundle: true,
        minify: false,
        sourcemap: false,
        target: ['node18'],
        entryPoints: ['apps/test/src/migrations/20230510-test1.ts'],
        outfile: 'dist/apps/test/src/migrations/remote/migration.js',
        platform: 'node',
      });
      expect(spawmMock).toHaveBeenCalledTimes(2);
      expect(spawmMock).toHaveBeenNthCalledWith(
        1,
        'docker',
        ['build', '--platform=linux/amd64', '-t', 'test-test1-20230510', '.'],
        {
          cwd: 'dist/apps/test/src/migrations/remote',
          stdio: 'inherit',
        },
      );
      expect(spawmMock).toHaveBeenNthCalledWith(
        2,
        'docker',
        [
          'tag',
          'test-test1-20230510',
          `${accountId}.dkr.ecr.us-east-1.amazonaws.com/migrations:test-test1-20230510`,
        ],
        {
          cwd: 'dist/apps/test/src/migrations/remote',
          stdio: 'inherit',
        },
      );
      expect(cloudWatchLogsMock).not.toHaveReceivedCommand(
        CreateLogGroupCommand,
      );
      expect(ecsMock).not.toHaveReceivedCommand(RegisterTaskDefinitionCommand);
      expect(ecsMock).not.toHaveReceivedCommand(RunTaskCommand);
      expect(ecsMock).not.toHaveReceivedCommand(DescribeTasksCommand);
      expect(cloudWatchLogsMock).not.toHaveReceivedCommand(GetLogEventsCommand);
      expect(cloudWatchLogsMock).not.toHaveReceivedCommand(
        DeleteLogGroupCommand,
      );
      expect(ecsMock).not.toHaveReceivedCommand(
        DeregisterTaskDefinitionCommand,
      );
    });

    it('should throw an exception when docker push command returns exit code != 0', async () => {
      process.env.AWS_REGION = 'us-east-1';
      const stsMock = mockClient(STSClient);
      const ecrMock = mockClient(ECRClient);
      const ecsMock = mockClient(ECSClient);
      const cloudWatchLogsMock = mockClient(CloudWatchLogsClient);

      stsMock.on(GetCallerIdentityCommand).resolves({
        Account: accountId,
      });

      ecrMock.on(DescribeRepositoriesCommand).resolvesOnce({});

      spawmMock
        .mockReturnValueOnce({
          status: 0,
        })
        .mockReturnValueOnce({
          status: 0,
        })
        .mockReturnValueOnce({
          status: 9,
        });

      const runner = new EcsRemoteRunner(
        new CLILogger('info'),
        migrationBase as never,
      );

      await expect(runner.run()).rejects.toThrow(
        'Failed to push the docker image',
      );

      expect(stsMock).toHaveReceivedCommandTimes(GetCallerIdentityCommand, 1);
      expect(execSyncMock).toHaveBeenCalledTimes(2);
      expect(execSyncMock).toHaveBeenNthCalledWith(
        1,
        `aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws`,
        { stdio: 'inherit' },
      );
      expect(execSyncMock).toHaveBeenNthCalledWith(
        2,
        `aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin ${accountId}.dkr.ecr.us-east-1.amazonaws.com`,
        { stdio: 'inherit' },
      );
      expect(ecrMock).toHaveReceivedNthCommandWith(
        DescribeRepositoriesCommand,
        1,
        {
          repositoryNames: ['migrations'],
        },
      );
      expect(ecrMock).not.toHaveReceivedCommand(CreateRepositoryCommand);
      expect(mkdirSyncMock).toHaveBeenCalledWith(
        'dist/apps/test/src/migrations/remote',
        { recursive: true },
      );
      expect(copyFileSyncMock).toHaveBeenCalledWith(
        path.join(__dirname, 'Dockerfile'),
        'dist/apps/test/src/migrations/remote/Dockerfile',
      );

      expect(esbuildMock).toHaveBeenCalledTimes(2);
      expect(esbuildMock).toHaveBeenNthCalledWith(1, {
        format: 'cjs',
        bundle: true,
        minify: false,
        sourcemap: false,
        target: ['node18'],
        entryPoints: [path.join(__dirname, 'wrapper.ts')],
        outfile: 'dist/apps/test/src/migrations/remote/wrapper.js',
        platform: 'node',
      });
      expect(esbuildMock).toHaveBeenNthCalledWith(2, {
        format: 'cjs',
        bundle: true,
        minify: false,
        sourcemap: false,
        target: ['node18'],
        entryPoints: ['apps/test/src/migrations/20230510-test1.ts'],
        outfile: 'dist/apps/test/src/migrations/remote/migration.js',
        platform: 'node',
      });
      expect(spawmMock).toHaveBeenCalledTimes(3);
      expect(spawmMock).toHaveBeenNthCalledWith(
        1,
        'docker',
        ['build', '--platform=linux/amd64', '-t', 'test-test1-20230510', '.'],
        {
          cwd: 'dist/apps/test/src/migrations/remote',
          stdio: 'inherit',
        },
      );
      expect(spawmMock).toHaveBeenNthCalledWith(
        2,
        'docker',
        [
          'tag',
          'test-test1-20230510',
          `${accountId}.dkr.ecr.us-east-1.amazonaws.com/migrations:test-test1-20230510`,
        ],
        {
          cwd: 'dist/apps/test/src/migrations/remote',
          stdio: 'inherit',
        },
      );
      expect(spawmMock).toHaveBeenNthCalledWith(
        3,
        'docker',
        [
          'push',
          `${accountId}.dkr.ecr.us-east-1.amazonaws.com/migrations:test-test1-20230510`,
        ],
        {
          cwd: 'dist/apps/test/src/migrations/remote',
          stdio: 'inherit',
        },
      );
      expect(cloudWatchLogsMock).not.toHaveReceivedCommand(
        CreateLogGroupCommand,
      );
      expect(ecsMock).not.toHaveReceivedCommand(RegisterTaskDefinitionCommand);
      expect(ecsMock).not.toHaveReceivedCommand(RunTaskCommand);
      expect(ecsMock).not.toHaveReceivedCommand(DescribeTasksCommand);
      expect(cloudWatchLogsMock).not.toHaveReceivedCommand(GetLogEventsCommand);
      expect(cloudWatchLogsMock).not.toHaveReceivedCommand(
        DeleteLogGroupCommand,
      );
      expect(ecsMock).not.toHaveReceivedCommand(
        DeregisterTaskDefinitionCommand,
      );
    });

    it('should throw an exception when cloudwatch log group creation fails', async () => {
      process.env.AWS_REGION = 'us-east-1';
      const stsMock = mockClient(STSClient);
      const ecrMock = mockClient(ECRClient);
      const ecsMock = mockClient(ECSClient);
      const cloudWatchLogsMock = mockClient(CloudWatchLogsClient);

      stsMock.on(GetCallerIdentityCommand).resolves({
        Account: accountId,
      });

      ecrMock.on(DescribeRepositoriesCommand).resolvesOnce({});

      cloudWatchLogsMock
        .on(CreateLogGroupCommand)
        .rejectsOnce(new Error('fail'));

      spawmMock
        .mockReturnValueOnce({
          status: 0,
        })
        .mockReturnValueOnce({
          status: 0,
        })
        .mockReturnValueOnce({
          status: 0,
        });

      const runner = new EcsRemoteRunner(
        new CLILogger('info'),
        migrationBase as never,
      );

      await expect(runner.run()).rejects.toThrow('fail');

      expect(stsMock).toHaveReceivedCommandTimes(GetCallerIdentityCommand, 1);
      expect(execSyncMock).toHaveBeenCalledTimes(2);
      expect(execSyncMock).toHaveBeenNthCalledWith(
        1,
        `aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws`,
        { stdio: 'inherit' },
      );
      expect(execSyncMock).toHaveBeenNthCalledWith(
        2,
        `aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin ${accountId}.dkr.ecr.us-east-1.amazonaws.com`,
        { stdio: 'inherit' },
      );
      expect(ecrMock).toHaveReceivedNthCommandWith(
        DescribeRepositoriesCommand,
        1,
        {
          repositoryNames: ['migrations'],
        },
      );
      expect(ecrMock).not.toHaveReceivedCommand(CreateRepositoryCommand);
      expect(mkdirSyncMock).toHaveBeenCalledWith(
        'dist/apps/test/src/migrations/remote',
        { recursive: true },
      );
      expect(copyFileSyncMock).toHaveBeenCalledWith(
        path.join(__dirname, 'Dockerfile'),
        'dist/apps/test/src/migrations/remote/Dockerfile',
      );

      expect(esbuildMock).toHaveBeenCalledTimes(2);
      expect(esbuildMock).toHaveBeenNthCalledWith(1, {
        format: 'cjs',
        bundle: true,
        minify: false,
        sourcemap: false,
        target: ['node18'],
        entryPoints: [path.join(__dirname, 'wrapper.ts')],
        outfile: 'dist/apps/test/src/migrations/remote/wrapper.js',
        platform: 'node',
      });
      expect(esbuildMock).toHaveBeenNthCalledWith(2, {
        format: 'cjs',
        bundle: true,
        minify: false,
        sourcemap: false,
        target: ['node18'],
        entryPoints: ['apps/test/src/migrations/20230510-test1.ts'],
        outfile: 'dist/apps/test/src/migrations/remote/migration.js',
        platform: 'node',
      });
      expect(spawmMock).toHaveBeenCalledTimes(3);
      expect(spawmMock).toHaveBeenNthCalledWith(
        1,
        'docker',
        ['build', '--platform=linux/amd64', '-t', 'test-test1-20230510', '.'],
        {
          cwd: 'dist/apps/test/src/migrations/remote',
          stdio: 'inherit',
        },
      );
      expect(spawmMock).toHaveBeenNthCalledWith(
        2,
        'docker',
        [
          'tag',
          'test-test1-20230510',
          `${accountId}.dkr.ecr.us-east-1.amazonaws.com/migrations:test-test1-20230510`,
        ],
        {
          cwd: 'dist/apps/test/src/migrations/remote',
          stdio: 'inherit',
        },
      );
      expect(spawmMock).toHaveBeenNthCalledWith(
        3,
        'docker',
        [
          'push',
          `${accountId}.dkr.ecr.us-east-1.amazonaws.com/migrations:test-test1-20230510`,
        ],
        {
          cwd: 'dist/apps/test/src/migrations/remote',
          stdio: 'inherit',
        },
      );
      expect(cloudWatchLogsMock).toHaveReceivedNthCommandWith(
        CreateLogGroupCommand,
        1,
        {
          logGroupName: `/ecs/test/test1/20230510`,
          tags: {
            namespace: 'test',
            name: 'test1',
            version: '20230510',
            source: 'migration',
          },
        },
      );
      expect(ecsMock).not.toHaveReceivedCommand(RegisterTaskDefinitionCommand);
      expect(ecsMock).not.toHaveReceivedCommand(RunTaskCommand);
      expect(ecsMock).not.toHaveReceivedCommand(DescribeTasksCommand);
      expect(cloudWatchLogsMock).not.toHaveReceivedCommand(GetLogEventsCommand);
      expect(cloudWatchLogsMock).not.toHaveReceivedCommand(
        DeleteLogGroupCommand,
      );
      expect(ecsMock).not.toHaveReceivedCommand(
        DeregisterTaskDefinitionCommand,
      );
    });

    it('should throw an exception when ecs client returns 0 tasks after runTask operation', async () => {
      process.env.AWS_REGION = 'us-east-1';
      const stsMock = mockClient(STSClient);
      const ecrMock = mockClient(ECRClient);
      const ecsMock = mockClient(ECSClient);
      const cloudWatchLogsMock = mockClient(CloudWatchLogsClient);

      stsMock.on(GetCallerIdentityCommand).resolves({
        Account: accountId,
      });

      ecrMock.on(DescribeRepositoriesCommand).resolvesOnce({});

      spawmMock
        .mockReturnValueOnce({
          status: 0,
        })
        .mockReturnValueOnce({
          status: 0,
        })
        .mockReturnValueOnce({
          status: 0,
        });

      cloudWatchLogsMock
        .on(CreateLogGroupCommand)
        .rejectsOnce(new AwsErrorMock('ResourceAlreadyExistsException'));

      ecsMock.on(RegisterTaskDefinitionCommand).resolvesOnce({
        taskDefinition: {
          taskDefinitionArn:
            'arn:aws:ecs:us-east-1:123456789012:task-definition/test-test1-202305101:1',
        },
      });

      ecsMock.on(RunTaskCommand).resolvesOnce({
        tasks: [],
      });

      const runner = new EcsRemoteRunner(
        new CLILogger('info'),
        migrationBase as never,
      );

      await expect(runner.run()).rejects.toThrowError(
        'Failed to run migration test:test1:20230510: no tasks returned',
      );

      expect(stsMock).toHaveReceivedCommandTimes(GetCallerIdentityCommand, 1);
      expect(execSyncMock).toHaveBeenCalledTimes(2);
      expect(execSyncMock).toHaveBeenNthCalledWith(
        1,
        `aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws`,
        { stdio: 'inherit' },
      );
      expect(execSyncMock).toHaveBeenNthCalledWith(
        2,
        `aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin ${accountId}.dkr.ecr.us-east-1.amazonaws.com`,
        { stdio: 'inherit' },
      );
      expect(ecrMock).toHaveReceivedNthCommandWith(
        DescribeRepositoriesCommand,
        1,
        {
          repositoryNames: ['migrations'],
        },
      );
      expect(ecrMock).not.toHaveReceivedCommand(CreateRepositoryCommand);
      expect(mkdirSyncMock).toHaveBeenCalledWith(
        'dist/apps/test/src/migrations/remote',
        { recursive: true },
      );
      expect(copyFileSyncMock).toHaveBeenCalledWith(
        path.join(__dirname, 'Dockerfile'),
        'dist/apps/test/src/migrations/remote/Dockerfile',
      );

      expect(esbuildMock).toHaveBeenCalledTimes(2);
      expect(esbuildMock).toHaveBeenNthCalledWith(1, {
        format: 'cjs',
        bundle: true,
        minify: false,
        sourcemap: false,
        target: ['node18'],
        entryPoints: [path.join(__dirname, 'wrapper.ts')],
        outfile: 'dist/apps/test/src/migrations/remote/wrapper.js',
        platform: 'node',
      });
      expect(esbuildMock).toHaveBeenNthCalledWith(2, {
        format: 'cjs',
        bundle: true,
        minify: false,
        sourcemap: false,
        target: ['node18'],
        entryPoints: ['apps/test/src/migrations/20230510-test1.ts'],
        outfile: 'dist/apps/test/src/migrations/remote/migration.js',
        platform: 'node',
      });
      expect(spawmMock).toHaveBeenCalledTimes(3);
      expect(spawmMock).toHaveBeenNthCalledWith(
        1,
        'docker',
        ['build', '--platform=linux/amd64', '-t', 'test-test1-20230510', '.'],
        {
          cwd: 'dist/apps/test/src/migrations/remote',
          stdio: 'inherit',
        },
      );
      expect(spawmMock).toHaveBeenNthCalledWith(
        2,
        'docker',
        [
          'tag',
          'test-test1-20230510',
          `${accountId}.dkr.ecr.us-east-1.amazonaws.com/migrations:test-test1-20230510`,
        ],
        {
          cwd: 'dist/apps/test/src/migrations/remote',
          stdio: 'inherit',
        },
      );
      expect(spawmMock).toHaveBeenNthCalledWith(
        3,
        'docker',
        [
          'push',
          `${accountId}.dkr.ecr.us-east-1.amazonaws.com/migrations:test-test1-20230510`,
        ],
        {
          cwd: 'dist/apps/test/src/migrations/remote',
          stdio: 'inherit',
        },
      );
      expect(cloudWatchLogsMock).toHaveReceivedNthCommandWith(
        CreateLogGroupCommand,
        1,
        {
          logGroupName: `/ecs/test/test1/20230510`,
          tags: {
            namespace: 'test',
            name: 'test1',
            version: '20230510',
            source: 'migration',
          },
        },
      );

      expect(ecsMock).toHaveReceivedNthCommandWith(
        RegisterTaskDefinitionCommand,
        1,
        {
          containerDefinitions: [
            {
              environment: [
                {
                  name: 'LOG_LEVEL',
                  value: 'info',
                },
                {
                  name: 'ENV',
                  value: 'test',
                },
                {
                  name: 'MIGRATION_FILE_NAME',
                  value: 'migration.js',
                },
                {
                  name: 'OPERATION',
                  value: 'run',
                },
              ],
              image:
                '123456789012.dkr.ecr.us-east-1.amazonaws.com/migrations:test-test1-20230510',
              logConfiguration: {
                logDriver: 'awslogs',
                options: {
                  'awslogs-group': '/ecs/test/test1/20230510',
                  'awslogs-region': 'us-east-1',
                  'awslogs-stream-prefix': 'ecs',
                },
              },
              name: 'migration',
            },
          ],
          cpu: '1024',
          executionRoleArn:
            'arn:aws:iam::123456789012:role/ecsTaskExecutionRole',
          family: 'migration-test-test1-20230510-task',
          memory: '2048',
          networkMode: 'awsvpc',
          requiresCompatibilities: ['FARGATE'],
          taskRoleArn: 'arn:aws:iam::123456789012:role/ecsTaskRole',
        },
      );
      expect(ecsMock).toHaveReceivedNthCommandWith(RunTaskCommand, 1, {
        cluster: 'test-cluster',
        count: 1,
        launchType: 'FARGATE',
        networkConfiguration: {
          awsvpcConfiguration: {
            assignPublicIp: 'DISABLED',
            securityGroups: ['sg-1'],
            subnets: ['subnet-1', 'subnet-2'],
          },
        },
        startedBy: 'migration',
        taskDefinition:
          'arn:aws:ecs:us-east-1:123456789012:task-definition/test-test1-202305101:1',
      });
      expect(ecsMock).not.toHaveReceivedCommand(DescribeTasksCommand);
      expect(cloudWatchLogsMock).not.toHaveReceivedCommand(GetLogEventsCommand);
      expect(cloudWatchLogsMock).toHaveReceivedNthCommandWith(
        DeleteLogGroupCommand,
        1,
        {
          logGroupName: '/ecs/test/test1/20230510',
        },
      );
      expect(ecsMock).toHaveReceivedNthCommandWith(
        DeregisterTaskDefinitionCommand,
        1,
        {
          taskDefinition:
            'arn:aws:ecs:us-east-1:123456789012:task-definition/test-test1-202305101:1',
        },
      );
    });

    it('should throw an exeception when the ecs task return an exit code != 0', async () => {
      delete process.env.AWS_REGION;
      const stsMock = mockClient(STSClient);
      const ecrMock = mockClient(ECRClient);
      const ecsMock = mockClient(ECSClient);
      const cloudWatchLogsMock = mockClient(CloudWatchLogsClient);

      stsMock.on(GetCallerIdentityCommand).resolves({
        Account: accountId,
      });

      ecrMock
        .on(DescribeRepositoriesCommand)
        .rejectsOnce(new AwsErrorMock('RepositoryNotFoundException'));

      spawmMock
        .mockReturnValueOnce({
          status: 0,
        })
        .mockReturnValueOnce({
          status: 0,
        })
        .mockReturnValueOnce({
          status: 0,
        });

      ecsMock.on(RegisterTaskDefinitionCommand).resolvesOnce({
        taskDefinition: {
          taskDefinitionArn:
            'arn:aws:ecs:us-east-1:123456789012:task-definition/test-test1-202305101:1',
        },
      });

      ecsMock.on(RegisterTaskDefinitionCommand).resolvesOnce({
        taskDefinition: {
          taskDefinitionArn:
            'arn:aws:ecs:us-east-1:123456789012:task-definition/test-test1-202305101:1',
        },
      });

      ecsMock.on(RunTaskCommand).resolvesOnce({
        tasks: [
          {
            taskArn:
              'arn:aws:ecs:us-east-1:123456789012:task/test-test1-202305101',
          },
        ],
      });

      ecsMock
        .on(DescribeTasksCommand)
        .resolvesOnce({
          tasks: [
            {
              taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/abc123',
              lastStatus: 'PENDING',
              containers: [
                {
                  name: 'migration',
                  lastStatus: 'PENDING',
                  exitCode: 0,
                },
              ],
            },
          ],
        })
        .resolvesOnce({
          tasks: [
            {
              taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/abc123',
              lastStatus: 'STOPPED',
              containers: [
                {
                  name: 'migration',
                  lastStatus: 'STOPPED',
                  exitCode: 9,
                },
              ],
            },
          ],
        });

      cloudWatchLogsMock
        .on(GetLogEventsCommand)
        .rejectsOnce(new AwsErrorMock('ResourceNotFoundException'))
        .resolvesOnce({
          events: [
            {
              message: 'test2',
              timestamp: Date.now() + 2,
            },
          ],
        });

      const runner = new EcsRemoteRunner(
        new CLILogger('info'),
        migrationBase as never,
      );

      await expect(runner.run()).rejects.toThrowError(
        'task exited with non-zero exit code 9',
      );

      expect(stsMock).toHaveReceivedCommandTimes(GetCallerIdentityCommand, 1);
      expect(execSyncMock).toHaveBeenCalledTimes(2);
      expect(execSyncMock).toHaveBeenNthCalledWith(
        1,
        `aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws`,
        { stdio: 'inherit' },
      );
      expect(execSyncMock).toHaveBeenNthCalledWith(
        2,
        `aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin ${accountId}.dkr.ecr.us-east-1.amazonaws.com`,
        { stdio: 'inherit' },
      );
      expect(ecrMock).toHaveReceivedNthCommandWith(
        DescribeRepositoriesCommand,
        1,
        {
          repositoryNames: ['migrations'],
        },
      );
      expect(ecrMock).toHaveReceivedNthCommandWith(CreateRepositoryCommand, 1, {
        repositoryName: 'migrations',
      });
      expect(mkdirSyncMock).toHaveBeenCalledWith(
        'dist/apps/test/src/migrations/remote',
        { recursive: true },
      );
      expect(copyFileSyncMock).toHaveBeenCalledWith(
        path.join(__dirname, 'Dockerfile'),
        'dist/apps/test/src/migrations/remote/Dockerfile',
      );

      expect(esbuildMock).toHaveBeenCalledTimes(2);
      expect(esbuildMock).toHaveBeenNthCalledWith(1, {
        format: 'cjs',
        bundle: true,
        minify: false,
        sourcemap: false,
        target: ['node18'],
        entryPoints: [path.join(__dirname, 'wrapper.ts')],
        outfile: 'dist/apps/test/src/migrations/remote/wrapper.js',
        platform: 'node',
      });
      expect(esbuildMock).toHaveBeenNthCalledWith(2, {
        format: 'cjs',
        bundle: true,
        minify: false,
        sourcemap: false,
        target: ['node18'],
        entryPoints: ['apps/test/src/migrations/20230510-test1.ts'],
        outfile: 'dist/apps/test/src/migrations/remote/migration.js',
        platform: 'node',
      });

      expect(spawmMock).toHaveBeenCalledTimes(3);
      expect(spawmMock).toHaveBeenNthCalledWith(
        1,
        'docker',
        ['build', '--platform=linux/amd64', '-t', 'test-test1-20230510', '.'],
        {
          cwd: 'dist/apps/test/src/migrations/remote',
          stdio: 'inherit',
        },
      );
      expect(spawmMock).toHaveBeenNthCalledWith(
        2,
        'docker',
        [
          'tag',
          'test-test1-20230510',
          `${accountId}.dkr.ecr.us-east-1.amazonaws.com/migrations:test-test1-20230510`,
        ],
        {
          cwd: 'dist/apps/test/src/migrations/remote',
          stdio: 'inherit',
        },
      );
      expect(spawmMock).toHaveBeenNthCalledWith(
        3,
        'docker',
        [
          'push',
          `${accountId}.dkr.ecr.us-east-1.amazonaws.com/migrations:test-test1-20230510`,
        ],
        {
          cwd: 'dist/apps/test/src/migrations/remote',
          stdio: 'inherit',
        },
      );
      expect(cloudWatchLogsMock).toHaveReceivedNthCommandWith(
        CreateLogGroupCommand,
        1,
        {
          logGroupName: `/ecs/test/test1/20230510`,
          tags: {
            namespace: 'test',
            name: 'test1',
            version: '20230510',
            source: 'migration',
          },
        },
      );

      expect(ecsMock).toHaveReceivedNthCommandWith(
        RegisterTaskDefinitionCommand,
        1,
        {
          containerDefinitions: [
            {
              environment: [
                {
                  name: 'LOG_LEVEL',
                  value: 'info',
                },
                {
                  name: 'ENV',
                  value: 'test',
                },
                {
                  name: 'MIGRATION_FILE_NAME',
                  value: 'migration.js',
                },
                {
                  name: 'OPERATION',
                  value: 'run',
                },
              ],
              image:
                '123456789012.dkr.ecr.us-east-1.amazonaws.com/migrations:test-test1-20230510',
              logConfiguration: {
                logDriver: 'awslogs',
                options: {
                  'awslogs-group': '/ecs/test/test1/20230510',
                  'awslogs-region': 'us-east-1',
                  'awslogs-stream-prefix': 'ecs',
                },
              },
              name: 'migration',
            },
          ],
          cpu: '1024',
          executionRoleArn:
            'arn:aws:iam::123456789012:role/ecsTaskExecutionRole',
          family: 'migration-test-test1-20230510-task',
          memory: '2048',
          networkMode: 'awsvpc',
          requiresCompatibilities: ['FARGATE'],
          taskRoleArn: 'arn:aws:iam::123456789012:role/ecsTaskRole',
        },
      );
      expect(ecsMock).toHaveReceivedNthCommandWith(RunTaskCommand, 1, {
        cluster: 'test-cluster',
        count: 1,
        launchType: 'FARGATE',
        networkConfiguration: {
          awsvpcConfiguration: {
            assignPublicIp: 'DISABLED',
            securityGroups: ['sg-1'],
            subnets: ['subnet-1', 'subnet-2'],
          },
        },
        startedBy: 'migration',
        taskDefinition:
          'arn:aws:ecs:us-east-1:123456789012:task-definition/test-test1-202305101:1',
      });
      expect(ecsMock).toHaveReceivedNthCommandWith(DescribeTasksCommand, 1, {
        cluster: 'test-cluster',
        tasks: ['arn:aws:ecs:us-east-1:123456789012:task/test-test1-202305101'],
      });
      expect(ecsMock).toHaveReceivedNthCommandWith(DescribeTasksCommand, 2, {
        cluster: 'test-cluster',
        tasks: ['arn:aws:ecs:us-east-1:123456789012:task/test-test1-202305101'],
      });

      expect(cloudWatchLogsMock).toHaveReceivedNthCommandWith(
        GetLogEventsCommand,
        1,
        {
          endTime: Date.now(),
          logGroupName: '/ecs/test/test1/20230510',
          logStreamName: 'ecs/migration/abc123',
          startTime: Date.now(),
        },
      );
      expect(cloudWatchLogsMock).toHaveReceivedNthCommandWith(
        GetLogEventsCommand,
        2,
        {
          endTime: Date.now(),
          logGroupName: '/ecs/test/test1/20230510',
          logStreamName: 'ecs/migration/abc123',
          startTime: Date.now(),
        },
      );

      expect(cloudWatchLogsMock).toHaveReceivedNthCommandWith(
        DeleteLogGroupCommand,
        1,
        {
          logGroupName: '/ecs/test/test1/20230510',
        },
      );
      expect(ecsMock).toHaveReceivedNthCommandWith(
        DeregisterTaskDefinitionCommand,
        1,
        {
          taskDefinition:
            'arn:aws:ecs:us-east-1:123456789012:task-definition/test-test1-202305101:1',
        },
      );
    });

    it('should run the migration and not print any logs when the log events cannot be captured', async () => {
      delete process.env.AWS_REGION;
      const stsMock = mockClient(STSClient);
      const ecrMock = mockClient(ECRClient);
      const ecsMock = mockClient(ECSClient);
      const cloudWatchLogsMock = mockClient(CloudWatchLogsClient);

      stsMock.on(GetCallerIdentityCommand).resolves({
        Account: accountId,
      });

      ecrMock
        .on(DescribeRepositoriesCommand)
        .rejectsOnce(new AwsErrorMock('RepositoryNotFoundException'));

      spawmMock
        .mockReturnValueOnce({
          status: 0,
        })
        .mockReturnValueOnce({
          status: 0,
        })
        .mockReturnValueOnce({
          status: 0,
        });

      ecsMock.on(RegisterTaskDefinitionCommand).resolvesOnce({
        taskDefinition: {
          taskDefinitionArn:
            'arn:aws:ecs:us-east-1:123456789012:task-definition/test-test1-202305101:1',
        },
      });

      ecsMock.on(RunTaskCommand).resolvesOnce({
        tasks: [
          {
            taskArn:
              'arn:aws:ecs:us-east-1:123456789012:task/test-test1-202305101',
          },
        ],
      });

      ecsMock
        .on(DescribeTasksCommand)
        .resolvesOnce({
          tasks: [
            {
              taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/abc123',
              lastStatus: 'PENDING',
              containers: [
                {
                  name: 'migration',
                  lastStatus: 'PENDING',
                  exitCode: 0,
                },
              ],
            },
          ],
        })
        .resolvesOnce({
          tasks: [
            {
              taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/abc123',
              lastStatus: 'STOPPED',
              containers: [
                {
                  name: 'migration',
                  lastStatus: 'STOPPED',
                  exitCode: 0,
                },
              ],
            },
          ],
        });

      cloudWatchLogsMock
        .on(GetLogEventsCommand)
        .rejectsOnce(new Error('test'))
        .rejectsOnce(new Error('test'));

      const warnSpy = vi.spyOn(CLILogger.prototype, 'warn');

      const runner = new EcsRemoteRunner(
        new CLILogger('info'),
        migrationBase as never,
      );

      await runner.run();

      expect(stsMock).toHaveReceivedCommandTimes(GetCallerIdentityCommand, 1);
      expect(execSyncMock).toHaveBeenCalledTimes(2);
      expect(execSyncMock).toHaveBeenNthCalledWith(
        1,
        `aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws`,
        { stdio: 'inherit' },
      );
      expect(execSyncMock).toHaveBeenNthCalledWith(
        2,
        `aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin ${accountId}.dkr.ecr.us-east-1.amazonaws.com`,
        { stdio: 'inherit' },
      );
      expect(ecrMock).toHaveReceivedNthCommandWith(
        DescribeRepositoriesCommand,
        1,
        {
          repositoryNames: ['migrations'],
        },
      );
      expect(ecrMock).toHaveReceivedNthCommandWith(CreateRepositoryCommand, 1, {
        repositoryName: 'migrations',
      });
      expect(mkdirSyncMock).toHaveBeenCalledWith(
        'dist/apps/test/src/migrations/remote',
        { recursive: true },
      );
      expect(copyFileSyncMock).toHaveBeenCalledWith(
        path.join(__dirname, 'Dockerfile'),
        'dist/apps/test/src/migrations/remote/Dockerfile',
      );

      expect(esbuildMock).toHaveBeenCalledTimes(2);
      expect(esbuildMock).toHaveBeenNthCalledWith(1, {
        format: 'cjs',
        bundle: true,
        minify: false,
        sourcemap: false,
        target: ['node18'],
        entryPoints: [path.join(__dirname, 'wrapper.ts')],
        outfile: 'dist/apps/test/src/migrations/remote/wrapper.js',
        platform: 'node',
      });
      expect(esbuildMock).toHaveBeenNthCalledWith(2, {
        format: 'cjs',
        bundle: true,
        minify: false,
        sourcemap: false,
        target: ['node18'],
        entryPoints: ['apps/test/src/migrations/20230510-test1.ts'],
        outfile: 'dist/apps/test/src/migrations/remote/migration.js',
        platform: 'node',
      });

      expect(spawmMock).toHaveBeenCalledTimes(3);
      expect(spawmMock).toHaveBeenNthCalledWith(
        1,
        'docker',
        ['build', '--platform=linux/amd64', '-t', 'test-test1-20230510', '.'],
        {
          cwd: 'dist/apps/test/src/migrations/remote',
          stdio: 'inherit',
        },
      );
      expect(spawmMock).toHaveBeenNthCalledWith(
        2,
        'docker',
        [
          'tag',
          'test-test1-20230510',
          `${accountId}.dkr.ecr.us-east-1.amazonaws.com/migrations:test-test1-20230510`,
        ],
        {
          cwd: 'dist/apps/test/src/migrations/remote',
          stdio: 'inherit',
        },
      );
      expect(spawmMock).toHaveBeenNthCalledWith(
        3,
        'docker',
        [
          'push',
          `${accountId}.dkr.ecr.us-east-1.amazonaws.com/migrations:test-test1-20230510`,
        ],
        {
          cwd: 'dist/apps/test/src/migrations/remote',
          stdio: 'inherit',
        },
      );
      expect(cloudWatchLogsMock).toHaveReceivedNthCommandWith(
        CreateLogGroupCommand,
        1,
        {
          logGroupName: `/ecs/test/test1/20230510`,
          tags: {
            namespace: 'test',
            name: 'test1',
            version: '20230510',
            source: 'migration',
          },
        },
      );

      expect(ecsMock).toHaveReceivedNthCommandWith(
        RegisterTaskDefinitionCommand,
        1,
        {
          containerDefinitions: [
            {
              environment: [
                {
                  name: 'LOG_LEVEL',
                  value: 'info',
                },
                {
                  name: 'ENV',
                  value: 'test',
                },
                {
                  name: 'MIGRATION_FILE_NAME',
                  value: 'migration.js',
                },
                {
                  name: 'OPERATION',
                  value: 'run',
                },
              ],
              image:
                '123456789012.dkr.ecr.us-east-1.amazonaws.com/migrations:test-test1-20230510',
              logConfiguration: {
                logDriver: 'awslogs',
                options: {
                  'awslogs-group': '/ecs/test/test1/20230510',
                  'awslogs-region': 'us-east-1',
                  'awslogs-stream-prefix': 'ecs',
                },
              },
              name: 'migration',
            },
          ],
          cpu: '1024',
          executionRoleArn:
            'arn:aws:iam::123456789012:role/ecsTaskExecutionRole',
          family: 'migration-test-test1-20230510-task',
          memory: '2048',
          networkMode: 'awsvpc',
          requiresCompatibilities: ['FARGATE'],
          taskRoleArn: 'arn:aws:iam::123456789012:role/ecsTaskRole',
        },
      );
      expect(ecsMock).toHaveReceivedNthCommandWith(RunTaskCommand, 1, {
        cluster: 'test-cluster',
        count: 1,
        launchType: 'FARGATE',
        networkConfiguration: {
          awsvpcConfiguration: {
            assignPublicIp: 'DISABLED',
            securityGroups: ['sg-1'],
            subnets: ['subnet-1', 'subnet-2'],
          },
        },
        startedBy: 'migration',
        taskDefinition:
          'arn:aws:ecs:us-east-1:123456789012:task-definition/test-test1-202305101:1',
      });
      expect(ecsMock).toHaveReceivedNthCommandWith(DescribeTasksCommand, 1, {
        cluster: 'test-cluster',
        tasks: ['arn:aws:ecs:us-east-1:123456789012:task/test-test1-202305101'],
      });
      expect(ecsMock).toHaveReceivedNthCommandWith(DescribeTasksCommand, 2, {
        cluster: 'test-cluster',
        tasks: ['arn:aws:ecs:us-east-1:123456789012:task/test-test1-202305101'],
      });

      expect(cloudWatchLogsMock).toHaveReceivedNthCommandWith(
        GetLogEventsCommand,
        1,
        {
          endTime: Date.now(),
          logGroupName: '/ecs/test/test1/20230510',
          logStreamName: 'ecs/migration/abc123',
          startTime: Date.now(),
        },
      );
      expect(cloudWatchLogsMock).toHaveReceivedNthCommandWith(
        GetLogEventsCommand,
        2,
        {
          endTime: Date.now(),
          logGroupName: '/ecs/test/test1/20230510',
          logStreamName: 'ecs/migration/abc123',
          startTime: Date.now(),
        },
      );
      expect(warnSpy).toHaveBeenCalledTimes(2);

      expect(cloudWatchLogsMock).toHaveReceivedNthCommandWith(
        DeleteLogGroupCommand,
        1,
        {
          logGroupName: '/ecs/test/test1/20230510',
        },
      );
      expect(ecsMock).toHaveReceivedNthCommandWith(
        DeregisterTaskDefinitionCommand,
        1,
        {
          taskDefinition:
            'arn:aws:ecs:us-east-1:123456789012:task-definition/test-test1-202305101:1',
        },
      );
    });
  });
});
