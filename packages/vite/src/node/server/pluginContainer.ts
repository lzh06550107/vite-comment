/**
 * This file is refactored into TypeScript based on
 * https://github.com/preactjs/wmr/blob/main/packages/wmr/src/lib/rollup-plugin-container.js
 */

/**
https://github.com/preactjs/wmr/blob/master/LICENSE

MIT License

Copyright (c) 2020 The Preact Authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import fs from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseAst as rollupParseAst } from 'rollup/parseAst'
import type {
  AsyncPluginHooks,
  CustomPluginOptions,
  EmittedFile,
  FunctionPluginHooks,
  InputOptions,
  LoadResult,
  MinimalPluginContext,
  ModuleInfo,
  ModuleOptions,
  NormalizedInputOptions,
  OutputOptions,
  ParallelPluginHooks,
  PartialNull,
  PartialResolvedId,
  ResolvedId,
  RollupError,
  RollupLog,
  PluginContext as RollupPluginContext,
  SourceDescription,
  SourceMap,
  TransformResult,
} from 'rollup'
import type { RawSourceMap } from '@ampproject/remapping'
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'
import MagicString from 'magic-string'
import type { FSWatcher } from 'chokidar'
import colors from 'picocolors'
import type { Plugin } from '../plugin'
import {
  combineSourcemaps,
  createDebugger,
  ensureWatchedFile,
  generateCodeFrame,
  isExternalUrl,
  isObject,
  normalizePath,
  numberToPos,
  prettifyUrl,
  rollupVersion,
  timeFrom,
} from '../utils'
import { FS_PREFIX } from '../constants'
import type { ResolvedConfig } from '../config'
import { createPluginHookUtils, getHookHandler } from '../plugins'
import { cleanUrl, unwrapId } from '../../shared/utils'
import { buildErrorMessage } from './middlewares/error'
import type { ModuleGraph, ModuleNode } from './moduleGraph'

const noop = () => {}

export const ERR_CLOSED_SERVER = 'ERR_CLOSED_SERVER'

export function throwClosedServerError(): never {
  const err: any = new Error(
    'The server is being restarted or closed. Request is outdated',
  )
  err.code = ERR_CLOSED_SERVER
  // This error will be caught by the transform middleware that will
  // send a 504 status code request timeout
  throw err
}

export interface PluginContainerOptions {
  cwd?: string
  output?: OutputOptions
  modules?: Map<string, { info: ModuleInfo }>
  writeFile?: (name: string, source: string | Uint8Array) => void
}

export interface PluginContainer {
  options: InputOptions
  getModuleInfo(id: string): ModuleInfo | null
  buildStart(options: InputOptions): Promise<void>
  resolveId(
    id: string,
    importer?: string,
    options?: {
      attributes?: Record<string, string>
      custom?: CustomPluginOptions
      skip?: Set<Plugin>
      ssr?: boolean
      /**
       * @internal
       */
      scan?: boolean
      isEntry?: boolean
    },
  ): Promise<PartialResolvedId | null>
  transform(
    code: string,
    id: string,
    options?: {
      inMap?: SourceDescription['map']
      ssr?: boolean
    },
  ): Promise<{ code: string; map: SourceMap | { mappings: '' } | null }>
  load(
    id: string,
    options?: {
      ssr?: boolean
    },
  ): Promise<LoadResult | null>
  watchChange(
    id: string,
    change: { event: 'create' | 'update' | 'delete' },
  ): Promise<void>
  close(): Promise<void>
}

type PluginContext = Omit<
  RollupPluginContext,
  // not documented
  'cache'
>

/**
 * 创建一个插件容器的函数，可能是用在类似 Vite 这样的构建工具中。
 * 该函数基于配置 (ResolvedConfig) 来管理插件钩子、模块图以及插件生命周期中的各个阶段（例如：解析、加载、转换和监视）。
 * 这个函数提供了一个环境，插件可以在其中与构建系统进行交互，暴露钩子和工具。
 * @param config
 * @param moduleGraph
 * @param watcher
 */
