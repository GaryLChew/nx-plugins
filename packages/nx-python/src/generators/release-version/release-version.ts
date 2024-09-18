import {
  ProjectGraphProjectNode,
  Tree,
  formatFiles,
  joinPathFragments,
  output,
} from '@nx/devkit';
import chalk from 'chalk';
import { exec } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { IMPLICIT_DEFAULT_RELEASE_GROUP } from 'nx/src/command-line/release/config/config';
import {
  GroupVersionPlan,
  ProjectsVersionPlan,
} from 'nx/src/command-line/release/config/version-plans';
import {
  getFirstGitCommit,
  getLatestGitTagForPattern,
} from 'nx/src/command-line/release/utils/git';
import {
  resolveSemverSpecifierFromConventionalCommits,
  resolveSemverSpecifierFromPrompt,
} from 'nx/src/command-line/release/utils/resolve-semver-specifier';
import { isValidSemverSpecifier } from 'nx/src/command-line/release/utils/semver';
import {
  ReleaseVersionGeneratorResult,
  VersionData,
  deriveNewSemverVersion,
  validReleaseVersionPrefixes,
} from 'nx/src/command-line/release/version';
import { interpolate } from 'nx/src/tasks-runner/utils';
import ora from 'ora';
import { ReleaseType, gt, inc, prerelease } from 'semver';
import { ReleaseVersionGeneratorSchema } from './schema';
import {
  LocalPackageDependency,
  resolveLocalPackageDependencies,
} from './utils/resolve-local-package-dependencies';
import { sortProjectsTopologically } from './utils/sort-projects-topologically';
import {
  readPyprojectToml,
  runPoetry,
  writePyprojectToml,
} from '../../executors/utils/poetry';
import { extractDependencyVersion } from './utils/package';
import path, { dirname } from 'node:path';

