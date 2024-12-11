import { joinPathFragments, Tree } from '@nx/devkit';
import { IProvider } from '../../../provider/base';

export class Package {
  name: string;
  version: string;
  location: string;

  constructor(
    private tree: Tree,
    private provider: IProvider,
    workspaceRoot: string,
    private workspaceRelativeLocation: string,
  ) {
    const metadata = provider.getMetadata(workspaceRelativeLocation, tree);
    this.name = metadata.name;
    this.version = metadata.version;
    this.location = joinPathFragments(workspaceRoot, workspaceRelativeLocation);
  }

  getLocalDependency(depName: string): {
    collection: 'dependencies' | 'devDependencies' | 'optionalDependencies';
    groupKey?: string;
    spec: string;
  } | null {
    const depMatadata = this.provider.getDependencyMetadata(
      this.workspaceRelativeLocation,
      depName,
      this.tree,
    );

    return {
      collection:
        depMatadata.group === 'main'
          ? 'dependencies'
          : depMatadata.group === 'dev'
            ? 'devDependencies'
            : 'optionalDependencies',
      spec: depMatadata.version,
    };
  }
}
