import { vi, MockInstance } from 'vitest';
import chalk from 'chalk';
import '../../utils/mocks/cross-spawn.mock';
import * as poetryUtils from '../utils/poetry';
import fsMock from 'mock-fs';
import executor from './executor';
import spawn from 'cross-spawn';

describe('Ruff Check Executor', () => {
  let checkPoetryExecutableMock: MockInstance;
  let activateVenvMock: MockInstance;

  beforeEach(() => {
    checkPoetryExecutableMock = vi
      .spyOn(poetryUtils, 'checkPoetryExecutable')
      .mockResolvedValue(undefined);

    activateVenvMock = vi
      .spyOn(poetryUtils, 'activateVenv')
      .mockReturnValue(undefined);

    vi.mocked(spawn.sync).mockReturnValue({
      status: 0,
      output: [''],
      pid: 0,
      signal: null,
      stderr: null,
      stdout: null,
    });
    vi.spyOn(process, 'chdir').mockReturnValue(undefined);
  });

  beforeAll(() => {
    console.log(chalk`init chalk`);
  });

  afterEach(() => {
    fsMock.restore();
    vi.resetAllMocks();
  });

  it('should return success false when the poetry is not installed', async () => {
    checkPoetryExecutableMock.mockRejectedValue(new Error('poetry not found'));

    const options = {
      lintFilePatterns: ['app'],
      __unparsed__: [],
    };

    const context = {
      cwd: '',
      root: '.',
      isVerbose: false,
      projectName: 'app',
      workspace: {
        version: 2,
        projects: {
          app: {
            root: 'apps/app',
            targets: {},
          },
        },
      },
    };

    const output = await executor(options, context);
    expect(checkPoetryExecutableMock).toHaveBeenCalled();
    expect(activateVenvMock).toHaveBeenCalledWith('.');
    expect(spawn.sync).not.toHaveBeenCalled();
    expect(output.success).toBe(false);
  });

  it('should execute ruff check linting', async () => {
    vi.mocked(spawn.sync).mockReturnValueOnce({
      status: 0,
      output: [''],
      pid: 0,
      signal: null,
      stderr: null,
      stdout: null,
    });

    const output = await executor(
      {
        lintFilePatterns: ['app'],
        __unparsed__: [],
      },
      {
        cwd: '',
        root: '.',
        isVerbose: false,
        projectName: 'app',
        workspace: {
          version: 2,
          projects: {
            app: {
              root: 'apps/app',
              targets: {},
            },
          },
        },
      },
    );
    expect(checkPoetryExecutableMock).toHaveBeenCalled();
    expect(activateVenvMock).toHaveBeenCalledWith('.');
    expect(spawn.sync).toHaveBeenCalledTimes(1);
    expect(spawn.sync).toHaveBeenCalledWith('poetry run ruff check app', {
      cwd: 'apps/app',
      shell: true,
      stdio: 'inherit',
    });
    expect(output.success).toBe(true);
  });

  it('should fail to execute ruff check linting ', async () => {
    vi.mocked(spawn.sync).mockReturnValueOnce({
      status: 1,
      output: [''],
      pid: 0,
      signal: null,
      stderr: null,
      stdout: null,
    });

    const output = await executor(
      {
        lintFilePatterns: ['app'],
        __unparsed__: [],
      },
      {
        cwd: '',
        root: '.',
        isVerbose: false,
        projectName: 'app',
        workspace: {
          version: 2,
          projects: {
            app: {
              root: 'apps/app',
              targets: {},
            },
          },
        },
      },
    );
    expect(checkPoetryExecutableMock).toHaveBeenCalled();
    expect(activateVenvMock).toHaveBeenCalledWith('.');
    expect(spawn.sync).toHaveBeenCalledTimes(1);
    expect(spawn.sync).toHaveBeenCalledWith('poetry run ruff check app', {
      cwd: 'apps/app',
      shell: true,
      stdio: 'inherit',
    });
    expect(output.success).toBe(false);
  });
});
