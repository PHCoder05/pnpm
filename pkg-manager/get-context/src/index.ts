import { promises as fs } from 'fs'
import path from 'path'
import { contextLogger, packageManifestLogger } from '@pnpm/core-loggers'
import { PnpmError } from '@pnpm/error'
import { type Lockfile } from '@pnpm/lockfile-file'
import { logger } from '@pnpm/logger'
import {
  type IncludedDependencies,
  type Modules,
} from '@pnpm/modules-yaml'
import { readProjectsContext } from '@pnpm/read-projects-context'
import {
  DEPENDENCIES_FIELDS,
  type HoistedDependencies,
  type ProjectManifest,
  type ReadPackageHook,
  type Registries,
} from '@pnpm/types'
import rimraf from '@zkochan/rimraf'
import pathAbsolute from 'path-absolute'
import clone from 'ramda/src/clone'
import equals from 'ramda/src/equals'
import { checkCompatibility } from './checkCompatibility'
import { UnexpectedStoreError } from './checkCompatibility/UnexpectedStoreError'
import { UnexpectedVirtualStoreDirError } from './checkCompatibility/UnexpectedVirtualStoreDirError'
import { readLockfiles } from './readLockfiles'

export { UnexpectedStoreError, UnexpectedVirtualStoreDirError }

export interface PnpmContext {
  currentLockfile: Lockfile
  currentLockfileIsUpToDate: boolean
  existsCurrentLockfile: boolean
  existsWantedLockfile: boolean
  extraBinPaths: string[]
  extraNodePaths: string[]
  lockfileHadConflicts: boolean
  hoistedDependencies: HoistedDependencies
  include: IncludedDependencies
  modulesFile: Modules | null
  pendingBuilds: string[]
  projects: Record<string, {
    modulesDir: string
    id: string
  } & HookOptions & Required<ProjectOptions>>
  rootModulesDir: string
  hoistPattern: string[] | undefined
  hoistedModulesDir: string
  publicHoistPattern: string[] | undefined
  lockfileDir: string
  virtualStoreDir: string
  skipped: Set<string>
  storeDir: string
  wantedLockfile: Lockfile
  wantedLockfileIsModified: boolean
  registries: Registries
}

export interface ProjectOptions {
  buildIndex: number
  binsDir?: string
  manifest: ProjectManifest
  modulesDir?: string
  rootDir: string
}

interface HookOptions {
  originalManifest?: ProjectManifest
}

export interface GetContextOptions {
  autoInstallPeers: boolean
  allProjects: Array<ProjectOptions & HookOptions>
  force: boolean
  forceNewModules?: boolean
  forceSharedLockfile: boolean
  frozenLockfile?: boolean
  extraBinPaths: string[]
  extendNodePath?: boolean
  lockfileDir: string
  modulesDir?: string
  nodeLinker: 'isolated' | 'hoisted' | 'pnp'
  readPackageHook?: ReadPackageHook
  include?: IncludedDependencies
  registries: Registries
  storeDir: string
  useLockfile: boolean
  useGitBranchLockfile?: boolean
  mergeGitBranchLockfiles?: boolean
  virtualStoreDir?: string

  hoistPattern?: string[] | undefined
  forceHoistPattern?: boolean

  publicHoistPattern?: string[] | undefined
  forcePublicHoistPattern?: boolean

  useLockfileV6?: boolean
  global?: boolean
}

