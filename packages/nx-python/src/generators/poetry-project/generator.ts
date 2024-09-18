import {
  addProjectConfiguration,
  formatFiles,
  generateFiles,
  getWorkspaceLayout,
  names,
  offsetFromRoot,
  ProjectConfiguration,
  readProjectConfiguration,
  Tree,
} from '@nx/devkit';
import * as path from 'path';
import { PoetryProjectGeneratorSchema } from './schema';
import { checkPoetryExecutable, runPoetry } from '../../executors/utils/poetry';
import {
  PyprojectToml,
  PyprojectTomlDependencies,
} from '../../graph/dependency-graph';
import { parse, stringify } from '@iarna/toml';
import chalk from 'chalk';
import _ from 'lodash';

interface NormalizedSchema extends PoetryProjectGeneratorSchema {
  projectName: string;
  projectRoot: string;
  individualPackage: boolean;
  devDependenciesProjectPath?: string;
  devDependenciesProjectPkgName?: string;
  pythonAddopts?: string;
  parsedTags: string[];
}

function normalizeOptions(
  tree: Tree,
  options: PoetryProjectGeneratorSchema,
): NormalizedSchema {
  const { projectName, projectRoot } = calculateProjectNameAndRoot(
    options,
    tree,
  );

  const parsedTags = options.tags
    ? options.tags.split(',').map((s) => s.trim())
    : [];

  const newOptions = _.clone(options) as NormalizedSchema;

  if (!options.pyprojectPythonDependency) {
    newOptions.pyprojectPythonDependency = '>=3.9,<3.11';
  }

  if (!options.pyenvPythonVersion) {
    newOptions.pyenvPythonVersion = '3.9.5';
  }

  if (!options.moduleName) {
    newOptions.moduleName = projectName.replace(/-/g, '_');
  }

  if (!options.packageName) {
    newOptions.packageName = projectName;
  }

  if (!options.description) {
    newOptions.description = 'Automatically generated by Nx.';
  }
  if (options.devDependenciesProject) {
    const projectConfig = readProjectConfiguration(
      tree,
      options.devDependenciesProject,
    );
    newOptions.devDependenciesProjectPath = path.relative(
      projectRoot,
      projectConfig.root,
    );
  }

  const pythonAddopts = getPyTestAddopts(options, projectRoot);

  if (options.unitTestRunner === 'none') {
    newOptions.unitTestHtmlReport = false;
    newOptions.unitTestJUnitReport = false;
    newOptions.codeCoverage = false;
    newOptions.codeCoverageHtmlReport = false;
    newOptions.codeCoverageXmlReport = false;
    newOptions.codeCoverageThreshold = undefined;
  }

  let devDependenciesProjectPkgName: string | undefined;
  if (options.devDependenciesProject) {
    const { pyprojectToml } = getPyprojectTomlByProjectName(
      tree,
      options.devDependenciesProject,
    );
    devDependenciesProjectPkgName = pyprojectToml.tool.poetry.name;
  }

  return {
    ...options,
    ...newOptions,
    devDependenciesProject: options.devDependenciesProject || '',
    individualPackage: !tree.exists('pyproject.toml'),
    devDependenciesProjectPkgName,
    pythonAddopts,
    projectName,
    projectRoot,
    parsedTags,
  };
}

