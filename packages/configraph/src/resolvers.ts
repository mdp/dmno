/* eslint-disable class-methods-use-this */
import _ from 'lodash-es';
import { ConfigraphNodeBase } from './config-node';
import { ResolutionError, SchemaError, ValidationError } from './errors';


// TODO: do we allow Date?
// what to do about null/undefined?
export type ConfigValue =
  undefined |
  string | number | boolean |
  { [key: string]: ConfigValue } |
  Array<ConfigValue>;

type ValueResolverResult = undefined | ConfigValue;
type ConfigValueInlineFunction =
  (ctx: ResolverContext) => MaybePromise<ValueResolverResult>;
export type InlineValueResolverDef =
  // static value
  ConfigValue |
  // resolver - ex: formula, fetch from vault, etc
  ConfigValueResolver |
  // inline function, which can return a value
  ConfigValueInlineFunction;



type ValueOrValueGetter<T> = T | ((ctx: ResolverContext) => T);
type MaybePromise<T> = T | Promise<T>;

type ResolverDefinition = {

  // TODO-review: changed plugin reference to id, to help decouple?
  // /** reference back to the plugin which created the resolver (if applicable) */
  // createdByPlugin?: DmnoPlugin,
  createdByPluginId?: string,


  /** set a specific icon for the resolver, will default to the plugin's icon if set */
  icon?: ValueOrValueGetter<string>,
  /** label for the resolver */
  label: ValueOrValueGetter<string>,
  /**
   * caching key for the final value
   * this is just a convenience to avoid having to explicityl interact with the caching logic directly
   * */
  cacheKey?: ValueOrValueGetter<string>,

  /**
   * function that will be called while processing the graph's schema
   * useful for validating references to other nodes in the graph are valid
   *
   * optionally can return function(s) that will be called in a second pass after the entire graph has been processed
   */
  process?: (this: ConfigValueResolver) => void | (() => void),
} &
({
  resolve: (ctx: ResolverContext) => MaybePromise<ValueResolverResult>,
} | {
  resolveBranches: Array<ResolverBranchDefinition>
});

export function createResolver(def: ResolverDefinition) {
  return new ConfigValueResolver(def);
}

//! maybe do this via a type/errorCode instead of custom class?
export class DependencyNotResolvedResolutionError extends ResolutionError {
  retryable = true;
}
export class DependencyInvalidResolutionError extends ResolutionError {}

type ResolverBranchDefinition = {
  id: string,
  label: string;
  resolver: ConfigValueResolver;
  condition: (ctx: ResolverContext) => boolean;
  isDefault: boolean;
};

export class ConfigValueResolver {
  constructor(readonly def: ResolverDefinition) {
    // TODO: figure out this pattern... we'll have several bits of setings that
    // are either static or need some basic resolution
    if (_.isString(this.def.icon)) this.icon = this.def.icon;
    if (_.isString(this.def.label)) this.label = this.def.label;

    // link the branch resolvers back to their branch definition
    // and to this parent resolver
    // so they can access the branch path if needed
    if ('resolveBranches' in this.def) {
      this.branches = this.def.resolveBranches.map((branchDef) => {
        return new ConfigValueResolverBranch(branchDef, this);
      });
    }
  }

  // the parent/linked resolver branch, if this is a child of branched resolver
  linkedBranch?: ConfigValueResolverBranch;
  // child resolver branches - for something like `switchBy`
  branches: Array<ConfigValueResolverBranch> | undefined;
  isResolved = false;
  resolvedValue?: ConfigValue;
  isUsingCache = false;

  resolutionError?: ResolutionError;
  get selfOrChildResolutionError(): ResolutionError | undefined {
    if (this.resolutionError) return this.resolutionError;
    if (!this.branches) return;
    for (const b of this.branches) {
      const branchResolutionError = b.def.resolver.selfOrChildResolutionError;
      if (branchResolutionError) return branchResolutionError;
    }
  }

  get isFullyResolved() {
    if (!this.isResolved) return false;
    return !this.selfOrChildResolutionError;
  }