export async function createPluginContainer(
  config: ResolvedConfig,
  moduleGraph?: ModuleGraph,
  watcher?: FSWatcher,
): Promise<PluginContainer> {
  const {
    plugins,
    logger,
    root,
    build: { rollupOptions },
  } = config
  const { getSortedPluginHooks, getSortedPlugins } =
    createPluginHookUtils(plugins)

  // 这段代码是关于 Vite 中的调试工具的设置，使用了调试库（比如 createDebugger）来创建不同类别的调试器。每个调试器用于跟踪不同的 Vite 过程或插件的行为
  // seenResolves 是一个记录对象，用于跟踪哪些解析操作已经发生过。它的键是字符串（解析的名称或标识符），值是 true 或 undefined
  // true 表示该解析操作已经发生过。
  // undefined 表示该解析操作尚未发生。
  const seenResolves: Record<string, true | undefined> = {}
  // 解析阶段，这个调试器用于跟踪 Vite 在解析阶段的操作，例如文件路径解析、模块解析等
  const debugResolve = createDebugger('vite:resolve')
  // 插件解析和转换阶段，用于调试 Vite 插件的解析过程的调试器
  const debugPluginResolve = createDebugger('vite:plugin-resolve', {
    onlyWhenFocused: 'vite:plugin',
  })
  // 用于调试 Vite 插件的转换过程的调试器
  const debugPluginTransform = createDebugger('vite:plugin-transform', {
    onlyWhenFocused: 'vite:plugin',
  })
  // 从环境变量 DEBUG_VITE_SOURCEMAP_COMBINE_FILTER 获取值。这个值可能用于控制是否启用源映射合并的调试（源映射用于调试原始代码时提供映射关系）
  const debugSourcemapCombineFilter =
    process.env.DEBUG_VITE_SOURCEMAP_COMBINE_FILTER
  // 源映射合并，创建一个新的调试器，用于调试源映射合并过程。这个过程可能涉及将多个源映射合并为一个源映射文件，用于调试时保留模块之间的关系
  const debugSourcemapCombine = createDebugger('vite:sourcemap-combine', {
    onlyWhenFocused: true, // 表示只有在调试聚焦时才会显示该调试信息
  })

  // 可能的应用场景
  // * 调试 Vite 插件：例如，当一个插件的行为不符合预期时，可以使用 debugPluginResolve 和 debugPluginTransform 跟踪插件的解析和转换过程。
  // * 模块解析调试：debugResolve 可以帮助开发者调试 Vite 中的模块解析，查看每个模块如何被解析。
  // * 源映射调试：debugSourcemapCombine 用于调试源映射合并过程，确保最终生成的源映射文件正确，方便开发者调试源代码。
  // DEBUG="vite:resolve,vite:plugin-resolve" npm run dev 同时启用多个调试标签

  // ---------------------------------------------------------------------------

  // watchFiles 是一个集合（Set），用来存储需要被观察的文件路径。这个集合通常用于监控文件变更，当这些文件发生变化时，Vite 会重新构建或触发相应的插件逻辑
  const watchFiles = new Set<string>()
  // _addedFiles from the `load()` hook gets saved here so it can be reused in the `transform()` hook
  const moduleNodeToLoadAddedImports = new WeakMap<
    ModuleNode,
    Set<string> | null
  >()

  // minimalContext 是一个简化版的插件上下文对象，通常用于 Vite 插件的生命周期方法中（如 load 和 transform）
  const minimalContext: MinimalPluginContext = {
    meta: { // 存储元信息
      rollupVersion, // Rollup 的版本
      watchMode: true, // 表示是否在文件监视模式下
    },
    // 这些方法是插件生命周期中用于输出调试信息、警告或错误信息的函数，这里它们都被设置为 noop（即无操作的空函数），表示不输出任何日志
    debug: noop,
    info: noop,
    warn: noop,
    // @ts-expect-error noop
    error: noop,
  }

  // 这个函数用于发出警告，告知某个插件方法（method）在 "serve" 模式下不受支持。serve 模式通常指的是在开发环境中运行时（例如通过 vite dev 启动）。
  // 该函数会生成一条日志，告知开发者这个方法在 serve 模式下不兼容，因此该插件可能不适合与 Vite 一起使用
  function warnIncompatibleMethod(method: string, plugin: string) {
    logger.warn( // 用于输出警告
      // 用于为日志信息着色，增强可读性
      colors.cyan(`[plugin:${plugin}] `) +
        colors.yellow(
          `context method ${colors.bold( // 用于加粗方法名，使其更加突出
            `${method}()`,
          )} is not supported in serve mode. This plugin is likely not vite-compatible.`,
        ),
    )
  }

  // parallel, ignores returns
  /**
   * 用于并行地执行插件钩子（hook），但同时支持某些钩子以顺序方式执行。函数的主要作用是遍历插件列表，执行指定的钩子，处理并发和顺序执行的需求
   * @param hookName 用于并行地执行插件钩子（hook），但同时支持某些钩子以顺序方式执行。函数的主要作用是遍历插件列表，执行指定的钩子，处理并发和顺序执行的需求
   * @param context 要执行的钩子名称，类型为 H，这个类型是 AsyncPluginHooks 和 ParallelPluginHooks 的交集，表示该钩子是异步且支持并行的
   * @param args 一个函数，接收 plugin 作为参数，返回执行钩子时所需要的参数列表，类型为 Parameters<FunctionPluginHooks[H]>
   */
  async function hookParallel<H extends AsyncPluginHooks & ParallelPluginHooks>(
    hookName: H,
    context: (plugin: Plugin) => ThisType<FunctionPluginHooks[H]>,
    args: (plugin: Plugin) => Parameters<FunctionPluginHooks[H]>,
  ): Promise<void> {
    // 一个数组，用来存储并行执行的承诺（Promise）。这些承诺会在钩子被触发时同时执行
    const parallelPromises: Promise<unknown>[] = []
    // 遍历已排序的插件并检查每个插件是否实现了指定的钩子 (hookName)
    for (const plugin of getSortedPlugins(hookName)) {
      // Don't throw here if closed, so buildEnd and closeBundle hooks can finish running
      const hook = plugin[hookName]
      // 如果插件没有实现该钩子，则跳过
      if (!hook) continue

      // 获取该钩子的处理器
      const handler: Function = getHookHandler(hook)
      // 如果钩子设置了 sequential 属性（即顺序执行），则
      if ((hook as { sequential?: boolean }).sequential) {
        await Promise.all(parallelPromises) // 等待所有并行的承诺完成
        parallelPromises.length = 0 // 清空 parallelPromises 数组
        await handler.apply(context(plugin), args(plugin)) // 按顺序执行当前插件的钩子
      } else {
        // 如果钩子没有设置 sequential 属性，则将该钩子的执行推送到 parallelPromises 数组中，等待后续并行执行
        parallelPromises.push(handler.apply(context(plugin), args(plugin)))
      }
    }
    // 在所有插件的钩子执行完之后，使用 await Promise.all(parallelPromises) 来等待所有并行的承诺完成
    await Promise.all(parallelPromises)
  }

  // 这段代码处理与 ModuleInfo 相关的操作，包括对 ModuleInfo 的代理访问，模块元数据的更新以及跟踪模块加载时的导入情况

  // throw when an unsupported ModuleInfo property is accessed,
  // so that incompatible plugins fail in a non-cryptic way.
  // 这个 ProxyHandler 代理对象用于拦截对 ModuleInfo 对象的访问
  const ModuleInfoProxy: ProxyHandler<ModuleInfo> = {
    // get 方法用于处理属性访问
    get(info: any, key: string) {
      if (key in info) {
        // 如果请求的属性在 info 对象中存在，则直接返回该属性
        return info[key]
      }
      // Don't throw an error when returning from an async function
      // 如果请求的属性是 then（可能是一个异步操作或 Promise 的属性），则返回 undefined，避免对异步操作的错误处理
      if (key === 'then') {
        return undefined
      }
      // 如果请求的属性不在 ModuleInfo 中，则抛出错误，提示该属性不被支持。这是为了避免不兼容的插件在访问模块信息时出错
      throw Error(
        `[vite] The "${key}" property of ModuleInfo is not supported.`,
      )
    },
  }

  // same default value of "moduleInfo.meta" as in Rollup
  // EMPTY_OBJECT 是一个被冻结的空对象，用作 meta 属性的默认值。通过冻结对象，防止 meta 被修改
  const EMPTY_OBJECT = Object.freeze({})

  // 它为每个模块创建并返回代理的 ModuleInfo，这样在访问模块的未支持属性时可以触发错误，确保插件在处理模块时不会出错
  function getModuleInfo(id: string) {
    // 用于获取指定模块 ID 的 ModuleInfo
    const module = moduleGraph?.getModuleById(id)
    if (!module) { // 如果没有找到模块，返回 null
      return null
    }
    if (!module.info) { // 如果找到了模块并且 module.info 尚未定义
      module.info = new Proxy(
        { id, meta: module.meta || EMPTY_OBJECT } as ModuleInfo,
        ModuleInfoProxy,
      )
    }
    return module.info
  }

  /**
   * 该函数用于更新指定模块的 meta 属性
   * @param id
   * @param meta
   */
  function updateModuleInfo(id: string, { meta }: { meta?: object | null }) {
    if (meta) {
      // 如果提供了新的 meta 信息，它会通过 getModuleInfo 获取模块的 ModuleInfo 对象，并将新传入的 meta 与当前的 meta 合并，更新 meta
      const moduleInfo = getModuleInfo(id)
      if (moduleInfo) { // 这样，meta 的数据可以在插件间传递和更新
        moduleInfo.meta = { ...moduleInfo.meta, ...meta }
      }
    }
  }

  /**
   * 该函数用于更新模块的加载导入（_addedImports）
   * @param id
   * @param ctx
   */
  function updateModuleLoadAddedImports(id: string, ctx: Context) {
    // 它通过 moduleGraph?.getModuleById(id) 查找模块，如果模块存在，则将该模块与其新增导入（ctx._addedImports）关联起来，
    // 存储在 moduleNodeToLoadAddedImports 的 WeakMap 中
    const module = moduleGraph?.getModuleById(id)
    if (module) {
      moduleNodeToLoadAddedImports.set(module, ctx._addedImports)
    }
  }

  // we should create a new context for each async hook pipeline so that the
  // active plugin in that pipeline can be tracked in a concurrency-safe manner.
  // using a class to make creating new contexts more efficient
  // 这段代码定义了一个 Context 类，用于在插件的生命周期中为每个异步钩子创建新的上下文，确保在并发情况下能够正确追踪当前活跃的插件
  class Context implements PluginContext {
    meta = minimalContext.meta
    ssr = false
    _scan = false
    _activePlugin: Plugin | null
    _activeId: string | null = null
    _activeCode: string | null = null
    _resolveSkips?: Set<Plugin>
    _addedImports: Set<string> | null = null

    // 初始化一个新的 Context 对象，可以选择性地传入一个初始插件（initialPlugin）
    constructor(initialPlugin?: Plugin) {
      this._activePlugin = initialPlugin || null // 指示当前活跃的插件
    }

    // 调用 rollupParseAst 函数将代码解析为抽象语法树（AST）。这通常在代码转换（transform）过程中需要使用
    parse(code: string, opts: any) {
      // code 是待解析的源代码，opts 是解析选项
      return rollupParseAst(code, opts)
    }

    /**
     * 解析模块的 ID，查找模块依赖
     * @param id 解析模块的 ID，查找模块依赖
     * @param importer 导入该模块的模块 ID
     * @param options 包含附加属性，如 attributes、custom、isEntry（是否为入口模块）等
     */
    async resolve(
      id: string,
      importer?: string,
      options?: {
        attributes?: Record<string, string>
        custom?: CustomPluginOptions
        isEntry?: boolean
        skipSelf?: boolean
      },
    ) {
      let skip: Set<Plugin> | undefined
      // 如果 skipSelf 为 false，会将当前活跃的插件排除在解析过程中，避免循环依赖。最终调用 container.resolveId 进行实际的解析
      if (options?.skipSelf !== false && this._activePlugin) {
        skip = new Set(this._resolveSkips)
        skip.add(this._activePlugin)
      }
      let out = await container.resolveId(id, importer, {
        attributes: options?.attributes,
        custom: options?.custom,
        isEntry: !!options?.isEntry,
        skip,
        ssr: this.ssr,
        scan: this._scan,
      })
      if (typeof out === 'string') out = { id: out }
      return out as ResolvedId | null
    }

    /**
     * 加载模块并返回 ModuleInfo 对象
     * @param options options 包含 id（模块 ID），以及其他加载选项
     */
    async load(
      options: {
        id: string
        resolveDependencies?: boolean
      } & Partial<PartialNull<ModuleOptions>>,
    ): Promise<ModuleInfo> {
      // We may not have added this to our module graph yet, so ensure it exists
      // 确保模块已被添加到模块图（moduleGraph）中
      await moduleGraph?.ensureEntryFromUrl(unwrapId(options.id), this.ssr)
      // Not all options passed to this function make sense in the context of loading individual files,
      // but we can at least update the module info properties we support
      updateModuleInfo(options.id, options)

      // 调用 container.load 加载模块代码
      const loadResult = await container.load(options.id, { ssr: this.ssr })
      const code =
        typeof loadResult === 'object' ? loadResult?.code : loadResult
      if (code != null) {
        // 调用 container.transform 对代码进行转换
        await container.transform(code, options.id, { ssr: this.ssr })
      }

      const moduleInfo = this.getModuleInfo(options.id)
      // This shouldn't happen due to calling ensureEntryFromUrl, but 1) our types can't ensure that
      // and 2) moduleGraph may not have been provided (though in the situations where that happens,
      // we should never have plugins calling this.load)
      if (!moduleInfo)
        throw Error(`Failed to load module with id ${options.id}`)
      return moduleInfo
    }

    // 获取模块的元信息（ModuleInfo）
    getModuleInfo(id: string) {
      return getModuleInfo(id)
    }

    // 获取所有模块的 ID
    getModuleIds() {
      return moduleGraph
        ? moduleGraph.idToModuleMap.keys()
        : Array.prototype[Symbol.iterator]()
    }

    // 添加文件到监视列表，以便在文件发生变化时触发重建
    addWatchFile(id: string) {
      watchFiles.add(id)
      ;(this._addedImports || (this._addedImports = new Set())).add(id)
      if (watcher) ensureWatchedFile(watcher, id, root)
    }

    // 返回当前被监视的所有文件
    getWatchFiles() {
      return [...watchFiles]
    }

    // 向构建流程中发出一个文件
    emitFile(assetOrFile: EmittedFile) {
      warnIncompatibleMethod(`emitFile`, this._activePlugin!.name)
      return ''
    }

    // 设置文件的源代码
    setAssetSource() {
      warnIncompatibleMethod(`setAssetSource`, this._activePlugin!.name)
    }

    // 获取文件名
    getFileName() {
      warnIncompatibleMethod(`getFileName`, this._activePlugin!.name)
      return ''
    }

    // 发出警告信息
    warn(
      e: string | RollupLog | (() => string | RollupLog),
      position?: number | { column: number; line: number },
    ) {
      const err = formatError(typeof e === 'function' ? e() : e, position, this)
      const msg = buildErrorMessage(
        err,
        [colors.yellow(`warning: ${err.message}`)],
        false,
      )
      logger.warn(msg, {
        clear: true,
        timestamp: true,
      })
    }

    // 抛出错误
    error(
      e: string | RollupError,
      position?: number | { column: number; line: number },
    ): never {
      // error thrown here is caught by the transform middleware and passed on
      // the the error middleware.
      throw formatError(e, position, this)
    }

    debug = noop
    info = noop
  }

  // 用于格式化和增强 Rollup 错误对象。它会根据错误的上下文（如插件名称、代码位置等）增强错误信息，提供更详细的调试信息。
  function formatError(
    e: string | RollupError,
    position: number | { column: number; line: number } | undefined,
    ctx: Context,
  ) {
    // 如果传入的 e 是一个字符串，则将其转换为 Error 对象
    // 如果传入的 e 已经是 RollupError 对象，则直接使用
    const err = (typeof e === 'string' ? new Error(e) : e) as RollupError
    if (err.pluginCode) {
      return err // The plugin likely called `this.error`
    }
    // 如果当前上下文 (ctx) 中有活跃插件 (_activePlugin)，则将插件的名称添加到错误对象中
    if (ctx._activePlugin) err.plugin = ctx._activePlugin.name
    // 如果当前上下文中有活跃模块 ID (_activeId)，则将其添加到错误对象的 id 字段中
    if (ctx._activeId && !err.id) err.id = ctx._activeId
    // 如果当前上下文中有活跃代码 (_activeCode)，则将其添加到错误对象的 pluginCode 字段中
    if (ctx._activeCode) {
      err.pluginCode = ctx._activeCode

      // some rollup plugins, e.g. json, sets err.position instead of err.pos
      // 如果传入的 position 或 err.pos 为空，则使用 position（位置）来生成具体的错误位置。该位置会被转换为行列信息
      const pos = position ?? err.pos ?? (err as any).position

      if (pos != null) {
        let errLocation
        try {
          errLocation = numberToPos(ctx._activeCode, pos)
        } catch (err2) {
          logger.error(
            colors.red(
              `Error in error handler:\n${err2.stack || err2.message}\n`,
            ),
            // print extra newline to separate the two errors
            { error: err2 },
          )
          throw err
        }
        err.loc = err.loc || {
          file: err.id,
          ...errLocation,
        }
        // 通过调用 generateCodeFrame 函数生成错误发生位置的代码框架（代码片段），并将其赋值给 err.frame
        err.frame = err.frame || generateCodeFrame(ctx._activeCode, pos)
      } else if (err.loc) {
        // css preprocessors may report errors in an included file
        if (!err.frame) {
          let code = ctx._activeCode
          if (err.loc.file) {
            err.id = normalizePath(err.loc.file)
            try {
              code = fs.readFileSync(err.loc.file, 'utf-8')
            } catch {}
          }
          err.frame = generateCodeFrame(code, err.loc)
        }
      } else if ((err as any).line && (err as any).column) {
        err.loc = {
          file: err.id,
          line: (err as any).line,
          column: (err as any).column,
        }
        err.frame = err.frame || generateCodeFrame(ctx._activeCode, err.loc)
      }

      if (
        ctx instanceof TransformContext &&
        typeof err.loc?.line === 'number' &&
        typeof err.loc?.column === 'number'
      ) {
        const rawSourceMap = ctx._getCombinedSourcemap()
        if (rawSourceMap && 'version' in rawSourceMap) {
          const traced = new TraceMap(rawSourceMap as any)
          const { source, line, column } = originalPositionFor(traced, {
            line: Number(err.loc.line),
            column: Number(err.loc.column),
          })
          if (source && line != null && column != null) {
            err.loc = { file: source, line, column }
          }
        }
      }
    } else if (err.loc) {
      if (!err.frame) {
        let code = err.pluginCode
        if (err.loc.file) {
          err.id = normalizePath(err.loc.file)
          if (!code) {
            try {
              code = fs.readFileSync(err.loc.file, 'utf-8')
            } catch {}
          }
        }
        if (code) {
          err.frame = generateCodeFrame(`${code}`, err.loc)
        }
      }
    }

    if (
      typeof err.loc?.column !== 'number' &&
      typeof err.loc?.line !== 'number' &&
      !err.loc?.file
    ) {
      delete err.loc
    }

    return err
  }

  // 这段代码定义了 TransformContext 类，它继承自 Context 类，并且专注于处理代码转换和 Sourcemap 合并的功能
  class TransformContext extends Context {
    filename: string // 当前模块的文件名
    originalCode: string // 原始的源代码字符串
    originalSourcemap: SourceMap | null = null // 原始的 Sourcemap（如果有的话），用于源映射
    sourcemapChain: NonNullable<SourceDescription['map']>[] = [] // 一个数组，用于存储当前模块的 Sourcemap 链
    combinedMap: SourceMap | { mappings: '' } | null = null // 合并后的 Sourcemap，最后将所有的源映射合并成一个最终的 Sourcemap

    /**
     * 构造函数
     * @param id 当前模块的标识符（即文件名）
     * @param code 原始的源代码
     * @param inMap 可选参数，传入的 Sourcemap，用于合并
     */
    constructor(id: string, code: string, inMap?: SourceMap | string) {
      super()
      this.filename = id
      this.originalCode = code
      if (inMap) {
        if (debugSourcemapCombine) {
          // @ts-expect-error inject name for debug purpose
          inMap.name = '$inMap'
        }
        this.sourcemapChain.push(inMap)
      }
      // Inherit `_addedImports` from the `load()` hook
      const node = moduleGraph?.getModuleById(id)
      if (node) {
        this._addedImports = moduleNodeToLoadAddedImports.get(node) ?? null
      }
    }

    /**
     * 获取合并的 Sourcemap。主要用于合并多个 Sourcemap，返回一个最终合并后的 Sourcemap。它会遍历 sourcemapChain 中的每一个 Sourcemap，将它们合并成一个
     */
    _getCombinedSourcemap() {
      if (
        debugSourcemapCombine &&
        debugSourcemapCombineFilter &&
        this.filename.includes(debugSourcemapCombineFilter)
      ) {
        debugSourcemapCombine('----------', this.filename)
        debugSourcemapCombine(this.combinedMap)
        debugSourcemapCombine(this.sourcemapChain)
        debugSourcemapCombine('----------')
      }

      let combinedMap = this.combinedMap
      // { mappings: '' }
      if (
        combinedMap &&
        !('version' in combinedMap) &&
        combinedMap.mappings === ''
      ) {
        this.sourcemapChain.length = 0
        return combinedMap
      }

      for (let m of this.sourcemapChain) {
        if (typeof m === 'string') m = JSON.parse(m)
        if (!('version' in (m as SourceMap))) {
          // { mappings: '' }
          if ((m as SourceMap).mappings === '') {
            combinedMap = { mappings: '' }
            break
          }
          // empty, nullified source map
          combinedMap = null
          break
        }
        if (!combinedMap) {
          const sm = m as SourceMap
          // sourcemap should not include `sources: [null]` (because `sources` should be string) nor
          // `sources: ['']` (because `''` means the path of sourcemap)
          // but MagicString generates this when `filename` option is not set.
          // Rollup supports these and therefore we support this as well
          if (sm.sources.length === 1 && !sm.sources[0]) {
            combinedMap = {
              ...sm,
              sources: [this.filename],
              sourcesContent: [this.originalCode],
            }
          } else {
            combinedMap = sm
          }
        } else {
          combinedMap = combineSourcemaps(cleanUrl(this.filename), [
            m as RawSourceMap,
            combinedMap as RawSourceMap,
          ]) as SourceMap
        }
      }
      if (combinedMap !== this.combinedMap) {
        this.combinedMap = combinedMap
        this.sourcemapChain.length = 0
      }
      return this.combinedMap
    }

    // 生成最终的 Sourcemap
    getCombinedSourcemap() {
      const map = this._getCombinedSourcemap()
      if (!map || (!('version' in map) && map.mappings === '')) {
        return new MagicString(this.originalCode).generateMap({
          includeContent: true,
          hires: 'boundary',
          source: cleanUrl(this.filename),
        })
      }
      return map
    }
  }

  // 用于标记服务器是否已经关闭。虽然在这段代码中没有直接使用 closed，但它可能是为了后续在关闭服务器时防止新的钩子被处理
  let closed = false
  // 一个 Set 集合，用于存储当前正在处理的 Promise。该集合用于跟踪正在等待的异步任务
  const processesing = new Set<Promise<any>>()
  // keeps track of hook promises so that we can wait for them all to finish upon closing the server
  function handleHookPromise<T>(maybePromise: undefined | T | Promise<T>) {
    // 用来判断 maybePromise 是否是一个 Promise。它通过检查 maybePromise 是否具有 then 方法来判断该对象是否为 Promise。如果是 Promise，then 方法将会被定义
    if (!(maybePromise as any)?.then) {
      return maybePromise
    }
    // 如果传入的参数是一个 Promise，那么它将被转换为 Promise<T> 类型，并且被添加到 processesing 集合中进行跟踪
    const promise = maybePromise as Promise<T>
    processesing.add(promise)
    // 无论 Promise 最终是成功还是失败，都会执行 finally 回调，在回调中删除 processesing 集合中的该 Promise。这确保了即使 Promise 完成，集合中的追踪也会被清理。
    return promise.finally(() => processesing.delete(promise))
  }

  // 代码定义了一个 PluginContainer 对象，它代表了一个插件系统的核心部分，处理插件生命周期中的各个钩子（hook），
  // 如 buildStart、resolveId、load、transform 等，并执行异步处理。它还提供了钩子并发处理、错误捕获和最终构建/关闭流程
  const container: PluginContainer = {
    // 使用 getSortedPluginHooks('options') 依次执行插件的 options 钩子，最终返回插件配置对象
    options: await (async () => {
      let options = rollupOptions
      for (const optionsHook of getSortedPluginHooks('options')) {
        if (closed) throwClosedServerError()
        // 用于处理插件钩子返回的 Promise，确保所有异步任务在关闭服务器前完成，避免服务器提前关闭而导致异步操作未完成
        options =
          (await handleHookPromise(
            optionsHook.call(minimalContext, options),
          )) || options
      }
      return options
    })(),

    // 返回模块的元数据，存储了有关模块的信息
    getModuleInfo,

    // 在构建开始时调用所有插件的 buildStart 钩子。异步执行钩子并确保所有钩子执行完毕
    async buildStart() {
      await handleHookPromise(
        hookParallel(
          'buildStart',
          (plugin) => new Context(plugin),
          () => [container.options as NormalizedInputOptions],
        ),
      )
    },

    /**
     * 解析模块 ID。插件通过 resolveId 钩子返回模块 ID，resolveId 钩子链中的第一个非空结果会立即返回。
     * @param rawId
     * @param importer
     * @param options
     */
    async resolveId(rawId, importer = join(root, 'index.html'), options) {
      const skip = options?.skip
      const ssr = options?.ssr
      const scan = !!options?.scan
      const ctx = new Context()
      ctx.ssr = !!ssr
      ctx._scan = scan
      ctx._resolveSkips = skip
      const resolveStart = debugResolve ? performance.now() : 0
      let id: string | null = null
      const partial: Partial<PartialResolvedId> = {}
      // 钩子链中每个插件的 resolveId 都会被依次调用，直到返回有效的 ID
      for (const plugin of getSortedPlugins('resolveId')) {
        if (closed && !ssr) throwClosedServerError()
        if (!plugin.resolveId) continue
        // 如果插件配置了 skip，则跳过相应插件的处理
        if (skip?.has(plugin)) continue

        ctx._activePlugin = plugin

        const pluginResolveStart = debugPluginResolve ? performance.now() : 0
        const handler = getHookHandler(plugin.resolveId)
        const result = await handleHookPromise(
          handler.call(ctx as any, rawId, importer, {
            attributes: options?.attributes ?? {},
            custom: options?.custom,
            isEntry: !!options?.isEntry,
            ssr,
            scan,
          }),
        )
        if (!result) continue

        if (typeof result === 'string') {
          id = result
        } else {
          id = result.id
          Object.assign(partial, result)
        }

        debugPluginResolve?.(
          timeFrom(pluginResolveStart),
          plugin.name,
          prettifyUrl(id, root),
        )

        // resolveId() is hookFirst - first non-null result is returned.
        break
      }

      if (debugResolve && rawId !== id && !rawId.startsWith(FS_PREFIX)) {
        const key = rawId + id
        // avoid spamming
        if (!seenResolves[key]) {
          seenResolves[key] = true
          debugResolve(
            `${timeFrom(resolveStart)} ${colors.cyan(rawId)} -> ${colors.dim(
              id,
            )}`,
          )
        }
      }

      if (id) {
        partial.id = isExternalUrl(id) ? id : normalizePath(id)
        return partial as PartialResolvedId
      } else {
        return null
      }
    },

    /**
     * 加载模块内容，调用每个插件的 load 钩子并返回处理结果。如果插件返回 null 或 undefined，继续调用下一个插件的 load 钩子
     * @param id
     * @param options
     */
    async load(id, options) {
      const ssr = options?.ssr
      const ctx = new Context()
      ctx.ssr = !!ssr
      for (const plugin of getSortedPlugins('load')) {
        if (closed && !ssr) throwClosedServerError()
        if (!plugin.load) continue
        ctx._activePlugin = plugin
        const handler = getHookHandler(plugin.load)
        const result = await handleHookPromise(
          handler.call(ctx as any, id, { ssr }),
        )
        if (result != null) {
          if (isObject(result)) {
            updateModuleInfo(id, result)
          }
          updateModuleLoadAddedImports(id, ctx)
          return result
        }
      }
      updateModuleLoadAddedImports(id, ctx)
      return null
    },

    /**
     * 处理代码转换，调用插件的 transform 钩子，处理代码并生成最终的输出。插件可以通过返回代码和 source map 进行处理
     * @param code
     * @param id
     * @param options
     */
    async transform(code, id, options) {
      const inMap = options?.inMap
      const ssr = options?.ssr
      const ctx = new TransformContext(id, code, inMap as SourceMap)
      ctx.ssr = !!ssr
      for (const plugin of getSortedPlugins('transform')) {
        if (closed && !ssr) throwClosedServerError()
        if (!plugin.transform) continue
        ctx._activePlugin = plugin
        ctx._activeId = id
        ctx._activeCode = code
        const start = debugPluginTransform ? performance.now() : 0
        let result: TransformResult | string | undefined
        const handler = getHookHandler(plugin.transform)
        try {
          result = await handleHookPromise(
            handler.call(ctx as any, code, id, { ssr }),
          )
        } catch (e) {
          ctx.error(e)
        }
        if (!result) continue
        debugPluginTransform?.(
          timeFrom(start),
          plugin.name,
          prettifyUrl(id, root),
        )
        if (isObject(result)) {
          if (result.code !== undefined) {
            code = result.code
            if (result.map) { // 如果插件返回 map，会更新源映射链并最终合并所有的 sourcemaps
              if (debugSourcemapCombine) {
                // @ts-expect-error inject plugin name for debug purpose
                result.map.name = plugin.name
              }
              ctx.sourcemapChain.push(result.map)
            }
          }
          updateModuleInfo(id, result)
        } else {
          code = result
        }
      }
      return {
        code,
        map: ctx._getCombinedSourcemap(),
      }
    },

    /**
     * 监听文件变更，调用所有插件的 watchChange 钩子
     * @param id
     * @param change
     */
    async watchChange(id, change) {
      const ctx = new Context()
      await hookParallel(
        'watchChange',
        () => ctx,
        () => [id, change],
      )
    },

    /**
     * 关闭插件容器，执行 buildEnd 和 closeBundle 钩子，确保所有异步操作完成后关闭
     */
    async close() {
      if (closed) return
      closed = true
      await Promise.allSettled(Array.from(processesing))
      const ctx = new Context()
      await hookParallel(
        'buildEnd',
        () => ctx,
        () => [],
      )
      await hookParallel(
        'closeBundle',
        () => ctx,
        () => [],
      )
    },
  }

  return container
}
