import aliasPlugin, { type ResolverFunction } from '@rollup/plugin-alias'
import type { ObjectHook } from 'rollup'
import type { PluginHookUtils, ResolvedConfig } from '../config'
import { isDepsOptimizerEnabled } from '../config'
import type { HookHandler, Plugin, PluginWithRequiredHook } from '../plugin'
import { getDepsOptimizer } from '../optimizer'
import { shouldExternalizeForSSR } from '../ssr/ssrExternal'
import { watchPackageDataPlugin } from '../packages'
import { getFsUtils } from '../fsUtils'
import { jsonPlugin } from './json'
import { resolvePlugin } from './resolve'
import { optimizedDepsPlugin } from './optimizedDeps'
import { esbuildPlugin } from './esbuild'
import { importAnalysisPlugin } from './importAnalysis'
import { cssAnalysisPlugin, cssPlugin, cssPostPlugin } from './css'
import { assetPlugin } from './asset'
import { clientInjectionsPlugin } from './clientInjections'
import { buildHtmlPlugin, htmlInlineProxyPlugin } from './html'
import { wasmFallbackPlugin, wasmHelperPlugin } from './wasm'
import { modulePreloadPolyfillPlugin } from './modulePreloadPolyfill'
import { webWorkerPlugin } from './worker'
import { preAliasPlugin } from './preAlias'
import { definePlugin } from './define'
import { workerImportMetaUrlPlugin } from './workerImportMetaUrl'
import { assetImportMetaUrlPlugin } from './assetImportMetaUrl'
import { metadataPlugin } from './metadata'
import { dynamicImportVarsPlugin } from './dynamicImportVars'
import { importGlobPlugin } from './importMetaGlob'

export async function resolvePlugins(
  config: ResolvedConfig,
  prePlugins: Plugin[],
  normalPlugins: Plugin[],
  postPlugins: Plugin[],
): Promise<Plugin[]> {
  const isBuild = config.command === 'build'
  const isWorker = config.isWorker
  const buildPlugins = isBuild
    ? await (await import('../build')).resolveBuildPlugins(config)
    : { pre: [], post: [] }
  const { modulePreload } = config.build
  const depsOptimizerEnabled =
    !isBuild &&
    (isDepsOptimizerEnabled(config, false) ||
      isDepsOptimizerEnabled(config, true))
  return [
    depsOptimizerEnabled ? optimizedDepsPlugin(config) : null,
    isBuild ? metadataPlugin() : null,
    !isWorker ? watchPackageDataPlugin(config.packageCache) : null,
    preAliasPlugin(config),
    aliasPlugin({
      entries: config.resolve.alias,
      customResolver: viteAliasCustomResolver,
    }),
    ...prePlugins,
    modulePreload !== false && modulePreload.polyfill
      ? modulePreloadPolyfillPlugin(config)
      : null,
    resolvePlugin({
      ...config.resolve,
      root: config.root,
      isProduction: config.isProduction,
      isBuild,
      packageCache: config.packageCache,
      ssrConfig: config.ssr,
      asSrc: true,
      fsUtils: getFsUtils(config),
      getDepsOptimizer: isBuild
        ? undefined
        : (ssr: boolean) => getDepsOptimizer(config, ssr),
      shouldExternalize:
        isBuild && config.build.ssr
          ? (id, importer) => shouldExternalizeForSSR(id, importer, config)
          : undefined,
    }),
    htmlInlineProxyPlugin(config),
    cssPlugin(config),
    config.esbuild !== false ? esbuildPlugin(config) : null,
    jsonPlugin(
      {
        namedExports: true,
        ...config.json,
      },
      isBuild,
    ),
    wasmHelperPlugin(config),
    webWorkerPlugin(config),
    assetPlugin(config),
    ...normalPlugins,
    wasmFallbackPlugin(),
    definePlugin(config),
    cssPostPlugin(config),
    isBuild && buildHtmlPlugin(config),
    workerImportMetaUrlPlugin(config),
    assetImportMetaUrlPlugin(config),
    ...buildPlugins.pre,
    dynamicImportVarsPlugin(config),
    importGlobPlugin(config),
    ...postPlugins,
    ...buildPlugins.post,
    // internal server-only plugins are always applied after everything else
    ...(isBuild
      ? []
      : [
          clientInjectionsPlugin(config),
          cssAnalysisPlugin(config),
          importAnalysisPlugin(config),
        ]),
  ].filter(Boolean) as Plugin[]
}

/**
 * 用于对插件的钩子进行排序和管理。它的作用是确保插件按钩子顺序正确执行，并提供获取插件钩子的功能。
 * 返回值：返回一个包含两个方法的对象，getSortedPlugins 和 getSortedPluginHooks，这两个方法可以帮助获取按钩子排序后的插件及其钩子
 * @param plugins
 */