  icon?: string;
  label?: string;

  private _configNode?: ConfigraphNodeBase;
  set configNode(node: ConfigraphNodeBase | undefined) {
    this._configNode = node;
    this.branches?.forEach((branch) => {
      branch.def.resolver.configNode = node;
    });
  }
  get configNode(): ConfigraphNodeBase {
    if (!this._configNode) throw new Error('expected resolver configNode to be set');
    return this._configNode;
  }

  get parentResolver() {
    return this.linkedBranch?.parentResolver;
  }
  get branchIdPath(): string | undefined {
    if (!this.linkedBranch) return undefined;
    const thisBranchId = this.linkedBranch.def.id;
    if (this.parentResolver) {
      const parentBranchIdPath = this.parentResolver.branchIdPath;
      if (parentBranchIdPath) {
        return `${this.parentResolver.branchIdPath}/${thisBranchId}`;
      }
    }
    return thisBranchId;
  }

  getFullPath() {
    return _.compact([
      this.configNode?.getFullPath(),
      this.branchIdPath,
    ]).join('#');
  }

  resetResolutionState() {
    delete this.resolutionError;
    for (const depPath in this.dependsOnPathsObj) {
      if (this.dependsOnPathsObj[depPath] === 'resolution') {
        delete this.dependsOnPathsObj[depPath];
      }
    }
    this.branches?.forEach((b) => {
      b.isActive = false;
      b.resolver.resetResolutionState();
    });
  }



  dependsOnPathsObj: Record<string, 'schema' | 'resolution'> = {};
  getDependencyMap(mode: 'self' | 'all' | 'active' = 'self') {
    const depMap = { ...this.dependsOnPathsObj };
    if (mode === 'self' || !this.branches) return depMap;
    for (const branch of this.branches) {
      if (mode === 'all' || (branch.isActive && mode === 'active')) {
        const branchMap = branch.resolver.getDependencyMap(mode);
        _.each(branchMap, (depType, depNodeId) => {
          depMap[depNodeId] = depType;
        });
      }
    }
    return depMap;
  }
  get dependsOnPaths() { return _.keys(this.dependsOnPathsObj); }

  process(item: ConfigraphNodeBase): void | Array<() => void> {
    const postProcessFns = [];
    // call process fn if one is defined
    const postProcessFn = this.def.process?.call(this);
    if (postProcessFn) postProcessFns.push(postProcessFn);

    // call process on child branches
    for (const b of this.branches || []) {
      const branchPostProcessFns = b.resolver.process(item);
      if (branchPostProcessFns) {
        postProcessFns.push(...branchPostProcessFns);
      }
    }
    if (postProcessFns.length) return postProcessFns;
  }