export async function getContext (
  opts: GetContextOptions
): Promise<PnpmContext> {
  const modulesDir = opts.modulesDir ?? 'node_modules'
  let importersContext = await readProjectsContext(opts.allProjects, { lockfileDir: opts.lockfileDir, modulesDir })
  const virtualStoreDir = pathAbsolute(opts.virtualStoreDir ?? path.join(modulesDir, '.pnpm'), opts.lockfileDir)

  if (importersContext.modules != null) {
    const { purged } = await validateModules(importersContext.modules, importersContext.projects, {
      currentHoistPattern: importersContext.currentHoistPattern,
      currentPublicHoistPattern: importersContext.currentPublicHoistPattern,
      forceNewModules: opts.forceNewModules === true,
      include: opts.include,
      lockfileDir: opts.lockfileDir,
      modulesDir,
      registries: opts.registries,
      storeDir: opts.storeDir,
      virtualStoreDir,

      forceHoistPattern: opts.forceHoistPattern,
      hoistPattern: opts.hoistPattern,

      forcePublicHoistPattern: opts.forcePublicHoistPattern,
      publicHoistPattern: opts.publicHoistPattern,
      global: opts.global,
    })
    if (purged) {
      importersContext = await readProjectsContext(opts.allProjects, {
        lockfileDir: opts.lockfileDir,
        modulesDir,
      })
    }
  }

  await fs.mkdir(opts.storeDir, { recursive: true })

  opts.allProjects.forEach((project) => {
    packageManifestLogger.debug({
      initial: project.manifest,
      prefix: project.rootDir,
    })
  })
  if (opts.readPackageHook != null) {
    for (const project of importersContext.projects) {
      project.originalManifest = project.manifest
      project.manifest = await opts.readPackageHook(clone(project.manifest), project.rootDir)
    }
  }

  const extraBinPaths = [
    ...opts.extraBinPaths || [],
  ]
  const hoistedModulesDir = path.join(virtualStoreDir, 'node_modules')
  if (opts.hoistPattern?.length) {
    extraBinPaths.unshift(path.join(hoistedModulesDir, '.bin'))
  }
  const hoistPattern = importersContext.currentHoistPattern ?? opts.hoistPattern
  const ctx: PnpmContext = {
    extraBinPaths,
    extraNodePaths: getExtraNodePaths({ extendNodePath: opts.extendNodePath, nodeLinker: opts.nodeLinker, hoistPattern, virtualStoreDir }),
    hoistedDependencies: importersContext.hoistedDependencies,
    hoistedModulesDir,
    hoistPattern,
    include: opts.include ?? importersContext.include,
    lockfileDir: opts.lockfileDir,
    modulesFile: importersContext.modules,
    pendingBuilds: importersContext.pendingBuilds,
    projects: Object.fromEntries(importersContext.projects.map((project) => [project.rootDir, project])),
    publicHoistPattern: importersContext.currentPublicHoistPattern ?? opts.publicHoistPattern,
    registries: {
      ...opts.registries,
      ...importersContext.registries,
    },
    rootModulesDir: importersContext.rootModulesDir,
    skipped: importersContext.skipped,
    storeDir: opts.storeDir,
    virtualStoreDir,
    ...await readLockfiles({
      autoInstallPeers: opts.autoInstallPeers,
      force: opts.force,
      forceSharedLockfile: opts.forceSharedLockfile,
      frozenLockfile: opts.frozenLockfile === true,
      lockfileDir: opts.lockfileDir,
      projects: importersContext.projects,
      registry: opts.registries.default,
      useLockfile: opts.useLockfile,
      useGitBranchLockfile: opts.useGitBranchLockfile,
      mergeGitBranchLockfiles: opts.mergeGitBranchLockfiles,
      virtualStoreDir,
      useLockfileV6: opts.useLockfileV6,
    }),
  }
  contextLogger.debug({
    currentLockfileExists: ctx.existsCurrentLockfile,
    storeDir: opts.storeDir,
    virtualStoreDir,
  })
  return ctx
}

async function validateModules (
  modules: Modules,
  projects: Array<{
    modulesDir: string
    id: string
    rootDir: string
  }>,
  opts: {
    currentHoistPattern?: string[]
    currentPublicHoistPattern?: string[]
    forceNewModules: boolean
    include?: IncludedDependencies
    lockfileDir: string
    modulesDir: string
    registries: Registries
    storeDir: string
    virtualStoreDir: string

    hoistPattern?: string[] | undefined
    forceHoistPattern?: boolean

    publicHoistPattern?: string[] | undefined
    forcePublicHoistPattern?: boolean
    global?: boolean
  }
): Promise<{ purged: boolean }> {
  const rootProject = projects.find(({ id }) => id === '.')
  if (
    opts.forcePublicHoistPattern &&
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    !equals(modules.publicHoistPattern, opts.publicHoistPattern || undefined)
  ) {
    if (opts.forceNewModules && (rootProject != null)) {
      await purgeModulesDirsOfImporter(opts.virtualStoreDir, rootProject)
      return { purged: true }
    }
    throw new PnpmError(
      'PUBLIC_HOIST_PATTERN_DIFF',
      'This modules directory was created using a different public-hoist-pattern value.' +
      ' Run "pnpm install" to recreate the modules directory.'
    )
  }
  let purged = false
  if (opts.forceHoistPattern && (rootProject != null)) {
    try {
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      if (!equals(opts.currentHoistPattern, opts.hoistPattern || undefined)) {
        throw new PnpmError(
          'HOIST_PATTERN_DIFF',
          'This modules directory was created using a different hoist-pattern value.' +
          ' Run "pnpm install" to recreate the modules directory.'
        )
      }
    } catch (err: any) { // eslint-disable-line
      if (!opts.forceNewModules) throw err
      await purgeModulesDirsOfImporter(opts.virtualStoreDir, rootProject)
      purged = true
    }
  }
  await Promise.all(projects.map(async (project) => {
    try {
      checkCompatibility(modules, {
        modulesDir: project.modulesDir,
        storeDir: opts.storeDir,
        virtualStoreDir: opts.virtualStoreDir,
      })
      if (opts.lockfileDir !== project.rootDir && (opts.include != null) && modules.included) {
        for (const depsField of DEPENDENCIES_FIELDS) {
          if (opts.include[depsField] !== modules.included[depsField]) {
            throw new PnpmError('INCLUDED_DEPS_CONFLICT',
              `modules directory (at "${opts.lockfileDir}") was installed with ${stringifyIncludedDeps(modules.included)}. ` +
              `Current install wants ${stringifyIncludedDeps(opts.include)}.`
            )
          }
        }
      }
    } catch (err: any) { // eslint-disable-line
      if (!opts.forceNewModules) throw err
      await purgeModulesDirsOfImporter(opts.virtualStoreDir, project)
      purged = true
    }
  }))
  if ((modules.registries != null) && !equals(opts.registries, modules.registries)) {
    if (opts.forceNewModules) {
      await Promise.all(projects.map(purgeModulesDirsOfImporter.bind(null, opts.virtualStoreDir)))
      return { purged: true }
    }
    throw new PnpmError('REGISTRIES_MISMATCH', `This modules directory was created using the following registries configuration: ${JSON.stringify(modules.registries)}. The current configuration is ${JSON.stringify(opts.registries)}. To recreate the modules directory using the new settings, run "pnpm install${opts.global ? ' -g' : ''}".`)
  }
  if (purged && (rootProject == null)) {
    await purgeModulesDirsOfImporter(opts.virtualStoreDir, {
      modulesDir: path.join(opts.lockfileDir, opts.modulesDir),
      rootDir: opts.lockfileDir,
    })
  }
  return { purged }
}

