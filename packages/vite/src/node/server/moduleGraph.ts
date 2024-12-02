import { extname } from 'node:path'
import type { ModuleInfo, PartialResolvedId } from 'rollup'
import { isDirectCSSRequest } from '../plugins/css'
import {
  normalizePath,
  removeImportQuery,
  removeTimestampQuery,
} from '../utils'
import { FS_PREFIX } from '../constants'
import { cleanUrl } from '../../shared/utils'
import type { TransformResult } from './transformRequest'

// 这段代码定义了 ModuleNode 和 ModuleGraph 两个类，分别用于表示单个模块节点和模块图。
// 在模块化开发和构建过程中，ModuleGraph 维护了各个模块之间的依赖关系以及它们的状态，提供了高效的模块解析和更新机制。

// 实现了一个强大的模块图系统，能够高效管理模块之间的依赖关系。ModuleNode 负责表示单个模块的状态和信息，而 ModuleGraph 则管理这些模块，提供解析、更新、失效等操作

// ModuleNode 代表一个模块节点，包含该模块的各种信息，包括模块的 URL、ID、类型、导入的模块、热更新相关信息等
export class ModuleNode {
  /**
   * Public served url path, starts with /
   */
  url: string // 模块的公开 URL 路径，通常以 / 开头
  /**
   * Resolved file system path + query
   * 模块的解析后的文件系统路径，可能包括查询字符串（例如 HMR 时间戳等）
   */
  id: string | null = null
  file: string | null = null // 文件路径，可以是 id 的清理版本
  type: 'js' | 'css' // 模块类型，可能是 'js' 或 'css'
  info?: ModuleInfo // 模块的 rollup 信息
  meta?: Record<string, any> // 模块的元数据，包含附加的自定义信息
  importers = new Set<ModuleNode>() // 导入当前模块的其他模块的集合
  clientImportedModules = new Set<ModuleNode>() // 当前模块在客户端的依赖模块集合
  ssrImportedModules = new Set<ModuleNode>() // 当前模块在 SSR（服务器端渲染）中的依赖模块集合
  acceptedHmrDeps = new Set<ModuleNode>() // 当前模块接受热更新的依赖模块集合
  acceptedHmrExports: Set<string> | null = null // 当前模块接受热更新的导出项集合
  importedBindings: Map<string, Set<string>> | null = null // 当前模块导入的绑定信息
  isSelfAccepting?: boolean // 是否自我接受热更新的标志
  transformResult: TransformResult | null = null // 当前模块的转换结果（如转换后的代码）
  ssrTransformResult: TransformResult | null = null // SSR 渲染时的转换结果
  ssrModule: Record<string, any> | null = null // SSR 渲染时的模块信息
  ssrError: Error | null = null // SSR 渲染时的错误
  lastHMRTimestamp = 0 // 上一次热更新的时间戳
  /**
   * `import.meta.hot.invalidate` is called by the client.
   * If there's multiple clients, multiple `invalidate` request is received.
   * This property is used to dedupe those request to avoid multiple updates happening.
   * @internal
   */
  lastHMRInvalidationReceived = false // 是否收到热更新失效的请求
  lastInvalidationTimestamp = 0 // 上一次失效的时间戳
  /**
   * If the module only needs to update its imports timestamp (e.g. within an HMR chain),
   * it is considered soft-invalidated. In this state, its `transformResult` should exist,
   * and the next `transformRequest` for this module will replace the timestamps.
   *
   * By default the value is `undefined` if it's not soft/hard-invalidated. If it gets
   * soft-invalidated, this will contain the previous `transformResult` value. If it gets
   * hard-invalidated, this will be set to `'HARD_INVALIDATED'`.
   * @internal
   */
  invalidationState: TransformResult | 'HARD_INVALIDATED' | undefined // 模块的失效状态。可能的值包括 undefined（未失效）、'HARD_INVALIDATED'（硬失效）
  /**
   * @internal
   */
  ssrInvalidationState: TransformResult | 'HARD_INVALIDATED' | undefined // SSR 渲染时的失效状态
  /**
   * The module urls that are statically imported in the code. This information is separated
   * out from `importedModules` as only importers that statically import the module can be
   * soft invalidated. Other imports (e.g. watched files) needs the importer to be hard invalidated.
   * @internal
   */
  staticImportedUrls?: Set<string> // 当前模块在代码中静态导入的 URL 列表