export async function releaseVersionGenerator(
  tree: Tree,
  options: ReleaseVersionGeneratorSchema,
): Promise<ReleaseVersionGeneratorResult> {
  let logger: ProjectLogger | undefined;

  const poetryLocks: string[] = [];

  try {
    const versionData: VersionData = {};

    // If the user provided a specifier, validate that it is valid semver or a relative semver keyword
    if (options.specifier) {
      if (!isValidSemverSpecifier(options.specifier)) {
        throw new Error(
          `The given version specifier "${options.specifier}" is not valid. You provide an exact version or a valid semver keyword such as "major", "minor", "patch", etc.`,
        );
      }
      // The node semver library classes a leading `v` as valid, but we want to ensure it is not present in the final version
      options.specifier = options.specifier.replace(/^v/, '');
    }

    if (
      options.versionPrefix &&
      validReleaseVersionPrefixes.indexOf(options.versionPrefix) === -1
    ) {
      throw new Error(
        `Invalid value for version.generatorOptions.versionPrefix: "${
          options.versionPrefix
        }"

Valid values are: ${validReleaseVersionPrefixes
          .map((s) => `"${s}"`)
          .join(', ')}`,
      );
    }

    if (options.firstRelease) {
      // always use disk as a fallback for the first release
      options.fallbackCurrentVersionResolver = 'disk';
    }

    // Set default for updateDependents
    const updateDependents = options.updateDependents ?? 'never';
    const updateDependentsBump = 'patch';

    // Sort the projects topologically if update dependents is enabled
    // TODO: maybe move this sorting to the command level?
    const projects =
      updateDependents === 'never'
        ? options.projects
        : sortProjectsTopologically(options.projectGraph, options.projects);
    const projectToDependencyBumps = new Map<string, Set<unknown>>();

    const resolvePackageRoot = createResolvePackageRoot(options.packageRoot);

    // Resolve any custom package roots for each project upfront as they will need to be reused during dependency resolution
    const projectNameToPackageRootMap = new Map<string, string>();
    for (const project of projects) {
      projectNameToPackageRootMap.set(
        project.name,
        resolvePackageRoot(project),
      );
    }

    let currentVersion: string | undefined = undefined;
    let currentVersionResolvedFromFallback = false;

    // only used for options.currentVersionResolver === 'git-tag', but
    // must be declared here in order to reuse it for additional projects
    let latestMatchingGitTag:
      | { tag: string; extractedVersion: string }
      | null
      | undefined = undefined;

    // if specifier is undefined, then we haven't resolved it yet
    // if specifier is null, then it has been resolved and no changes are necessary
    let specifier: string | null | undefined = options.specifier
      ? options.specifier
      : undefined;

    const deleteVersionPlanCallbacks: ((
      dryRun?: boolean,
    ) => Promise<string[]>)[] = [];

    // If the user has set the logUnchangedProjects option to false, we will not print any logs for projects that have no changes.
    const logUnchangedProjects = options.logUnchangedProjects ?? true;

    for (const project of projects) {
      const projectName = project.name;
      const packageRoot = projectNameToPackageRootMap.get(projectName);
      if (!packageRoot) {
        throw new Error(
          `The project "${projectName}" does not have a packageRoot available. Please report this issue on https://github.com/nrwl/nx`,
        );
      }

      const pyprojectTomlPath = joinPathFragments(
        packageRoot,
        'pyproject.toml',
      );
      if (!tree.exists(pyprojectTomlPath)) {
        throw new Error(
          `The project "${projectName}" does not have a pyproject.toml available at ${pyprojectTomlPath}.

To fix this you will either need to add a pyproject.toml file at that location, or configure "release" within your nx.json to exclude "${projectName}" from the current release group, or amend the packageRoot configuration to point to where the pyproject.toml should be.`,
        );
      }

      const color = getColor(projectName);
      logger = new ProjectLogger(projectName, color);

      const pyprojectToml = readPyprojectToml(tree, pyprojectTomlPath);
      logger.buffer(
        `🔍 Reading data for package "${pyprojectToml.tool.poetry.name}" from ${pyprojectTomlPath}`,
      );

      const { name: packageName, version: currentVersionFromDisk } =
        pyprojectToml.tool.poetry;

      switch (options.currentVersionResolver) {
        case 'registry': {
          /**
           * If the currentVersionResolver is set to registry, and the projects are not independent, we only want to make the request once for the whole batch of projects.
           * For independent projects, we need to make a request for each project individually as they will most likely have different versions.
           */
          if (
            !currentVersion ||
            options.releaseGroup.projectsRelationship === 'independent'
          ) {
            const spinner = ora(
              `${Array.from(new Array(projectName.length + 3)).join(
                ' ',
              )}Resolving the current version from pip registry`,
            );
            spinner.color =
              color.spinnerColor as (typeof colors)[number]['spinnerColor'];
            spinner.start();

            try {
              // Must be non-blocking async to allow spinner to render
              currentVersion = await new Promise<string>((resolve, reject) => {
                exec(
                  `pip index versions ${packageName}`,
                  (error, stdout, stderr) => {
                    if (error) {
                      return reject(error);
                    }
                    if (stderr) {
                      return reject(stderr);
                    }
                    return resolve(
                      stdout
                        .trim()
                        .match(new RegExp(`${packageName} \\((.*)\\)`))[1],
                    );
                  },
                );
              });

              spinner.stop();

              logger.buffer(
                `📄 Resolved the current version as ${currentVersion} from pip registry`,
              );
            } catch (e) {
              spinner.stop();

              if (options.fallbackCurrentVersionResolver === 'disk') {
                logger.buffer(
                  `📄 Unable to resolve the current version from pip registry. Falling back to the version on disk of ${currentVersionFromDisk}`,
                );
                currentVersion = currentVersionFromDisk;
                currentVersionResolvedFromFallback = true;
              } else {
                throw new Error(
                  `Unable to resolve the current version from pip registry. Please ensure that the package exists in the registry in order to use the "registry" currentVersionResolver. Alternatively, you can use the --first-release option or set "release.version.generatorOptions.fallbackCurrentVersionResolver" to "disk" in order to fallback to the version on disk when the registry lookup fails.`,
                );
              }
            }
          } else {
            if (currentVersionResolvedFromFallback) {
              logger.buffer(
                `📄 Using the current version ${currentVersion} already resolved from disk fallback.`,
              );
            } else {
              logger.buffer(
                `📄 Using the current version ${currentVersion} already resolved from pip registry`,
              );
            }
          }
          break;
        }
        case 'disk':
          currentVersion = currentVersionFromDisk;
          if (!currentVersion) {
            throw new Error(
              `Unable to determine the current version for project "${project.name}" from ${pyprojectTomlPath}`,
            );
          }
          logger.buffer(
            `📄 Resolved the current version as ${currentVersion} from ${pyprojectTomlPath}`,
          );
          break;
        case 'git-tag': {
          if (
            !currentVersion ||
            // We always need to independently resolve the current version from git tag per project if the projects are independent
            options.releaseGroup.projectsRelationship === 'independent'
          ) {
            const releaseTagPattern = options.releaseGroup.releaseTagPattern;
            latestMatchingGitTag = await getLatestGitTagForPattern(
              releaseTagPattern,
              {
                projectName: project.name,
              },
            );
            if (!latestMatchingGitTag) {
              if (options.fallbackCurrentVersionResolver === 'disk') {
                logger.buffer(
                  `📄 Unable to resolve the current version from git tag using pattern "${releaseTagPattern}". Falling back to the version on disk of ${currentVersionFromDisk}`,
                );
                currentVersion = currentVersionFromDisk;
                currentVersionResolvedFromFallback = true;
              } else {
                throw new Error(
                  `No git tags matching pattern "${releaseTagPattern}" for project "${project.name}" were found. You will need to create an initial matching tag to use as a base for determining the next version. Alternatively, you can use the --first-release option or set "release.version.generatorOptions.fallbackCurrentVersionResolver" to "disk" in order to fallback to the version on disk when no matching git tags are found.`,
                );
              }
            } else {
              currentVersion = latestMatchingGitTag.extractedVersion;
              logger.buffer(
                `📄 Resolved the current version as ${currentVersion} from git tag "${latestMatchingGitTag.tag}".`,
              );
            }
          } else {
            if (currentVersionResolvedFromFallback) {
              logger.buffer(
                `📄 Using the current version ${currentVersion} already resolved from disk fallback.`,
              );
            } else {
              logger.buffer(
                // In this code path we know that latestMatchingGitTag is defined, because we are not relying on the fallbackCurrentVersionResolver, so we can safely use the non-null assertion operator
                `📄 Using the current version ${currentVersion} already resolved from git tag "${
                  latestMatchingGitTag.tag
                }".`,
              );
            }
          }
          break;
        }
        default:
          throw new Error(
            `Invalid value for options.currentVersionResolver: ${options.currentVersionResolver}`,
          );
      }

      if (options.specifier) {
        logger.buffer(
          `📄 Using the provided version specifier "${options.specifier}".`,
        );
        // The user is forcibly overriding whatever specifierSource they had otherwise set by imperatively providing a specifier
        options.specifierSource = 'prompt';
      }

      /**
       * If we are versioning independently then we always need to determine the specifier for each project individually, except
       * for the case where the user has provided an explicit specifier on the command.
       *
       * Otherwise, if versioning the projects together we only need to perform this logic if the specifier is still unset from
       * previous iterations of the loop.
       *
       * NOTE: In the case that we have previously determined via conventional commits that no changes are necessary, the specifier
       * will be explicitly set to `null`, so that is why we only check for `undefined` explicitly here.
       */
      if (
        specifier === undefined ||
        (options.releaseGroup.projectsRelationship === 'independent' &&
          !options.specifier)
      ) {
        const specifierSource = options.specifierSource;
        switch (specifierSource) {
          case 'conventional-commits': {
            if (options.currentVersionResolver !== 'git-tag') {
              throw new Error(
                `Invalid currentVersionResolver "${options.currentVersionResolver}" provided for release group "${options.releaseGroup.name}". Must be "git-tag" when "specifierSource" is "conventional-commits"`,
              );
            }

            const affectedProjects =
              options.releaseGroup.projectsRelationship === 'independent'
                ? [projectName]
                : projects.map((p) => p.name);

            // latestMatchingGitTag will be undefined if the current version was resolved from the disk fallback.
            // In this case, we want to use the first commit as the ref to be consistent with the changelog command.
            const previousVersionRef = latestMatchingGitTag
              ? latestMatchingGitTag.tag
              : options.fallbackCurrentVersionResolver === 'disk'
                ? await getFirstGitCommit()
                : undefined;

            if (!previousVersionRef) {
              // This should never happen since the checks above should catch if the current version couldn't be resolved
              throw new Error(
                `Unable to determine previous version ref for the projects ${affectedProjects.join(
                  ', ',
                )}. This is likely a bug in Nx.`,
              );
            }

            specifier = await resolveSemverSpecifierFromConventionalCommits(
              previousVersionRef,
              options.projectGraph,
              affectedProjects,
              options.conventionalCommitsConfig,
            );

            if (!specifier) {
              if (
                updateDependents !== 'never' &&
                projectToDependencyBumps.has(projectName)
              ) {
                // No applicable changes to the project directly by the user, but one or more dependencies have been bumped and updateDependents is enabled
                specifier = updateDependentsBump;
                logger.buffer(
                  `📄 Resolved the specifier as "${specifier}" because "release.version.generatorOptions.updateDependents" is enabled`,
                );
                break;
              }
              logger.buffer(
                `🚫 No changes were detected using git history and the conventional commits standard.`,
              );
              break;
            }

            // TODO: reevaluate this prerelease logic/workflow for independent projects
            //
            // Always assume that if the current version is a prerelease, then the next version should be a prerelease.
            // Users must manually graduate from a prerelease to a release by providing an explicit specifier.
            if (prerelease(currentVersion ?? '')) {
              specifier = 'prerelease';
              logger.buffer(
                `📄 Resolved the specifier as "${specifier}" since the current version is a prerelease.`,
              );
            } else {
              let extraText = '';
              if (options.preid && !specifier.startsWith('pre')) {
                specifier = `pre${specifier}`;
                extraText = `, combined with your given preid "${options.preid}"`;
              }
              logger.buffer(
                `📄 Resolved the specifier as "${specifier}" using git history and the conventional commits standard${extraText}.`,
              );
            }
            break;
          }
          case 'prompt': {
            // Only add the release group name to the log if it is one set by the user, otherwise it is useless noise
            const maybeLogReleaseGroup = (log: string): string => {
              if (
                options.releaseGroup.name === IMPLICIT_DEFAULT_RELEASE_GROUP
              ) {
                return log;
              }
              return `${log} within release group "${options.releaseGroup.name}"`;
            };
            if (options.releaseGroup.projectsRelationship === 'independent') {
              specifier = await resolveSemverSpecifierFromPrompt(
                `${maybeLogReleaseGroup(
                  `What kind of change is this for project "${projectName}"`,
                )}?`,
                `${maybeLogReleaseGroup(
                  `What is the exact version for project "${projectName}"`,
                )}?`,
              );
            } else {
              specifier = await resolveSemverSpecifierFromPrompt(
                `${maybeLogReleaseGroup(
                  `What kind of change is this for the ${projects.length} matched projects(s)`,
                )}?`,
                `${maybeLogReleaseGroup(
                  `What is the exact version for the ${projects.length} matched project(s)`,
                )}?`,
              );
            }
            break;
          }
          case 'version-plans': {
            if (!options.releaseGroup.versionPlans) {
              if (
                options.releaseGroup.name === IMPLICIT_DEFAULT_RELEASE_GROUP
              ) {
                throw new Error(
                  `Invalid specifierSource "version-plans" provided. To enable version plans, set the "release.versionPlans" configuration option to "true" in nx.json.`,
                );
              } else {
                throw new Error(
                  `Invalid specifierSource "version-plans" provided. To enable version plans for release group "${options.releaseGroup.name}", set the "versionPlans" configuration option to "true" within the release group configuration in nx.json.`,
                );
              }
            }

            if (options.releaseGroup.projectsRelationship === 'independent') {
              specifier = (
                options.releaseGroup
                  .resolvedVersionPlans as ProjectsVersionPlan[]
              ).reduce((spec: ReleaseType, plan: ProjectsVersionPlan) => {
                if (!spec) {
                  return plan.projectVersionBumps[projectName];
                }
                if (plan.projectVersionBumps[projectName]) {
                  const prevNewVersion = inc(currentVersion, spec);
                  const nextNewVersion = inc(
                    currentVersion,
                    plan.projectVersionBumps[projectName],
                  );
                  return gt(nextNewVersion, prevNewVersion)
                    ? plan.projectVersionBumps[projectName]
                    : spec;
                }
                return spec;
              }, null);
            } else {
              specifier = (
                options.releaseGroup.resolvedVersionPlans as GroupVersionPlan[]
              ).reduce((spec: ReleaseType, plan: GroupVersionPlan) => {
                if (!spec) {
                  return plan.groupVersionBump;
                }

                const prevNewVersion = inc(currentVersion, spec);
                const nextNewVersion = inc(
                  currentVersion,
                  plan.groupVersionBump,
                );
                return gt(nextNewVersion, prevNewVersion)
                  ? plan.groupVersionBump
                  : spec;
              }, null);
            }

            if (!specifier) {
              if (
                updateDependents !== 'never' &&
                projectToDependencyBumps.has(projectName)
              ) {
                // No applicable changes to the project directly by the user, but one or more dependencies have been bumped and updateDependents is enabled
                specifier = updateDependentsBump;
                logger.buffer(
                  `📄 Resolved the specifier as "${specifier}" because "release.version.generatorOptions.updateDependents" is enabled`,
                );
              } else {
                specifier = null;
                logger.buffer(
                  `🚫 No changes were detected within version plans.`,
                );
              }
            } else {
              logger.buffer(
                `📄 Resolved the specifier as "${specifier}" using version plans.`,
              );
            }

            if (options.deleteVersionPlans) {
              (options.releaseGroup.resolvedVersionPlans || []).forEach((p) => {
                deleteVersionPlanCallbacks.push(async (dryRun?: boolean) => {
                  if (!dryRun) {
                    await rm(p.absolutePath, { recursive: true, force: true });
                    // the relative path is easier to digest, so use that for
                    // git operations and logging
                    return [p.relativePath];
                  } else {
                    return [];
                  }
                });
              });
            }

            break;
          }
          default:
            throw new Error(
              `Invalid specifierSource "${specifierSource}" provided. Must be one of "prompt", "conventional-commits" or "version-plans".`,
            );
        }
      }

      // Resolve any local package dependencies for this project (before applying the new version or updating the versionData)
      const localPackageDependencies = resolveLocalPackageDependencies(
        tree,
        options.projectGraph,
        projects,
        projectNameToPackageRootMap,
        resolvePackageRoot,
        // includeAll when the release group is independent, as we may be filtering to a specific subset of projects, but we still want to update their dependents
        options.releaseGroup.projectsRelationship === 'independent',
      );

      const allDependentProjects = Object.values(localPackageDependencies)
        .flat()
        .filter((localPackageDependency) => {
          return localPackageDependency.target === project.name;
        });

      const includeTransitiveDependents = updateDependents === 'auto';
      const transitiveLocalPackageDependents: LocalPackageDependency[] = [];
      if (includeTransitiveDependents) {
        for (const directDependent of allDependentProjects) {
          // Look through localPackageDependencies to find any which have a target on the current dependent
          for (const localPackageDependency of Object.values(
            localPackageDependencies,
          ).flat()) {
            if (localPackageDependency.target === directDependent.source) {
              transitiveLocalPackageDependents.push(localPackageDependency);
            }
          }
        }
      }

      const dependentProjectsInCurrentBatch = [];
      const dependentProjectsOutsideCurrentBatch = [];
      // Track circular dependencies using value of project1:project2
      const circularDependencies = new Set<string>();

      for (const dependentProject of allDependentProjects) {
        // Track circular dependencies (add both directions for easy look up)
        if (dependentProject.target === projectName) {
          circularDependencies.add(
            `${dependentProject.source}:${dependentProject.target}`,
          );
          circularDependencies.add(
            `${dependentProject.target}:${dependentProject.source}`,
          );
        }

        let isInCurrentBatch = options.projects.some(
          (project) => project.name === dependentProject.source,
        );

        // For version-plans, we don't just need to consider the current batch of projects, but also the ones that are actually being updated as part of the plan file(s)
        if (isInCurrentBatch && options.specifierSource === 'version-plans') {
          isInCurrentBatch = (
            options.releaseGroup.resolvedVersionPlans || []
          ).some((plan) => {
            if ('projectVersionBumps' in plan) {
              return plan.projectVersionBumps[dependentProject.source];
            }
            return true;
          });
        }

        if (!isInCurrentBatch) {
          dependentProjectsOutsideCurrentBatch.push(dependentProject);
        } else {
          dependentProjectsInCurrentBatch.push(dependentProject);
        }
      }

      // If not always updating dependents (when they don't already appear in the batch itself), print a warning to the user about what is being skipped and how to change it
      if (updateDependents === 'never') {
        if (dependentProjectsOutsideCurrentBatch.length > 0) {
          let logMsg = `⚠️  Warning, the following packages depend on "${project.name}"`;
          const reason =
            options.specifierSource === 'version-plans'
              ? 'because they are not referenced in any version plans'
              : 'via --projects';
          if (options.releaseGroup.name === IMPLICIT_DEFAULT_RELEASE_GROUP) {
            logMsg += ` but have been filtered out ${reason}, and therefore will not be updated:`;
          } else {
            logMsg += ` but are either not part of the current release group "${options.releaseGroup.name}", or have been filtered out ${reason}, and therefore will not be updated:`;
          }
          const indent = Array.from(new Array(projectName.length + 4))
            .map(() => ' ')
            .join('');
          logMsg += `\n${dependentProjectsOutsideCurrentBatch
            .map((dependentProject) => `${indent}- ${dependentProject.source}`)
            .join('\n')}`;
          logMsg += `\n${indent}=> You can adjust this behavior by setting \`version.generatorOptions.updateDependents\` to "auto"`;
          logger.buffer(logMsg);
        }
      }

      if (!currentVersion) {
        throw new Error(
          `The current version for project "${project.name}" could not be resolved. Please report this on https://github.com/nrwl/nx`,
        );
      }

      versionData[projectName] = {
        currentVersion,
        newVersion: null, // will stay as null in the final result in the case that no changes are detected
        dependentProjects:
          updateDependents === 'auto'
            ? allDependentProjects.map(({ groupKey, ...rest }) => rest)
            : dependentProjectsInCurrentBatch.map(
                ({ groupKey, ...rest }) => rest,
              ),
      };

      if (!specifier) {
        logger.buffer(
          `🚫 Skipping versioning "${pyprojectToml.tool.poetry.name}" as no changes were detected.`,
        );
        // Print the buffered logs for this unchanged project, as long as the user has not explicitly disabled this behavior
        if (logUnchangedProjects) {
          logger.flush();
        }
        continue;
      }

      const newVersion = deriveNewSemverVersion(
        currentVersion,
        specifier,
        options.preid,
      );
      versionData[projectName].newVersion = newVersion;

      poetryLocks.push(dirname(pyprojectTomlPath));

      writePyprojectToml(tree, pyprojectTomlPath, {
        ...pyprojectToml,
        tool: {
          ...pyprojectToml.tool,
          poetry: {
            ...pyprojectToml.tool.poetry,
            version: newVersion,
          },
        },
      });

      logger.buffer(
        `✍️  New version ${newVersion} written to ${pyprojectTomlPath}`,
      );

      if (allDependentProjects.length > 0) {
        const totalProjectsToUpdate =
          updateDependents === 'auto'
            ? allDependentProjects.length +
              transitiveLocalPackageDependents.length -
              // There are two entries per circular dep
              circularDependencies.size / 2
            : dependentProjectsInCurrentBatch.length;
        if (totalProjectsToUpdate > 0) {
          logger.buffer(
            `✍️  Applying new version ${newVersion} to ${totalProjectsToUpdate} ${
              totalProjectsToUpdate > 1
                ? 'packages which depend'
                : 'package which depends'
            } on ${project.name}`,
          );
        }
      }

      const updateDependentProjectAndAddToVersionData = ({
        dependentProject,
        dependencyPackageName,
        newDependencyVersion,
        forceVersionBump,
      }: {
        dependentProject: LocalPackageDependency;
        dependencyPackageName: string;
        newDependencyVersion: string;
        forceVersionBump: 'major' | 'minor' | 'patch' | false;
      }) => {
        const updatedPyprojectFilePath = joinPathFragments(
          projectNameToPackageRootMap.get(dependentProject.source),
          'pyproject.toml',
        );

        poetryLocks.push(dirname(updatedPyprojectFilePath));

        const updatedPyproject = readPyprojectToml(
          tree,
          updatedPyprojectFilePath,
        );

        if (!updatedPyproject?.tool?.poetry) {
          return;
        }

        // Auto (i.e.infer existing) by default
        let versionPrefix = options.versionPrefix ?? 'auto';
        const currentDependencyVersion =
          dependentProject.dependencyCollection === 'dependencies'
            ? extractDependencyVersion(
                tree,
                projectNameToPackageRootMap.get(dependentProject.source),
                updatedPyproject.tool.poetry.dependencies,
                dependencyPackageName,
              )
            : extractDependencyVersion(
                tree,
                projectNameToPackageRootMap.get(dependentProject.source),
                updatedPyproject.tool.poetry.group[dependentProject.groupKey]
                  ?.dependencies,
                dependencyPackageName,
              );

        const currentPackageVersion =
          updatedPyproject.tool.poetry.version ?? null;
        if (!currentPackageVersion) {
          if (forceVersionBump) {
            // Look up any dependent projects from the transitiveLocalPackageDependents list
            const transitiveDependentProjects =
              transitiveLocalPackageDependents.filter(
                (localPackageDependency) =>
                  localPackageDependency.target === dependentProject.source,
              );
            versionData[dependentProject.source] = {
              currentVersion: currentPackageVersion,
              newVersion: currentDependencyVersion,
              dependentProjects: transitiveDependentProjects,
            };
          }
          writePyprojectToml(tree, updatedPyprojectFilePath, updatedPyproject);
          return;
        }

        // For auto, we infer the prefix based on the current version of the dependent
        if (versionPrefix === 'auto') {
          versionPrefix = ''; // we don't want to end up printing auto
          if (currentDependencyVersion) {
            const prefixMatch = currentDependencyVersion.match(/^[~^]/);
            if (prefixMatch) {
              versionPrefix =
                prefixMatch[0] as ReleaseVersionGeneratorSchema['versionPrefix'];
            } else {
              versionPrefix = '';
            }
          }
        }

        // Apply the new version of the dependency to the dependent (if not preserving locally linked package protocols)
        // TODO
        const shouldUpdateDependency =
          !options.preserveLocalDependencyProtocols;
        if (shouldUpdateDependency) {
          const newDepVersion = `${versionPrefix}${newDependencyVersion}`;
          if (dependentProject.dependencyCollection === 'dependencies') {
            const mainGroup = updatedPyproject.tool.poetry.dependencies;

            if (typeof mainGroup[dependencyPackageName] === 'string') {
              mainGroup[dependencyPackageName] = newDepVersion;
            } else if (mainGroup[dependencyPackageName].version) {
              mainGroup[dependencyPackageName].version = newDepVersion;
            }
          } else {
            const group =
              updatedPyproject.tool.poetry.group[dependentProject.groupKey]
                ?.dependencies;

            if (typeof group[dependencyPackageName] === 'string') {
              group[dependencyPackageName] = newDepVersion;
            } else if (group[dependencyPackageName].version) {
              group[dependencyPackageName].version = newDepVersion;
            }
          }
        }

        // Bump the dependent's version if applicable and record it in the version data
        if (forceVersionBump) {
          const newPackageVersion = deriveNewSemverVersion(
            currentPackageVersion,
            forceVersionBump,
            options.preid,
          );
          updatedPyproject.tool.poetry.version = newPackageVersion;

          // Look up any dependent projects from the transitiveLocalPackageDependents list
          const transitiveDependentProjects =
            transitiveLocalPackageDependents.filter(
              (localPackageDependency) =>
                localPackageDependency.target === dependentProject.source,
            );

          versionData[dependentProject.source] = {
            currentVersion: currentPackageVersion,
            newVersion: newPackageVersion,
            dependentProjects: transitiveDependentProjects,
          };
        }

        writePyprojectToml(tree, updatedPyprojectFilePath, updatedPyproject);
      };

      for (const dependentProject of dependentProjectsInCurrentBatch) {
        if (projectToDependencyBumps.has(dependentProject.source)) {
          const dependencyBumps = projectToDependencyBumps.get(
            dependentProject.source,
          );
          dependencyBumps.add(projectName);
        } else {
          projectToDependencyBumps.set(
            dependentProject.source,
            new Set([projectName]),
          );
        }
        updateDependentProjectAndAddToVersionData({
          dependentProject,
          dependencyPackageName: packageName,
          newDependencyVersion: newVersion,
          // We don't force bump because we know they will come later in the topologically sorted projects loop and may have their own version update logic to take into account
          forceVersionBump: false,
        });
      }

      if (updateDependents === 'auto') {
        for (const dependentProject of dependentProjectsOutsideCurrentBatch) {
          if (
            options.specifierSource === 'version-plans' &&
            !projectToDependencyBumps.has(dependentProject.source)
          ) {
            projectToDependencyBumps.set(
              dependentProject.source,
              new Set([projectName]),
            );
          }

          updateDependentProjectAndAddToVersionData({
            dependentProject,
            dependencyPackageName: packageName,
            newDependencyVersion: newVersion,
            // For these additional dependents, we need to update their package.json version as well because we know they will not come later in the topologically sorted projects loop
            // (Unless using version plans and the dependent is not filtered out by --projects)
            forceVersionBump:
              options.specifierSource === 'version-plans' &&
              projects.find((p) => p.name === dependentProject.source)
                ? false
                : updateDependentsBump,
          });
        }
      }
      for (const transitiveDependentProject of transitiveLocalPackageDependents) {
        // Check if the transitive dependent originates from a circular dependency
        const isFromCircularDependency = circularDependencies.has(
          `${transitiveDependentProject.source}:${transitiveDependentProject.target}`,
        );
        const dependencyProjectName = transitiveDependentProject.target;
        const dependencyPackageRoot = projectNameToPackageRootMap.get(
          dependencyProjectName,
        );
        if (!dependencyPackageRoot) {
          throw new Error(
            `The project "${dependencyProjectName}" does not have a packageRoot available. Please report this issue on https://github.com/nrwl/nx`,
          );
        }
        const dependencyPyprojectTomlPath = joinPathFragments(
          dependencyPackageRoot,
          'pyproject.toml',
        );
        const dependencyPyprojectToml = readPyprojectToml(
          tree,
          dependencyPyprojectTomlPath,
        );

        updateDependentProjectAndAddToVersionData({
          dependentProject: transitiveDependentProject,
          dependencyPackageName: dependencyPyprojectToml.tool.poetry.name,
          newDependencyVersion: dependencyPyprojectToml.tool.poetry.version,
          /**
           * For these additional dependents, we need to update their package.json version as well because we know they will not come later in the topologically sorted projects loop.
           * The one exception being if the dependent is part of a circular dependency, in which case we don't want to force a version bump as this would come in addition to the one
           * already applied.
           */
          forceVersionBump: isFromCircularDependency
            ? false
            : updateDependentsBump,
        });
      }

      // Print the logs that have been buffered for this project
      logger.flush();
    }

    /**
     * Ensure that formatting is applied so that version bump diffs are as minimal as possible
     * within the context of the user's workspace.
     */
    await formatFiles(tree);

    // Return the version data so that it can be leveraged by the overall version command
    return {
      data: versionData,
      callback: async (tree, opts) => {
        const changedFiles: string[] = [];
        const deletedFiles: string[] = [];

        for (const cb of deleteVersionPlanCallbacks) {
          deletedFiles.push(...(await cb(opts.dryRun)));
        }

        changedFiles.push(
          ...poetryLocks.map((lockDir) => path.join(lockDir, 'poetry.lock')),
        );
        if (!opts.dryRun) {
          for (const lockDir of poetryLocks) {
            runPoetry(['lock', '--no-update'], {
              cwd: lockDir,
            });
          }
        }

        if (!opts.dryRun) {
          if (tree.exists('pyproject.toml')) {
            changedFiles.push('poetry.lock');
            runPoetry(['lock', '--no-update'], { cwd: tree.root });
          }
        }

        return { changedFiles, deletedFiles };
      },
    };
  } catch (e) {
    // Flush any pending logs before printing the error to make troubleshooting easier
    logger?.flush();
    console.log(e);

    if (process.env.NX_VERBOSE_LOGGING === 'true') {
      output.error({
        title: e.message,
      });
      // Dump the full stack trace in verbose mode
      console.error(e);
    } else {
      output.error({
        title: e.message,
      });
    }
    process.exit(1);
  }
}