async function purgeModulesDirsOfImporter (
  virtualStoreDir: string,
  importer: {
    modulesDir: string
    rootDir: string
  }
) {
  logger.info({
    message: `Recreating ${importer.modulesDir}`,
    prefix: importer.rootDir,
  })
  try {
    // We don't remove the actual modules directory, just the contents of it.
    // 1. we will need the directory anyway.
    // 2. in some setups, pnpm won't even have permission to remove the modules directory.
    await removeContentsOfDir(importer.modulesDir, virtualStoreDir)
  } catch (err: any) { // eslint-disable-line
    if (err.code !== 'ENOENT') throw err
  }
}

async function removeContentsOfDir (dir: string, virtualStoreDir: string) {
  const items = await fs.readdir(dir)
  for (const item of items) {
    // The non-pnpm related hidden files are kept
    if (
      item.startsWith('.') &&
      item !== '.bin' &&
      item !== '.modules.yaml' &&
      !dirsAreEqual(path.join(dir, item), virtualStoreDir)
    ) {
      continue
    }

    await rimraf(path.join(dir, item))
  }
}

function dirsAreEqual (dir1: string, dir2: string) {
  return path.relative(dir1, dir2) === ''
}

function stringifyIncludedDeps (included: IncludedDependencies) {
  return DEPENDENCIES_FIELDS.filter((depsField) => included[depsField]).join(', ')
}

export interface PnpmSingleContext {
  currentLockfile: Lockfile
  currentLockfileIsUpToDate: boolean
  existsCurrentLockfile: boolean
  existsWantedLockfile: boolean
  extraBinPaths: string[]
  extraNodePaths: string[]
  lockfileHadConflicts: boolean
  hoistedDependencies: HoistedDependencies
  hoistedModulesDir: string
  hoistPattern: string[] | undefined
  manifest: ProjectManifest
  modulesDir: string
  importerId: string
  prefix: string
  include: IncludedDependencies
  modulesFile: Modules | null
  pendingBuilds: string[]
  publicHoistPattern: string[] | undefined
  registries: Registries
  rootModulesDir: string
  lockfileDir: string
  virtualStoreDir: string
  skipped: Set<string>
  storeDir: string
  wantedLockfile: Lockfile
  wantedLockfileIsModified: boolean
}