  /**
   * @param setIsSelfAccepting - set `false` to set `isSelfAccepting` later. e.g. #7870
   * 构造函数接受模块的 url 和一个可选的 setIsSelfAccepting 参数，后者用于设置 isSelfAccepting 属性，指示模块是否自我接受热更新
   */
  constructor(url: string, setIsSelfAccepting = true) {
    this.url = url
    this.type = isDirectCSSRequest(url) ? 'css' : 'js'
    if (setIsSelfAccepting) {
      this.isSelfAccepting = false
    }
  }

  /**
   * 这是一个 getter 方法，返回当前模块导入的所有模块，包括客户端和 SSR 的依赖模块。
   */
  get importedModules(): Set<ModuleNode> {
    const importedModules = new Set(this.clientImportedModules)
    for (const module of this.ssrImportedModules) {
      importedModules.add(module)
    }
    return importedModules
  }
}

export type ResolvedUrl = [
  url: string,
  resolvedId: string,
  meta: object | null | undefined,
]

// ModuleGraph 代表整个模块图，维护了所有模块的关系，管理模块的解析、失效和更新等操作
export class ModuleGraph {
  // url 到 ModuleNode 的映射
  urlToModuleMap = new Map<string, ModuleNode>()
  // id 到 ModuleNode 的映射
  idToModuleMap = new Map<string, ModuleNode>()
  // etag 到 ModuleNode 的映射，用于缓存模块
  etagToModuleMap = new Map<string, ModuleNode>()
  // a single file may corresponds to multiple modules with different queries
  // file 到模块集合的映射
  fileToModulesMap = new Map<string, Set<ModuleNode>>()
  // 存储 “安全” 模块的路径
  safeModulesPath = new Set<string>()

  /**
   * @internal 存储尚未解析的模块的 URL 映射
   */
  _unresolvedUrlToModuleMap = new Map<
    string,
    Promise<ModuleNode> | ModuleNode
  >()
  /**
   * @internal 存储 SSR 环境下尚未解析的模块的 URL 映射
   */
  _ssrUnresolvedUrlToModuleMap = new Map<
    string,
    Promise<ModuleNode> | ModuleNode
  >()

  /** @internal 存储解析失败的模块 */
  _hasResolveFailedErrorModules = new Set<ModuleNode>()

  constructor(
    private resolveId: (
      url: string,
      ssr: boolean,
    ) => Promise<PartialResolvedId | null>,
  ) {}

  /**
   * 通过原始 URL 获取对应的模块。如果模块尚未解析，会尝试解析
   * @param rawUrl
   * @param ssr
   */
  async getModuleByUrl(
    rawUrl: string,
    ssr?: boolean,
  ): Promise<ModuleNode | undefined> {
    // Quick path, if we already have a module for this rawUrl (even without extension)
    rawUrl = removeImportQuery(removeTimestampQuery(rawUrl))
    const mod = this._getUnresolvedUrlToModule(rawUrl, ssr)
    if (mod) {
      return mod
    }

    const [url] = await this._resolveUrl(rawUrl, ssr)
    return this.urlToModuleMap.get(url)
  }

  /**
   * 通过模块的 id 获取对应的模块
   * @param id
   */
  getModuleById(id: string): ModuleNode | undefined {
    return this.idToModuleMap.get(removeTimestampQuery(id))
  }

  /**
   * 获取与指定文件相关的模块集合
   * @param file
   */
  getModulesByFile(file: string): Set<ModuleNode> | undefined {
    return this.fileToModulesMap.get(file)
  }

  /**
   * 当文件发生变化时，通知图中的所有模块进行失效处理
   * @param file
   */
  onFileChange(file: string): void {
    const mods = this.getModulesByFile(file)
    if (mods) {
      const seen = new Set<ModuleNode>()
      mods.forEach((mod) => {
        this.invalidateModule(mod, seen)
      })
    }
  }

  /**
   * 当文件被删除时，删除相关模块的导入信息
   * @param file
   */
  onFileDelete(file: string): void {
    const mods = this.getModulesByFile(file)
    if (mods) {
      mods.forEach((mod) => {
        mod.importedModules.forEach((importedMod) => {
          importedMod.importers.delete(mod)
        })
      })
    }
  }