  async resolve(ctx: ResolverContext) {
    // if we have previously resolved, we need to clear the error, branch active state, etc
    this.resetResolutionState();
    // console.log('> running resolver for item', this.configNode.getFullPath());

    if (_.isFunction(this.def.icon)) this.icon = this.def.icon(ctx);
    if (_.isFunction(this.def.label)) this.label = this.def.label(ctx);

    // optional cache key can be static or a fn
    let cacheKey: string | undefined;
    if (_.isString(this.def.cacheKey)) cacheKey = this.def.cacheKey;
    else if (_.isFunction(this.def.cacheKey)) {
      // TODO: should add error handling here
      cacheKey = this.def.cacheKey(ctx);
    }
    // if a cache key is set, we first check the cache and return that value if found
    if (cacheKey) {
      // console.log(kleur.bgMagenta(`CHECK VALUE CACHE FOR KEY: ${this.cacheKey}`));
      const cachedValue = await ctx.getCacheItem(cacheKey);
      if (cachedValue !== undefined) {
        // console.log(kleur.bgMagenta('> USING CACHED VALUE!'));
        this.resolvedValue = cachedValue;
        this.isResolved = true;
        this.isUsingCache = true;
        return;
      }
    }

    // deal with branched case (ex: switch / if-else)
    if (this.branches) {
      // find first branch that passes
      let matchingBranch = _.find(this.branches, (branch) => {
        if (branch.def.isDefault) return false;
        try {
          return branch.def.condition(ctx);
        } catch (err) {
          this.resolutionError = new ResolutionError(`Error in resolver branch condition (${branch.def.label})`, { err: err as Error });
        }
        return false;
      });
      // bail early if we failed evaluating resolver conditions
      if (this.resolutionError) {
        this.isResolved = false;
        return;
      }

      if (!matchingBranch) {
        matchingBranch = _.find(this.branches, (branch) => branch.def.isDefault);
      }

      _.each(this.branches, (branch) => {
        branch.isActive = branch === matchingBranch;
      });

      // TODO: might be able to force a default to be defined?
      if (!matchingBranch) {
        throw new ResolutionError('no matching resolver branch found and no default');
      }
      // resolutionResult is now a child resolver which must be resolved itself
      // NOTE we have to call this recursively so that caching can be triggered on each resolver
      const matchingBranchResolver = matchingBranch.def.resolver;
      const childCtx = new ResolverContext(matchingBranchResolver);
      // TODO: deal with errors - and need to bubble them up...?
      await matchingBranchResolver.resolve(childCtx);
      this.resolvedValue = matchingBranchResolver.resolvedValue;
      this.isResolved = true;

    // deal with normal case
    } else {
      // should always be the case, since resolvers must have branches or a resolve fn
      if (!('resolve' in this.def)) {
        throw new Error('expected `resolve` fn in resolver definition');
      }

      // actually call the resolver
      try {
        this.resolvedValue = await this.def.resolve(ctx);
        this.isResolved = true;
      } catch (err) {
        if (err instanceof ResolutionError) {
          this.resolutionError = err;
        } else {
          this.resolutionError = new ResolutionError(err as Error);
        }
        this.isResolved = false;
        return;
      }
    }

    // save result in cache if this resolver has a cache key
    if (cacheKey && this.resolvedValue !== undefined && this.resolvedValue !== null) {
      // console.log(kleur.bgMagenta(`SAVE CACHED VALUE IN KEY: ${this.cacheKey}`));
      await ctx.setCacheItem(cacheKey, this.resolvedValue);
    }
  }

  //! move serialization out of core objects
  // toJSON(): SerializedResolver {
  //   return {
  //     isResolved: this.isResolved,
  //     icon: this.icon,
  //     label: this.label,
  //     createdByPluginInstanceName: this.def.createdByPlugin?.instanceName,
  //     // itemPath: this.configItem?.getFullPath(),
  //     // branchIdPath: this.branchIdPath,
  //     ...this.branches && {
  //       branches: this.branches.map((b) => b.toJSON()),
  //     },
  //     resolvedValue: this.resolvedValue,
  //     resolutionError: this.resolutionError?.toJSON(),
  //   };
  // }
}
export class ConfigValueResolverBranch {
  constructor(
    readonly def: ResolverBranchDefinition,
    readonly parentResolver: ConfigValueResolver,
  ) {
    // link the branch definition resolver back to this object
    this.def.resolver.linkedBranch = this;
  }

  isActive?: boolean;
  get id() { return this.def.id; }
  get label() { return this.def.label; }
  get isDefault() { return this.def.isDefault; }
  get resolver() { return this.def.resolver; }

  //! move out of core
  // toJSON() {
  //   return {
  //     id: this.id,
  //     label: this.label,
  //     isDefault: this.isDefault,
  //     isActive: this.isActive,
  //     resolver: this.resolver.toJSON(),
  //   };
  // }
}

export function processInlineResolverDef(resolverDef: InlineValueResolverDef) {
  // set up value resolver

  // inline function case
  if (_.isFunction(resolverDef)) {
    return createResolver({
      icon: 'f7:function',
      label: 'fn',
      resolve: resolverDef,
    });

  // already a resolver case
  } else if (resolverDef instanceof ConfigValueResolver) {
    return resolverDef;

  // static value case - including explicitly setting to `undefined
  } else if (
    _.isString(resolverDef) || _.isNumber(resolverDef) || _.isBoolean(resolverDef)
    || _.isPlainObject(resolverDef)
    || resolverDef === undefined
  ) {
    return createResolver({
      icon: 'material-symbols:check-circle',
      label: 'static',
      resolve: async () => resolverDef,
    });
  } else {
    throw new Error('invalid resolver definition');
  }
}