function calculateProjectNameAndRoot(
  options: PoetryProjectGeneratorSchema,
  tree: Tree,
) {
  let projectName = options.name;
  let projectRoot = options.directory || options.name;

  if (options.projectNameAndRootFormat === 'derived') {
    const name = names(options.name).fileName;
    const projectDirectory = options.directory
      ? `${names(options.directory).fileName}/${name}`
      : name;
    projectName = projectDirectory.replace(/\//g, '-');
    projectRoot = `${
      options.projectType === 'application'
        ? getWorkspaceLayout(tree).appsDir
        : getWorkspaceLayout(tree).libsDir
    }/${projectDirectory}`;
  }

  return { projectName, projectRoot };
}

function getPyTestAddopts(
  options: PoetryProjectGeneratorSchema,
  projectRoot: string,
): string | undefined {
  if (options.unitTestRunner === 'pytest') {
    const args = [];
    const offset = offsetFromRoot(projectRoot);
    if (options.codeCoverage) {
      args.push('--cov');
    }
    if (options.codeCoverageThreshold) {
      args.push(`--cov-fail-under=${options.codeCoverageThreshold}`);
    }
    if (options.codeCoverage && options.codeCoverageHtmlReport) {
      args.push(`--cov-report html:'${offset}coverage/${projectRoot}/html'`);
    }

    if (options.codeCoverage && options.codeCoverageXmlReport) {
      args.push(
        `--cov-report xml:'${offset}coverage/${projectRoot}/coverage.xml'`,
      );
    }

    if (options.unitTestHtmlReport) {
      args.push(
        `--html='${offset}reports/${projectRoot}/unittests/html/index.html'`,
      );
    }

    if (options.unitTestJUnitReport) {
      args.push(
        `--junitxml='${offset}reports/${projectRoot}/unittests/junit.xml'`,
      );
    }

    return args.join(' ');
  }
}

function addFiles(tree: Tree, options: NormalizedSchema) {
  const templateOptions = {
    ...options,
    ...names(options.name),
    offsetFromRoot: offsetFromRoot(options.projectRoot),
    template: '',
    dot: '.',
  };
  if (options.templateDir) {
    generateFiles(
      tree,
      path.join(options.templateDir),
      options.projectRoot,
      templateOptions,
    );
    return;
  }

  generateFiles(
    tree,
    path.join(__dirname, 'files', 'base'),
    options.projectRoot,
    templateOptions,
  );

  if (options.unitTestRunner === 'pytest') {
    generateFiles(
      tree,
      path.join(__dirname, 'files', 'pytest'),
      options.projectRoot,
      templateOptions,
    );
  }

  if (options.linter === 'flake8') {
    generateFiles(
      tree,
      path.join(__dirname, 'files', 'flake8'),
      options.projectRoot,
      templateOptions,
    );
  }
}

function updateRootPyprojectToml(
  host: Tree,
  normalizedOptions: NormalizedSchema,
) {
  if (!normalizedOptions.individualPackage) {
    const rootPyprojectToml = parse(
      host.read('./pyproject.toml', 'utf-8'),
    ) as PyprojectToml;

    const group = normalizedOptions.rootPyprojectDependencyGroup ?? 'main';

    if (group === 'main') {
      rootPyprojectToml.tool.poetry.dependencies[
        normalizedOptions.packageName
      ] = {
        path: normalizedOptions.projectRoot,
        develop: true,
      };
    } else {
      rootPyprojectToml.tool.poetry.group = {
        ...(rootPyprojectToml.tool.poetry.group || {}),
        [group]: {
          ...(rootPyprojectToml.tool.poetry.group?.[group] || {}),
          dependencies: {
            ...(rootPyprojectToml.tool.poetry.group?.[group]?.dependencies ||
              {}),
            [normalizedOptions.packageName]: {
              path: normalizedOptions.projectRoot,
              develop: true,
            },
          },
        },
      };
    }

    if (!normalizedOptions.devDependenciesProject) {
      const { changed, dependencies } = addTestDependencies(
        rootPyprojectToml.tool.poetry.group?.dev?.dependencies || {},
        normalizedOptions,
      );

      if (changed) {
        rootPyprojectToml.tool.poetry.group = {
          ...(rootPyprojectToml.tool.poetry.group || {}),
          dev: {
            dependencies: dependencies,
          },
        };
      }
    }

    host.write('./pyproject.toml', stringify(rootPyprojectToml));
  }
}

function updateDevDependenciesProject(
  host: Tree,
  normalizedOptions: NormalizedSchema,
) {
  if (normalizedOptions.devDependenciesProject) {
    const { pyprojectToml, pyprojectTomlPath } = getPyprojectTomlByProjectName(
      host,
      normalizedOptions.devDependenciesProject,
    );

    const { changed, dependencies } = addTestDependencies(
      pyprojectToml.tool.poetry.dependencies,
      normalizedOptions,
    );

    if (changed) {
      pyprojectToml.tool.poetry.dependencies = {
        ...pyprojectToml.tool.poetry.dependencies,
        ...dependencies,
      };

      host.write(pyprojectTomlPath, stringify(pyprojectToml));
    }
  }
}

function getPyprojectTomlByProjectName(host: Tree, projectName: string) {
  const projectConfig = readProjectConfiguration(host, projectName);
  const pyprojectTomlPath = path.join(projectConfig.root, 'pyproject.toml');

  const pyprojectToml = parse(
    host.read(pyprojectTomlPath, 'utf-8'),
  ) as PyprojectToml;

  return { pyprojectToml, pyprojectTomlPath };
}

function addTestDependencies(
  dependencies: PyprojectTomlDependencies,
  normalizedOptions: NormalizedSchema,
) {
  const originalDependencies = _.clone(dependencies);

  if (normalizedOptions.linter === 'flake8' && !dependencies['flake8']) {
    dependencies['flake8'] = '6.0.0';
  }

  if (normalizedOptions.linter === 'ruff' && !dependencies['ruff']) {
    dependencies['ruff'] = '0.1.5';
  }

  if (!dependencies['autopep8']) {
    dependencies['autopep8'] = '2.0.2';
  }

  if (
    normalizedOptions.unitTestRunner === 'pytest' &&
    !dependencies['pytest']
  ) {
    dependencies['pytest'] = '7.3.1';
  }
  if (
    normalizedOptions.unitTestRunner === 'pytest' &&
    !dependencies['pytest-sugar']
  ) {
    dependencies['pytest-sugar'] = '0.9.7';
  }

  if (
    normalizedOptions.unitTestRunner === 'pytest' &&
    normalizedOptions.codeCoverage &&
    !dependencies['pytest-cov']
  ) {
    dependencies['pytest-cov'] = '4.1.0';
  }

  if (
    normalizedOptions.unitTestRunner === 'pytest' &&
    normalizedOptions.codeCoverageHtmlReport &&
    !dependencies['pytest-html']
  ) {
    dependencies['pytest-html'] = '3.2.0';
  }

  return {
    changed: !_.isEqual(originalDependencies, dependencies),
    dependencies,
  };
}

function updateRootPoetryLock(host: Tree) {
  if (host.exists('./pyproject.toml')) {
    console.log(chalk`  Updating root {bgBlue poetry.lock}...`);
    runPoetry(['lock', '--no-update'], { log: false });
    runPoetry(['install']);
    console.log(chalk`\n  {bgBlue poetry.lock} updated.\n`);
  }
}

export default async function (
  tree: Tree,
  options: PoetryProjectGeneratorSchema,
) {
  await checkPoetryExecutable();

  const normalizedOptions = normalizeOptions(tree, options);

  const targets: ProjectConfiguration['targets'] = {
    lock: {
      executor: '@nxlv/python:run-commands',
      options: {
        command: 'poetry lock --no-update',
        cwd: normalizedOptions.projectRoot,
      },
    },
    add: {
      executor: '@nxlv/python:add',
      options: {},
    },
    update: {
      executor: '@nxlv/python:update',
      options: {},
    },
    remove: {
      executor: '@nxlv/python:remove',
      options: {},
    },
    build: {
      executor: '@nxlv/python:build',
      outputs: ['{projectRoot}/dist'],
      options: {
        outputPath: `${normalizedOptions.projectRoot}/dist`,
        publish: normalizedOptions.publishable,
        lockedVersions: normalizedOptions.buildLockedVersions,
        bundleLocalDependencies: normalizedOptions.buildBundleLocalDependencies,
      },
    },
    install: {
      executor: '@nxlv/python:install',
      options: {
        silent: false,
        args: '',
        cacheDir: `.cache/pypoetry`,
        verbose: false,
        debug: false,
      },
    },
  };

  if (options.linter === 'flake8') {
    targets.lint = {
      executor: '@nxlv/python:flake8',
      outputs: [
        `{workspaceRoot}/reports/${normalizedOptions.projectRoot}/pylint.txt`,
      ],
      options: {
        outputFile: `reports/${normalizedOptions.projectRoot}/pylint.txt`,
      },
    };
  }

  if (options.linter === 'ruff') {
    targets.lint = {
      executor: '@nxlv/python:ruff-check',
      outputs: [],
      options: {
        lintFilePatterns: [normalizedOptions.moduleName].concat(
          options.unitTestRunner === 'pytest' ? ['tests'] : [],
        ),
      },
    };
  }

  if (options.unitTestRunner === 'pytest') {
    targets.test = {
      executor: '@nxlv/python:run-commands',
      outputs: [
        `{workspaceRoot}/reports/${normalizedOptions.projectRoot}/unittests`,
        `{workspaceRoot}/coverage/${normalizedOptions.projectRoot}`,
      ],
      options: {
        command: `poetry run pytest tests/`,
        cwd: normalizedOptions.projectRoot,
      },
    };
  }

  const projectConfiguration: ProjectConfiguration = {
    root: normalizedOptions.projectRoot,
    projectType: normalizedOptions.projectType,
    sourceRoot: `${normalizedOptions.projectRoot}/${normalizedOptions.moduleName}`,
    targets,
    tags: normalizedOptions.parsedTags,
  };

  if (normalizedOptions.publishable) {
    projectConfiguration.targets ??= {};
    projectConfiguration.targets['nx-release-publish'] = {
      executor: '@nxlv/python:publish',
      options: {},
      outputs: [],
    };
  }

  projectConfiguration.release = {
    version: {
      generator: '@nxlv/python:release-version',
    },
  };

  addProjectConfiguration(
    tree,
    normalizedOptions.projectName,
    projectConfiguration,
  );

  addFiles(tree, normalizedOptions);
  updateDevDependenciesProject(tree, normalizedOptions);
  updateRootPyprojectToml(tree, normalizedOptions);
  await formatFiles(tree);

  return () => {
    updateRootPoetryLock(tree);
  };
}