  /**
   * 使指定模块失效（可以是软失效或硬失效）
   * @param mod
   * @param seen
   * @param timestamp
   * @param isHmr
   * @param softInvalidate
   */
  invalidateModule(
    mod: ModuleNode,
    seen: Set<ModuleNode> = new Set(),
    timestamp: number = Date.now(),
    isHmr: boolean = false,
    /** @internal */
    softInvalidate = false,
  ): void {
    const prevInvalidationState = mod.invalidationState
    const prevSsrInvalidationState = mod.ssrInvalidationState

    // Handle soft invalidation before the `seen` check, as consecutive soft/hard invalidations can
    // cause the final soft invalidation state to be different.
    // If soft invalidated, save the previous `transformResult` so that we can reuse and transform the
    // import timestamps only in `transformRequest`. If there's no previous `transformResult`, hard invalidate it.
    if (softInvalidate) {
      mod.invalidationState ??= mod.transformResult ?? 'HARD_INVALIDATED'
      mod.ssrInvalidationState ??= mod.ssrTransformResult ?? 'HARD_INVALIDATED'
    }
    // If hard invalidated, further soft invalidations have no effect until it's reset to `undefined`
    else {
      mod.invalidationState = 'HARD_INVALIDATED'
      mod.ssrInvalidationState = 'HARD_INVALIDATED'
    }

    // Skip updating the module if it was already invalidated before and the invalidation state has not changed
    if (
      seen.has(mod) &&
      prevInvalidationState === mod.invalidationState &&
      prevSsrInvalidationState === mod.ssrInvalidationState
    ) {
      return
    }
    seen.add(mod)

    if (isHmr) {
      mod.lastHMRTimestamp = timestamp
      mod.lastHMRInvalidationReceived = false
    } else {
      // Save the timestamp for this invalidation, so we can avoid caching the result of possible already started
      // processing being done for this module
      mod.lastInvalidationTimestamp = timestamp
    }

    // Don't invalidate mod.info and mod.meta, as they are part of the processing pipeline
    // Invalidating the transform result is enough to ensure this module is re-processed next time it is requested
    const etag = mod.transformResult?.etag
    if (etag) this.etagToModuleMap.delete(etag)

    mod.transformResult = null
    mod.ssrTransformResult = null
    mod.ssrModule = null
    mod.ssrError = null

    mod.importers.forEach((importer) => {
      if (!importer.acceptedHmrDeps.has(mod)) {
        // If the importer statically imports the current module, we can soft-invalidate the importer
        // to only update the import timestamps. If it's not statically imported, e.g. watched/glob file,
        // we can only soft invalidate if the current module was also soft-invalidated. A soft-invalidation
        // doesn't need to trigger a re-load and re-transform of the importer.
        const shouldSoftInvalidateImporter =
          importer.staticImportedUrls?.has(mod.url) || softInvalidate
        this.invalidateModule(
          importer,
          seen,
          timestamp,
          isHmr,
          shouldSoftInvalidateImporter,
        )
      }
    })

    this._hasResolveFailedErrorModules.delete(mod)
  }

  /**
   * 使所有模块失效
   */
  invalidateAll(): void {
    const timestamp = Date.now()
    const seen = new Set<ModuleNode>()
    this.idToModuleMap.forEach((mod) => {
      this.invalidateModule(mod, seen, timestamp)
    })
  }

