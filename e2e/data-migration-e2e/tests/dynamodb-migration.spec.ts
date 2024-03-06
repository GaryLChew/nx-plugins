import {
  checkFilesExist,
  ensureNxProject,
  readJson,
  runNxCommandAsync,
  uniq,
} from '@nx/plugin/testing';

describe('dynamodb-migration e2e', () => {
  // Setting up individual workspaces per
  // test can cause e2e runs to take a long time.
  // For this reason, we recommend each suite only
  // consumes 1 workspace. The tests should each operate
  // on a unique project in the workspace, such that they
  // are not dependant on one another.
  beforeAll(() => {
    ensureNxProject('@nxlv/data-migration', 'dist/packages/dynamodb-migration');
  });

  afterAll(() => {
    // `nx reset` kills the daemon, and performs
    // some work which can help clean up e2e leftovers
    runNxCommandAsync('reset');
  });

  it('should create dynamodb-migration', async () => {
    const project = uniq('dynamodb-migration');
    await runNxCommandAsync(
      `generate @nxlv/data-migration:dynamodb-migration ${project}`,
    );
    const result = await runNxCommandAsync(`build ${project}`);
    expect(result.stdout).toContain('Executor ran');
  }, 120000);

  describe('--directory', () => {
    it('should create src in the specified directory', async () => {
      const project = uniq('dynamodb-migration');
      await runNxCommandAsync(
        `generate @nxlv/data-migration:dynamodb-migration ${project} --directory subdir`,
      );
      expect(() =>
        checkFilesExist(`libs/subdir/${project}/src/index.ts`),
      ).not.toThrow();
    }, 120000);
  });

  describe('--tags', () => {
    it('should add tags to the project', async () => {
      const projectName = uniq('dynamodb-migration');
      ensureNxProject(
        '@nxlv/data-migration',
        'dist/packages/dynamodb-migration',
      );
      await runNxCommandAsync(
        `generate @nxlv/data-migration:dynamodb-migration ${projectName} --tags e2etag,e2ePackage`,
      );
      const project = readJson(`libs/${projectName}/project.json`);
      expect(project.tags).toEqual(['e2etag', 'e2ePackage']);
    }, 120000);
  });
});