export class ResolverContext {
  // TODO: the item has everything we need, but is it what we want to pass in?
  // lots of ? and ! on ts types here because data doesn't exist at init time...
  private resolver?: ConfigValueResolver;
  private configNode: ConfigraphNodeBase;
  constructor(
    // private configItem: DmnoConfigItemBase,
    resolverOrNode: ConfigValueResolver | ConfigraphNodeBase,
  ) {
    if (resolverOrNode instanceof ConfigValueResolver) {
      this.resolver = resolverOrNode;
      this.configNode = this.resolver.configNode!;
    } else {
      this.configNode = resolverOrNode;
    }
  }

  get entity() {
    return this.configNode.parentEntity;
  }
  get entityId() {
    return this.entity?.id;
  }
  get nodePath() {
    return this.configNode.getPath();
  }
  get nodeFullPath() {
    return this.configNode.getFullPath();
  }
  get resolverFullPath() {
    return this.resolver ? this.resolver.getFullPath() : this.nodeFullPath;
  }
  get resolverBranchIdPath() {
    return this.resolver?.branchIdPath;
  }

  dependsOnPathsObj: Record<string, boolean> = {};
  get dependsOnPaths() { return _.keys(this.dependsOnPathsObj); }

  get(nodePath: string): any {
    const node = this.entity?.getConfigNodeByPath(nodePath);
    if (!node) {
      throw new Error(`Tried to get config node that does not exist "${nodePath}"`);
    }

    // just checking in case... can probably remove later
    if (node.getPath() !== nodePath) throw new Error('node path did not match');

    // could track more info here - like if we are waiting for it
    // for now we'll track in several places, not sure yet how we want to roll it up
    const itemFullPath = node.getFullPath();
    this.dependsOnPathsObj[itemFullPath] = true;
    if (this.resolver) this.resolver.dependsOnPathsObj[itemFullPath] ||= 'resolution';

    // TODO: might need something like this to support tracking deps in coerce/validate
    // this.configItem.dependsOnPathsObj[itemPath] = true;

    if (!node.isResolved) {
      throw new DependencyNotResolvedResolutionError(
        `Tried to access node that was not yet resolved - ${nodePath}`,
      );
    }
    if (!node.isValid) {
      throw new DependencyInvalidResolutionError(
        `Resolver tried to use node that is invalid - ${nodePath}`,
      );
    }

    return node.resolvedValue;
  }

  // TODO: needs a better name -
  // get the values of items we declared dependencies for during process()
  getDeclaredDependencyValues() {
    return _.mapValues(this.resolver?.dependsOnPathsObj, (depType, fullPath) => {
      // TODO: review how these errors are dealt with, currently we are bailing at the first error, but we may want to collect multiple?
      const depNode = this.configNode.parentEntity?.graphRoot.getItemByPath(fullPath);
      if (!depNode) {
        throw new ResolutionError(`Invalid declared dependency path - ${fullPath}`);
      }
      if (!depNode.isFullyResolved) {
        throw new DependencyNotResolvedResolutionError('dependency not resolved yet');
      }
      if (!depNode.isValid) {
        throw new ResolutionError('declared dependency is resolved but not valid');
      }
      return depNode.resolvedValue;
    });
  }