  /**
   * Update the module graph based on a module's updated imports information
   * If there are dependencies that no longer have any importers, they are
   * returned as a Set.
   * 更新模块的导入、接受的热更新模块等信息
   *
   * @param staticImportedUrls Subset of `importedModules` where they're statically imported in code.
   *   This is only used for soft invalidations so `undefined` is fine but may cause more runtime processing.
   */
  async updateModuleInfo(
    mod: ModuleNode,
    importedModules: Set<string | ModuleNode>,
    importedBindings: Map<string, Set<string>> | null,
    acceptedModules: Set<string | ModuleNode>,
    acceptedExports: Set<string> | null,
    isSelfAccepting: boolean,
    ssr?: boolean,
    /** @internal */
    staticImportedUrls?: Set<string>,
  ): Promise<Set<ModuleNode> | undefined> {
    mod.isSelfAccepting = isSelfAccepting
    const prevImports = ssr ? mod.ssrImportedModules : mod.clientImportedModules
    let noLongerImported: Set<ModuleNode> | undefined

    let resolvePromises = []
    let resolveResults = new Array(importedModules.size)
    let index = 0
    // update import graph
    for (const imported of importedModules) {
      const nextIndex = index++
      if (typeof imported === 'string') {
        resolvePromises.push(
          this.ensureEntryFromUrl(imported, ssr).then((dep) => {
            dep.importers.add(mod)
            resolveResults[nextIndex] = dep
          }),
        )
      } else {
        imported.importers.add(mod)
        resolveResults[nextIndex] = imported
      }
    }

    if (resolvePromises.length) {
      await Promise.all(resolvePromises)
    }

    const nextImports = new Set(resolveResults)
    if (ssr) {
      mod.ssrImportedModules = nextImports
    } else {
      mod.clientImportedModules = nextImports
    }

    // remove the importer from deps that were imported but no longer are.
    prevImports.forEach((dep) => {
      if (
        !mod.clientImportedModules.has(dep) &&
        !mod.ssrImportedModules.has(dep)
      ) {
        dep.importers.delete(mod)
        if (!dep.importers.size) {
          // dependency no longer imported
          ;(noLongerImported || (noLongerImported = new Set())).add(dep)
        }
      }
    })

    // update accepted hmr deps
    resolvePromises = []
    resolveResults = new Array(acceptedModules.size)
    index = 0
    for (const accepted of acceptedModules) {
      const nextIndex = index++
      if (typeof accepted === 'string') {
        resolvePromises.push(
          this.ensureEntryFromUrl(accepted, ssr).then((dep) => {
            resolveResults[nextIndex] = dep
          }),
        )
      } else {
        resolveResults[nextIndex] = accepted
      }
    }

    if (resolvePromises.length) {
      await Promise.all(resolvePromises)
    }

    mod.acceptedHmrDeps = new Set(resolveResults)
    mod.staticImportedUrls = staticImportedUrls

    // update accepted hmr exports
    mod.acceptedHmrExports = acceptedExports
    mod.importedBindings = importedBindings
    return noLongerImported
  }

  /**
   * 确保从 URL 获取并注册一个模块
   * @param rawUrl
   * @param ssr
   * @param setIsSelfAccepting
   */
  async ensureEntryFromUrl(
    rawUrl: string,
    ssr?: boolean,
    setIsSelfAccepting = true,
  ): Promise<ModuleNode> {
    return this._ensureEntryFromUrl(rawUrl, ssr, setIsSelfAccepting)
  }

  /**
   * @internal
   */
  async _ensureEntryFromUrl(
    rawUrl: string,
    ssr?: boolean,
    setIsSelfAccepting = true,
    // Optimization, avoid resolving the same url twice if the caller already did it
    resolved?: PartialResolvedId,
  ): Promise<ModuleNode> {
    // Quick path, if we already have a module for this rawUrl (even without extension)
    rawUrl = removeImportQuery(removeTimestampQuery(rawUrl))
    let mod = this._getUnresolvedUrlToModule(rawUrl, ssr)
    if (mod) {
      return mod
    }
    const modPromise = (async () => {
      const [url, resolvedId, meta] = await this._resolveUrl(
        rawUrl,
        ssr,
        resolved,
      )
      mod = this.idToModuleMap.get(resolvedId)
      if (!mod) {
        mod = new ModuleNode(url, setIsSelfAccepting)
        if (meta) mod.meta = meta
        this.urlToModuleMap.set(url, mod)
        mod.id = resolvedId
        this.idToModuleMap.set(resolvedId, mod)
        const file = (mod.file = cleanUrl(resolvedId))
        let fileMappedModules = this.fileToModulesMap.get(file)
        if (!fileMappedModules) {
          fileMappedModules = new Set()
          this.fileToModulesMap.set(file, fileMappedModules)
        }
        fileMappedModules.add(mod)
      }
      // multiple urls can map to the same module and id, make sure we register
      // the url to the existing module in that case
      else if (!this.urlToModuleMap.has(url)) {
        this.urlToModuleMap.set(url, mod)
      }
      this._setUnresolvedUrlToModule(rawUrl, mod, ssr)
      return mod
    })()

    // Also register the clean url to the module, so that we can short-circuit
    // resolving the same url twice
    this._setUnresolvedUrlToModule(rawUrl, modPromise, ssr)
    return modPromise
  }