export default releaseVersionGenerator;

function createResolvePackageRoot(customPackageRoot?: string) {
  return (projectNode: ProjectGraphProjectNode): string => {
    // Default to the project root if no custom packageRoot
    if (!customPackageRoot) {
      return projectNode.data.root;
    }
    if (projectNode.data.root === '.') {
      // TODO This is a temporary workaround to fix NXC-574 until NXC-573 is resolved
      return projectNode.data.root;
    }
    return interpolate(customPackageRoot, {
      workspaceRoot: '',
      projectRoot: projectNode.data.root,
      projectName: projectNode.name,
    });
  };
}

const colors = [
  { instance: chalk.green, spinnerColor: 'green' },
  { instance: chalk.greenBright, spinnerColor: 'green' },
  { instance: chalk.red, spinnerColor: 'red' },
  { instance: chalk.redBright, spinnerColor: 'red' },
  { instance: chalk.cyan, spinnerColor: 'cyan' },
  { instance: chalk.cyanBright, spinnerColor: 'cyan' },
  { instance: chalk.yellow, spinnerColor: 'yellow' },
  { instance: chalk.yellowBright, spinnerColor: 'yellow' },
  { instance: chalk.magenta, spinnerColor: 'magenta' },
  { instance: chalk.magentaBright, spinnerColor: 'magenta' },
] as const;

function getColor(projectName: string) {
  let code = 0;
  for (let i = 0; i < projectName.length; ++i) {
    code += projectName.charCodeAt(i);
  }
  const colorIndex = code % colors.length;
  return colors[colorIndex];
}

class ProjectLogger {
  private logs: string[] = [];

  constructor(
    private projectName: string,
    private color: (typeof colors)[number],
  ) {}

  buffer(msg: string) {
    this.logs.push(msg);
  }

  flush() {
    output.logSingleLine(
      `Running release version for project: ${this.color.instance.bold(
        this.projectName,
      )}`,
    );
    this.logs.forEach((msg) => {
      console.log(this.color.instance.bold(this.projectName) + ' ' + msg);
    });
  }
}
