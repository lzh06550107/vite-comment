import { EventEmitter } from 'node:events'
import path from 'node:path'
import glob from 'fast-glob'
import type { FSWatcher, WatchOptions } from 'dep-types/chokidar'
import type { OutputOptions } from 'rollup'
import * as colors from 'picocolors'
import { withTrailingSlash } from '../shared/utils'
import { arraify, normalizePath } from './utils'
import type { ResolvedConfig } from './config'
import type { Logger } from './logger'

/*
它用于解析和返回最终的输出目录。根据传入的参数，函数会确定是否需要返回多个输出目录（outputOptions 可能是数组或单个对象），并确保返回的是绝对路径。

getResolvedOutDirs 函数根据提供的 root（项目根目录）、outDir（默认输出目录）和 outputOptions（可选的输出配置）解析并返回一个包含所有有效输出目录路径的 Set。
如果没有提供 outputOptions，则只返回默认的输出目录。函数确保所有输出目录路径是唯一且是绝对路径
**/
export function getResolvedOutDirs(
  root: string,
  outDir: string,
  outputOptions: OutputOptions[] | OutputOptions | undefined,
): Set<string> {
  const resolvedOutDir = path.resolve(root, outDir)
  if (!outputOptions) return new Set([resolvedOutDir])

  return new Set(
    arraify(outputOptions).map(({ dir }) =>
      dir ? path.resolve(root, dir) : resolvedOutDir,
    ),
  )
}

/**
 定义了一个名为 resolveEmptyOutDir 的函数，它用于解析是否应该清空输出目录。函数会根据提供的 emptyOutDir、root（项目根目录）、outDirs（输出目录集合）来决定返回值。
 如果 emptyOutDir 没有明确指定（即为 null 或 undefined），则会根据某些规则来决定是否清空输出目录
*/
export function resolveEmptyOutDir(
  emptyOutDir: boolean | null,
  root: string,
  outDirs: Set<string>,
  logger?: Logger,
): boolean {
  if (emptyOutDir != null) return emptyOutDir

  for (const outDir of outDirs) {
    if (!normalizePath(outDir).startsWith(withTrailingSlash(root))) {
      // warn if outDir is outside of root
      logger?.warn(
        colors.yellow(
          `\n${colors.bold(`(!)`)} outDir ${colors.white(
            colors.dim(outDir),
          )} is not inside project root and will not be emptied.\n` +
            `Use --emptyOutDir to override.\n`,
        ),
      )
      return false
    }
  }
  return true
}

/**
 * 用于解析文件监视器（chokidar）的选项，特别是忽略的文件和目录。chokidar 是一个高效的 Node.js 文件系统监视库，常用于监控文件变化。
 * config: 已解析的配置对象 (ResolvedConfig)，其中包含了 cacheDir 等配置项。
 * options: WatchOptions，传递给 chokidar 的其他监视选项。可能为 undefined。
 * resolvedOutDirs: 一个 Set，包含已解析的输出目录路径。
 * emptyOutDir: 布尔值，指示是否清空输出目录。
 *
 * resolveChokidarOptions 函数的作用是构建 chokidar 的配置选项，特别是决定哪些文件和目录需要被忽略。它会根据以下几个因素调整 ignored 配置：
 *
 * 默认忽略 .git、node_modules、test-results 和缓存目录。
 * 如果 emptyOutDir 为 true，则忽略输出目录。
 * 合并传入的其他 options 配置。
 * 最终，返回一个完整的 WatchOptions 对象，用于 chokidar 监控文件变化
 */
export function resolveChokidarOptions(
  config: ResolvedConfig,
  options: WatchOptions | undefined,
  resolvedOutDirs: Set<string>,
  emptyOutDir: boolean,
): WatchOptions {
  const { ignored: ignoredList, ...otherOptions } = options ?? {}
  const ignored: WatchOptions['ignored'] = [
    '**/.git/**',
    '**/node_modules/**',
    '**/test-results/**', // Playwright
    glob.escapePath(config.cacheDir) + '/**',
    ...arraify(ignoredList || []),
  ]
  if (emptyOutDir) {
    ignored.push(
      ...[...resolvedOutDirs].map((outDir) => glob.escapePath(outDir) + '/**'),
    )
  }

  const resolvedWatchOptions: WatchOptions = {
    ignored,
    ignoreInitial: true,
    ignorePermissionErrors: true,
    ...otherOptions,
  }

  return resolvedWatchOptions
}

class NoopWatcher extends EventEmitter implements FSWatcher {
  constructor(public options: WatchOptions) {
    super()
  }

  add() {
    return this
  }

  unwatch() {
    return this
  }

  getWatched() {
    return {}
  }

  ref() {
    return this
  }

  unref() {
    return this
  }

  async close() {
    // noop
  }
}

export function createNoopWatcher(options: WatchOptions): FSWatcher {
  return new NoopWatcher(options)
}