export async function getContextForSingleImporter (
  manifest: ProjectManifest,
  opts: {
    autoInstallPeers: boolean
    force: boolean
    forceNewModules?: boolean
    forceSharedLockfile: boolean
    extraBinPaths: string[]
    extendNodePath?: boolean
    lockfileDir: string
    nodeLinker: 'isolated' | 'hoisted' | 'pnp'
    modulesDir?: string
    readPackageHook?: ReadPackageHook
    include?: IncludedDependencies
    dir: string
    registries: Registries
    storeDir: string
    useLockfile: boolean
    useGitBranchLockfile?: boolean
    mergeGitBranchLockfiles?: boolean
    virtualStoreDir?: string

    hoistPattern?: string[] | undefined
    forceHoistPattern?: boolean

    publicHoistPattern?: string[] | undefined
    forcePublicHoistPattern?: boolean
    useLockfileV6?: boolean
  },
  alreadyPurged: boolean = false
): Promise<PnpmSingleContext> {
  const {
    currentHoistPattern,
    currentPublicHoistPattern,
    hoistedDependencies,
    projects,
    include,
    modules,
    pendingBuilds,
    registries,
    skipped,
    rootModulesDir,
  } = await readProjectsContext(
    [
      {
        rootDir: opts.dir,
      },
    ],
    {
      lockfileDir: opts.lockfileDir,
      modulesDir: opts.modulesDir,
    }
  )

  const storeDir = opts.storeDir

  const importer = projects[0]
  const modulesDir = importer.modulesDir
  const importerId = importer.id
  const virtualStoreDir = pathAbsolute(opts.virtualStoreDir ?? 'node_modules/.pnpm', opts.lockfileDir)

  if ((modules != null) && !alreadyPurged) {
    const { purged } = await validateModules(modules, projects, {
      currentHoistPattern,
      currentPublicHoistPattern,
      forceNewModules: opts.forceNewModules === true,
      include: opts.include,
      lockfileDir: opts.lockfileDir,
      modulesDir: opts.modulesDir ?? 'node_modules',
      registries: opts.registries,
      storeDir: opts.storeDir,
      virtualStoreDir,

      forceHoistPattern: opts.forceHoistPattern,
      hoistPattern: opts.hoistPattern,

      forcePublicHoistPattern: opts.forcePublicHoistPattern,
      publicHoistPattern: opts.publicHoistPattern,
    })
    if (purged) {
      return getContextForSingleImporter(manifest, opts, true)
    }
  }

  await fs.mkdir(storeDir, { recursive: true })
  const extraBinPaths = [
    ...opts.extraBinPaths || [],
  ]
  const hoistedModulesDir = path.join(virtualStoreDir, 'node_modules')
  if (opts.hoistPattern?.length) {
    extraBinPaths.unshift(path.join(hoistedModulesDir, '.bin'))
  }
  const hoistPattern = currentHoistPattern ?? opts.hoistPattern
  const ctx: PnpmSingleContext = {
    extraBinPaths,
    extraNodePaths: getExtraNodePaths({ extendNodePath: opts.extendNodePath, nodeLinker: opts.nodeLinker, hoistPattern, virtualStoreDir }),
    hoistedDependencies,
    hoistedModulesDir,
    hoistPattern,
    importerId,
    include: opts.include ?? include,
    lockfileDir: opts.lockfileDir,
    manifest: await opts.readPackageHook?.(manifest) ?? manifest,
    modulesDir,
    modulesFile: modules,
    pendingBuilds,
    prefix: opts.dir,
    publicHoistPattern: currentPublicHoistPattern ?? opts.publicHoistPattern,
    registries: {
      ...opts.registries,
      ...registries,
    },
    rootModulesDir,
    skipped,
    storeDir,
    virtualStoreDir,
    ...await readLockfiles({
      autoInstallPeers: opts.autoInstallPeers,
      force: opts.force,
      forceSharedLockfile: opts.forceSharedLockfile,
      frozenLockfile: false,
      lockfileDir: opts.lockfileDir,
      projects: [{ id: importerId, rootDir: opts.dir }],
      registry: opts.registries.default,
      useLockfile: opts.useLockfile,
      useGitBranchLockfile: opts.useGitBranchLockfile,
      mergeGitBranchLockfiles: opts.mergeGitBranchLockfiles,
      virtualStoreDir,
      useLockfileV6: opts.useLockfileV6,
    }),
  }
  packageManifestLogger.debug({
    initial: manifest,
    prefix: opts.dir,
  })
  contextLogger.debug({
    currentLockfileExists: ctx.existsCurrentLockfile,
    storeDir: opts.storeDir,
    virtualStoreDir,
  })

  return ctx
}

function getExtraNodePaths (
  { extendNodePath = true, hoistPattern, nodeLinker, virtualStoreDir }: {
    extendNodePath?: boolean
    hoistPattern?: string[]
    nodeLinker: 'isolated' | 'hoisted' | 'pnp'
    virtualStoreDir: string
  }
) {
  if (extendNodePath && nodeLinker === 'isolated' && hoistPattern?.length) {
    return [path.join(virtualStoreDir, 'node_modules')]
  }
  return []
}