  // some deps, like a css file referenced via @import, don't have its own
  // url because they are inlined into the main css import. But they still
  // need to be represented in the module graph so that they can trigger
  // hmr in the importing css file.
  // 创建一个只有文件信息的模块（通常用于 CSS 文件）
  createFileOnlyEntry(file: string): ModuleNode {
    file = normalizePath(file)
    let fileMappedModules = this.fileToModulesMap.get(file)
    if (!fileMappedModules) {
      fileMappedModules = new Set()
      this.fileToModulesMap.set(file, fileMappedModules)
    }

    const url = `${FS_PREFIX}${file}`
    for (const m of fileMappedModules) {
      if (m.url === url || m.id === file) {
        return m
      }
    }

    const mod = new ModuleNode(url)
    mod.file = file
    fileMappedModules.add(mod)
    return mod
  }

  // for incoming urls, it is important to:
  // 1. remove the HMR timestamp query (?t=xxxx) and the ?import query
  // 2. resolve its extension so that urls with or without extension all map to
  // the same module
  // 解析 URL，去除无效的查询字符串（如 HMR 时间戳）
  async resolveUrl(url: string, ssr?: boolean): Promise<ResolvedUrl> {
    url = removeImportQuery(removeTimestampQuery(url))
    const mod = await this._getUnresolvedUrlToModule(url, ssr)
    if (mod?.id) {
      return [mod.url, mod.id, mod.meta]
    }
    return this._resolveUrl(url, ssr)
  }

  /**
   * 更新模块的转换结果
   * @param mod
   * @param result
   * @param ssr
   */
  updateModuleTransformResult(
    mod: ModuleNode,
    result: TransformResult | null,
    ssr: boolean,
  ): void {
    if (ssr) {
      mod.ssrTransformResult = result
    } else {
      const prevEtag = mod.transformResult?.etag
      if (prevEtag) this.etagToModuleMap.delete(prevEtag)

      mod.transformResult = result

      if (result?.etag) this.etagToModuleMap.set(result.etag, mod)
    }
  }

  /**
   * 通过 etag 获取对应的模块
   * @param etag
   */
  getModuleByEtag(etag: string): ModuleNode | undefined {
    return this.etagToModuleMap.get(etag)
  }

  /**
   * @internal 获取尚未解析的模块
   */
  _getUnresolvedUrlToModule(
    url: string,
    ssr?: boolean,
  ): Promise<ModuleNode> | ModuleNode | undefined {
    return (
      ssr ? this._ssrUnresolvedUrlToModuleMap : this._unresolvedUrlToModuleMap
    ).get(url)
  }
  /**
   * @internal 设置尚未解析的模块
   */
  _setUnresolvedUrlToModule(
    url: string,
    mod: Promise<ModuleNode> | ModuleNode,
    ssr?: boolean,
  ): void {
    ;(ssr
      ? this._ssrUnresolvedUrlToModuleMap
      : this._unresolvedUrlToModuleMap
    ).set(url, mod)
  }

  /**
   * @internal 解析 URL，返回最终的 URL、ID 和元数据
   */
  async _resolveUrl(
    url: string,
    ssr?: boolean,
    alreadyResolved?: PartialResolvedId,
  ): Promise<ResolvedUrl> {
    const resolved = alreadyResolved ?? (await this.resolveId(url, !!ssr))
    const resolvedId = resolved?.id || url
    if (
      url !== resolvedId &&
      !url.includes('\0') &&
      !url.startsWith(`virtual:`)
    ) {
      const ext = extname(cleanUrl(resolvedId))
      if (ext) {
        const pathname = cleanUrl(url)
        if (!pathname.endsWith(ext)) {
          url = pathname + ext + url.slice(pathname.length)
        }
      }
    }
    return [url, resolvedId, resolved?.meta]
  }
}
