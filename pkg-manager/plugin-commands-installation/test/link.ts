import { promises as fs } from 'fs'
import path from 'path'
import readYamlFile from 'read-yaml-file'
import { install, link } from '@pnpm/plugin-commands-installation'
import { prepare, preparePackages } from '@pnpm/prepare'
import { assertProject, isExecutable } from '@pnpm/assert-project'
import { fixtures } from '@pnpm/test-fixtures'
import PATH from 'path-name'
import writePkg from 'write-pkg'
import { DEFAULT_OPTS } from './utils'

const f = fixtures(__dirname)

test('linking multiple packages', async () => {
  const project = prepare()

  process.chdir('..')
  const globalDir = path.resolve('global')

  await writePkg('linked-foo', { name: 'linked-foo', version: '1.0.0' })
  await writePkg('linked-bar', { name: 'linked-bar', version: '1.0.0', dependencies: { 'is-positive': '1.0.0' } })
  await fs.writeFile('linked-bar/.npmrc', 'shamefully-hoist = true')

  process.chdir('linked-foo')

  console.log('linking linked-foo to global package')
  const linkOpts = {
    ...DEFAULT_OPTS,
    bin: path.join(globalDir, 'bin'),
    dir: globalDir,
  }
  await link.handler({
    ...linkOpts,
  })

  process.chdir('..')
  process.chdir('project')

  await link.handler({
    ...linkOpts,
  }, ['linked-foo', '../linked-bar'])

  await project.has('linked-foo')
  await project.has('linked-bar')

  const modules = await readYamlFile<any>('../linked-bar/node_modules/.modules.yaml') // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(modules.hoistPattern).toStrictEqual(['*']) // the linked package used its own configs during installation // eslint-disable-line @typescript-eslint/dot-notation
})

test('link global bin', async function () {
  prepare()
  process.chdir('..')

  const globalDir = path.resolve('global')
  const globalBin = path.join(globalDir, 'bin')
  const oldPath = process.env[PATH]
  process.env[PATH] = `${globalBin}${path.delimiter}${oldPath ?? ''}`
  await fs.mkdir(globalBin, { recursive: true })

  await writePkg('package-with-bin', { name: 'package-with-bin', version: '1.0.0', bin: 'bin.js' })
  await fs.writeFile('package-with-bin/bin.js', '#!/usr/bin/env node\nconsole.log(/hi/)\n', 'utf8')

  process.chdir('package-with-bin')

  await link.handler({
    ...DEFAULT_OPTS,
    cliOptions: {
      global: true,
    },
    bin: globalBin,
    dir: globalDir,
  })
  process.env[PATH] = oldPath

  await isExecutable((value) => {
    expect(value).toBeTruthy()
  }, path.join(globalBin, 'package-with-bin'))
})

test('link to global bin from the specified directory', async function () {
  prepare()
  process.chdir('..')

  const globalDir = path.resolve('global')
  const globalBin = path.join(globalDir, 'bin')
  const oldPath = process.env[PATH]
  process.env[PATH] = `${globalBin}${path.delimiter}${oldPath ?? ''}`
  await fs.mkdir(globalBin, { recursive: true })

  await writePkg('./dir/package-with-bin-in-dir', { name: 'package-with-bin-in-dir', version: '1.0.0', bin: 'bin.js' })
  await fs.writeFile('./dir/package-with-bin-in-dir/bin.js', '#!/usr/bin/env node\nconsole.log(/hi/)\n', 'utf8')

  await link.handler({
    ...DEFAULT_OPTS,
    cliOptions: {
      global: true,
      dir: path.resolve('./dir/package-with-bin-in-dir'),
    },
    bin: globalBin,
    dir: globalDir,
  })
  process.env[PATH] = oldPath

  await isExecutable((value) => {
    expect(value).toBeTruthy()
  }, path.join(globalBin, 'package-with-bin-in-dir'))
})