export function createPluginHookUtils(
  plugins: readonly Plugin[],
): PluginHookUtils {
  // sort plugins per hook
  // sortedPluginsCache 是一个 Map，用于缓存按钩子排序后的插件列表。hookName 作为 Map 的键，插件数组作为值。这样做可以避免每次获取插件时都进行排序，提高性能
  const sortedPluginsCache = new Map<keyof Plugin, Plugin[]>()

  /**
   * 根据给定的 hookName 获取排序后的插件列表
   * 返回值：返回一个排序后的插件列表，这些插件包含了某个特定钩子的处理函数
   * @param hookName
   */
  function getSortedPlugins<K extends keyof Plugin>(
    hookName: K,
  ): PluginWithRequiredHook<K>[] {
    if (sortedPluginsCache.has(hookName))
      return sortedPluginsCache.get(hookName) as PluginWithRequiredHook<K>[]
    const sorted = getSortedPluginsByHook(hookName, plugins)
    sortedPluginsCache.set(hookName, sorted)
    return sorted
  }

  /**
   * 返回值：返回一个排序后的插件列表，这些插件包含了某个特定钩子的处理函数
   * @param hookName
   */
  function getSortedPluginHooks<K extends keyof Plugin>(
    hookName: K,
  ): NonNullable<HookHandler<Plugin[K]>>[] {
    const plugins = getSortedPlugins(hookName)
    return plugins.map((p) => getHookHandler(p[hookName])).filter(Boolean)
  }

  return {
    getSortedPlugins,
    getSortedPluginHooks,
  }
}

/**
 * 用于根据钩子的顺序来排序插件数组。它确保插件按照特定的顺序（预先定义的 pre、normal 和 post）被排序，以便在执行时按照指定顺序调用相应的钩子函数
 * @param hookName 钩子的名称，用于提取插件对象中的特定钩子
 * @param plugins 插件数组，类型为 readonly Plugin[]，即一个只读的插件数组
 * 返回值类型是一个经过排序后的插件数组，类型为 PluginWithRequiredHook<K>[]，即插件数组中的每个插件都保证实现了特定钩子（K）
 */
export function getSortedPluginsByHook<K extends keyof Plugin>(
  hookName: K, // K 是一个泛型类型，它约束了钩子名称 hookName 的类型，必须是 Plugin 对象中有效的钩子名（例如 'config'、'build' 等）
  plugins: readonly Plugin[],
): PluginWithRequiredHook<K>[] {
  const sortedPlugins: Plugin[] = [] // 用于存储按顺序排列后的插件
  // Use indexes to track and insert the ordered plugins directly in the
  // resulting array to avoid creating 3 extra temporary arrays per hook
  // pre, normal, post 是用来追踪插件插入顺序的索引，分别对应插入到插件数组的预先位置（pre）、常规位置（normal）和后置位置（post）
  let pre = 0,
    normal = 0,
    post = 0
  // 遍历插件数组并排序
  for (const plugin of plugins) {
    // 遍历所有插件，检查每个插件是否有指定的钩子（通过 plugin[hookName] 获取）
    const hook = plugin[hookName]
    if (hook) {
      // 如果插件定义了该钩子且钩子的类型是 object（例如包含 order 属性），则根据钩子的 order 属性决定插件插入的位置：
      if (typeof hook === 'object') {
        if (hook.order === 'pre') {
          // 如果 order 为 'pre'，则插入到 pre 索引位置之前，优先执行
          sortedPlugins.splice(pre++, 0, plugin)
          continue
        }
        if (hook.order === 'post') {
          // 如果 order 为 'post'，则插入到 pre + normal + post 索引位置之后，后执行
          sortedPlugins.splice(pre + normal + post++, 0, plugin)
          continue
        }
      }
      // 如果钩子没有定义 order 或是 order 不为 'pre' 或 'post'，则默认插入到 normal 索引位置
      sortedPlugins.splice(pre + normal++, 0, plugin)
    }
  }

  // 返回排序后的插件数组，确保每个插件都实现了传入的钩子（hookName）
  return sortedPlugins as PluginWithRequiredHook<K>[]
}

/**
 * 作用是从一个钩子对象中获取钩子的处理函数。如果提供的钩子是一个对象，它会从对象中提取 handler 函数；如果钩子本身就是一个函数，它直接返回该函数
 * @param hook
 */
export function getHookHandler<T extends ObjectHook<Function>>(
  hook: T,
): HookHandler<T> {
  return (typeof hook === 'object' ? hook.handler : hook) as HookHandler<T>
}

// Same as `@rollup/plugin-alias` default resolver, but we attach additional meta
// if we can't resolve to something, which will error in `importAnalysis`
export const viteAliasCustomResolver: ResolverFunction = async function (
  id,
  importer,
  options,
) {
  const resolved = await this.resolve(id, importer, options)
  return resolved || { id, meta: { 'vite:alias': { noResolved: true } } }
}