  //! need to reenable these caching helpers
  //! maybe need to hook into behaviour defined elsewhere?
  // TODO: probably dont want to pull cache disable setting from the workspace/service/etc
  async getCacheItem(key: string) {
    return undefined;
    // if (process.env.DISABLE_DMNO_CACHE) return undefined;
    // return this.entity?.workspace.getCacheItem(key, this.itemFullPath);
  }
  async setCacheItem(key: string, value: ConfigValue) {
    return;
    // if (process.env.DISABLE_DMNO_CACHE) return;
    // if (value === undefined || value === null) return;
    // return this.entity?.workspace.setCacheItem(key, value, this.itemFullPath);
  }
  async getOrSetCacheItem(key: string, getValToWrite: () => Promise<ConfigValue>) {
    return await getValToWrite();
    // if (!process.env.DISABLE_DMNO_CACHE) {
    //   const cachedValue = await this.getCacheItem(key);
    //   if (cachedValue) return cachedValue;
    // }
    // const val = await getValToWrite();
    // if (!process.env.DISABLE_DMNO_CACHE) {
    //   await this.setCacheItem(key, val);
    // }
    // return val;
  }
}

// BUILT-IN RESOLVERS ///////////////////////////////////////////////////////////

/**
 * helper fn to add caching to a value resolver that does not have it built-in
 * for example, a fn that generates a random number / key
 * */
export function cacheFunctionResult(resolverFn: ConfigValueInlineFunction): ConfigValueResolver;
export function cacheFunctionResult(cacheKey: string, resolverFn: ConfigValueInlineFunction): ConfigValueResolver;
export function cacheFunctionResult(
  cacheKeyOrResolverFn: string | ConfigValueInlineFunction,
  resolverFn?: ConfigValueInlineFunction,
): ConfigValueResolver {
  const explicitCacheKey = _.isString(cacheKeyOrResolverFn) ? cacheKeyOrResolverFn : undefined;
  const fn = _.isString(cacheKeyOrResolverFn) ? resolverFn! : cacheKeyOrResolverFn;

  return createResolver({
    icon: 'f7:function', // TODO: different fn for cached?
    label: 'cached fn',
    cacheKey: explicitCacheKey || ((ctx) => ctx.resolverFullPath),
    resolve: fn,
  });
}



// export class DeferredDeploymentResolver extends ConfigValueResolver {
//   icon = 'radix-icons:component-placeholder';
//   getPreviewLabel() {
//     return 'generated during deployment';
//   }
//   async _resolve(ctx: ResolverContext) {
//     return 'resolved by deployment process';
//   }
// }
// export const valueCreatedDuringDeployment = () => new DeferredDeploymentResolver();


export function createdPickedValueResolver(
  sourceNode: ConfigraphNodeBase,
  valueTransform?: ((val: any) => any),
) {
  return createResolver({
    icon: 'material-symbols:content-copy-outline-sharp',
    label: 'picked value',
    process() {
      this.dependsOnPathsObj[sourceNode.getFullPath()] = 'schema';
    },
    async resolve(ctx) {
      // since we handle resolution of services in the right order
      // we can assume the picked value will be resolved already (if it was possible at all)
      if (!sourceNode.isResolved) {
        return new Error('picked value has not been resolved yet');
      }
      if (valueTransform) {
        return valueTransform(sourceNode.resolvedValue);
      } else {
        return sourceNode.resolvedValue;
      }
    },
  });
}

type SwitchByResolverOptions = Record<string, InlineValueResolverDef>;

export function switchBy(switchByKey: string, branches: SwitchByResolverOptions) {
  return createResolver({
    icon: 'gravity-ui:branches-right',
    label: `switch by ${switchByKey}`,
    process() {
      const containingEntity = this.configNode.parentEntity!;
      const switchFromNode = containingEntity.getConfigNodeByPath(switchByKey);
      if (!switchFromNode) {
        this.configNode.schemaErrors.push(new SchemaError(`switchBy referencing invalid path - ${switchByKey}`));
        return;
      }
      this.dependsOnPathsObj[switchFromNode.getFullPath()] = 'schema';
    },
    resolveBranches: _.map(branches, (itemDef, itemKey) => ({
      // TODO: do we want to use a special symbol? or pass default as different arg?
      isDefault: itemKey === '_default' || itemKey === '_',
      condition: (ctx: ResolverContext) => ctx.get(switchByKey) === itemKey,
      id: itemKey,
      label: `${switchByKey} === "${itemKey}"`,
      resolver: processInlineResolverDef(itemDef),
    })),
  });
}