test('link a global package to the specified directory', async function () {
  const project = prepare()
  process.chdir('..')

  const globalDir = path.resolve('global')
  const globalBin = path.join(globalDir, 'bin')
  const oldPath = process.env[PATH]
  process.env[PATH] = `${globalBin}${path.delimiter}${oldPath ?? ''}`
  await fs.mkdir(globalBin, { recursive: true })

  await writePkg('global-package-with-bin', { name: 'global-package-with-bin', version: '1.0.0', bin: 'bin.js' })
  await fs.writeFile('global-package-with-bin/bin.js', '#!/usr/bin/env node\nconsole.log(/hi/)\n', 'utf8')

  process.chdir('global-package-with-bin')

  // link to global
  await link.handler({
    ...DEFAULT_OPTS,
    cliOptions: {
      global: true,
    },
    bin: globalBin,
    dir: globalDir,
  })

  process.chdir('..')

  // link from global
  await link.handler({
    ...DEFAULT_OPTS,
    cliOptions: {
      global: true,
      dir: path.resolve('./project'),
    },
    bin: globalBin,
    dir: globalDir,
  }, ['global-package-with-bin'])

  process.env[PATH] = oldPath

  await project.has('global-package-with-bin')
})

test('relative link', async () => {
  const project = prepare({
    dependencies: {
      '@pnpm.e2e/hello-world-js-bin': '*',
    },
  })

  const linkedPkgName = 'hello-world-js-bin'
  const linkedPkgPath = path.resolve('..', linkedPkgName)

  f.copy(linkedPkgName, linkedPkgPath)
  await link.handler({
    ...DEFAULT_OPTS,
    dir: process.cwd(),
  }, [`../${linkedPkgName}`])

  await project.isExecutable('.bin/hello-world-js-bin')

  // The linked package has been installed successfully as well with bins linked
  // to node_modules/.bin
  const linkedProject = assertProject(linkedPkgPath)
  await linkedProject.isExecutable('.bin/cowsay')

  const wantedLockfile = await project.readLockfile()
  expect(wantedLockfile.dependencies['@pnpm.e2e/hello-world-js-bin']).toStrictEqual({
    specifier: '*', // specifier of linked dependency added to ${WANTED_LOCKFILE}
    version: 'link:../hello-world-js-bin', // link added to wanted lockfile
  })

  const currentLockfile = await project.readCurrentLockfile()
  expect(currentLockfile.dependencies['@pnpm.e2e/hello-world-js-bin'].version).toBe('link:../hello-world-js-bin') // link added to wanted lockfile
})

test('absolute link', async () => {
  const project = prepare({
    dependencies: {
      '@pnpm.e2e/hello-world-js-bin': '*',
    },
  })

  const linkedPkgName = 'hello-world-js-bin'
  const linkedPkgPath = path.resolve('..', linkedPkgName)

  f.copy(linkedPkgName, linkedPkgPath)
  await link.handler({
    ...DEFAULT_OPTS,
    dir: process.cwd(),
  }, [linkedPkgPath])

  await project.isExecutable('.bin/hello-world-js-bin')

  // The linked package has been installed successfully as well with bins linked
  // to node_modules/.bin
  const linkedProject = assertProject(linkedPkgPath)
  await linkedProject.isExecutable('.bin/cowsay')

  const wantedLockfile = await project.readLockfile()
  expect(wantedLockfile.dependencies['@pnpm.e2e/hello-world-js-bin']).toStrictEqual({
    specifier: '*', // specifier of linked dependency added to ${WANTED_LOCKFILE}
    version: 'link:../hello-world-js-bin', // link added to wanted lockfile
  })

  const currentLockfile = await project.readCurrentLockfile()
  expect(currentLockfile.dependencies['@pnpm.e2e/hello-world-js-bin'].version).toBe('link:../hello-world-js-bin') // link added to wanted lockfile
})

test('link --production', async () => {
  const projects = preparePackages([
    {
      name: 'target',
      version: '1.0.0',

      dependencies: {
        'is-positive': '1.0.0',
      },
      devDependencies: {
        'is-negative': '1.0.0',
      },
    },
    {
      name: 'source',
      version: '1.0.0',

      dependencies: {
        'is-positive': '1.0.0',
      },
      devDependencies: {
        'is-negative': '1.0.0',
      },
    },
  ])

  process.chdir('target')

  await install.handler({
    ...DEFAULT_OPTS,
    dir: process.cwd(),
  })
  await link.handler({
    ...DEFAULT_OPTS,
    cliOptions: { production: true },
    dir: process.cwd(),
  }, ['../source'])

  await projects['source'].has('is-positive')
  await projects['source'].hasNot('is-negative')

  // --production should not have effect on the target
  await projects['target'].has('is-positive')
  await projects['target'].has('is-negative')
})

test('link fails if nothing is linked', async () => {
  prepare()

  await expect(
    link.handler({
      ...DEFAULT_OPTS,
      dir: '',
    }, [])
  ).rejects.toThrow(/You must provide a parameter/)
})