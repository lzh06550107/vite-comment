import path from 'node:path'
import { execSync } from 'node:child_process'
import type * as net from 'node:net'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import type * as http from 'node:http'
import { performance } from 'node:perf_hooks'
import type { Http2SecureServer } from 'node:http2'
import connect from 'connect'
import corsMiddleware from 'cors'
import colors from 'picocolors'
import chokidar from 'chokidar'
import type { FSWatcher, WatchOptions } from 'dep-types/chokidar'
import type { Connect } from 'dep-types/connect'
import launchEditorMiddleware from 'launch-editor-middleware'
import type { SourceMap } from 'rollup'
import picomatch from 'picomatch'
import type { Matcher } from 'picomatch'
import type { CommonServerOptions } from '../http'
import {
  httpServerStart,
  resolveHttpServer,
  resolveHttpsConfig,
  setClientErrorHandler,
} from '../http'
import type { InlineConfig, ResolvedConfig } from '../config'
import { isDepsOptimizerEnabled, resolveConfig } from '../config'
import {
  diffDnsOrderChange,
  isInNodeModules,
  isObject,
  isParentDirectory,
  mergeConfig,
  normalizePath,
  promiseWithResolvers,
  resolveHostname,
  resolveServerUrls,
} from '../utils'
import { getFsUtils } from '../fsUtils'
import { ssrLoadModule } from '../ssr/ssrModuleLoader'
import { ssrFixStacktrace, ssrRewriteStacktrace } from '../ssr/ssrStacktrace'
import { ssrTransform } from '../ssr/ssrTransform'
import { ERR_OUTDATED_OPTIMIZED_DEP } from '../plugins/optimizedDeps'
import { getDepsOptimizer, initDepsOptimizer } from '../optimizer'
import { bindCLIShortcuts } from '../shortcuts'
import type { BindCLIShortcutsOptions } from '../shortcuts'
import { CLIENT_DIR, DEFAULT_DEV_PORT } from '../constants'
import type { Logger } from '../logger'
import { printServerUrls } from '../logger'
import {
  createNoopWatcher,
  getResolvedOutDirs,
  resolveChokidarOptions,
  resolveEmptyOutDir,
} from '../watch'
import { initPublicFiles } from '../publicDir'
import { getEnvFilesForMode } from '../env'
import type { FetchResult } from '../../runtime/types'
import { ssrFetchModule } from '../ssr/ssrFetchModule'
import type { PluginContainer } from './pluginContainer'
import { ERR_CLOSED_SERVER, createPluginContainer } from './pluginContainer'
import type { WebSocketServer } from './ws'
import { createWebSocketServer } from './ws'
import { baseMiddleware } from './middlewares/base'
import { proxyMiddleware } from './middlewares/proxy'
import { htmlFallbackMiddleware } from './middlewares/htmlFallback'
import {
  cachedTransformMiddleware,
  transformMiddleware,
} from './middlewares/transform'
import {
  createDevHtmlTransformFn,
  indexHtmlMiddleware,
} from './middlewares/indexHtml'
import {
  servePublicMiddleware,
  serveRawFsMiddleware,
  serveStaticMiddleware,
} from './middlewares/static'
import { timeMiddleware } from './middlewares/time'
import type { ModuleNode } from './moduleGraph'
import { ModuleGraph } from './moduleGraph'
import { notFoundMiddleware } from './middlewares/notFound'
import { errorMiddleware, prepareError } from './middlewares/error'
import type { HMRBroadcaster, HmrOptions } from './hmr'
import {
  createHMRBroadcaster,
  createServerHMRChannel,
  getShortName,
  handleHMRUpdate,
  updateModules,
} from './hmr'
import { openBrowser as _openBrowser } from './openBrowser'
import type { TransformOptions, TransformResult } from './transformRequest'
import { transformRequest } from './transformRequest'
import { searchForWorkspaceRoot } from './searchRoot'
import { warmupFiles } from './warmup'

export interface ServerOptions extends CommonServerOptions {
  /**
   * Configure HMR-specific options (port, host, path & protocol)
   */
  hmr?: HmrOptions | boolean
  /**
   * Warm-up files to transform and cache the results in advance. This improves the
   * initial page load during server starts and prevents transform waterfalls.
   */
  warmup?: {
    /**
     * The files to be transformed and used on the client-side. Supports glob patterns.
     */
    clientFiles?: string[]
    /**
     * The files to be transformed and used in SSR. Supports glob patterns.
     */
    ssrFiles?: string[]
  }
  /**
   * chokidar watch options or null to disable FS watching
   * https://github.com/paulmillr/chokidar#api
   */
  watch?: WatchOptions | null
  /**
   * Create Vite dev server to be used as a middleware in an existing server
   * @default false
   */
  middlewareMode?:
    | boolean
    | {
        /**
         * Parent server instance to attach to
         *
         * This is needed to proxy WebSocket connections to the parent server.
         */
        server: http.Server
      }
  /**
   * Options for files served via '/\@fs/'.
   */
  fs?: FileSystemServeOptions
  /**
   * Origin for the generated asset URLs.
   *
   * @example `http://127.0.0.1:8080`
   */
  origin?: string
  /**
   * Pre-transform known direct imports
   * @default true
   */
  preTransformRequests?: boolean
  /**
   * Whether or not to ignore-list source files in the dev server sourcemap, used to populate
   * the [`x_google_ignoreList` source map extension](https://developer.chrome.com/blog/devtools-better-angular-debugging/#the-x_google_ignorelist-source-map-extension).
   *
   * By default, it excludes all paths containing `node_modules`. You can pass `false` to
   * disable this behavior, or, for full control, a function that takes the source path and
   * sourcemap path and returns whether to ignore the source path.
   */
  sourcemapIgnoreList?:
    | false
    | ((sourcePath: string, sourcemapPath: string) => boolean)
}

export interface ResolvedServerOptions
  extends Omit<ServerOptions, 'fs' | 'middlewareMode' | 'sourcemapIgnoreList'> {
  fs: Required<FileSystemServeOptions>
  middlewareMode: NonNullable<ServerOptions['middlewareMode']>
  sourcemapIgnoreList: Exclude<
    ServerOptions['sourcemapIgnoreList'],
    false | undefined
  >
}

export interface FileSystemServeOptions {
  /**
   * Strictly restrict file accessing outside of allowing paths.
   *
   * Set to `false` to disable the warning
   *
   * @default true
   */
  strict?: boolean

  /**
   * Restrict accessing files outside the allowed directories.
   *
   * Accepts absolute path or a path relative to project root.
   * Will try to search up for workspace root by default.
   */
  allow?: string[]

  /**
   * Restrict accessing files that matches the patterns.
   *
   * This will have higher priority than `allow`.
   * picomatch patterns are supported.
   *
   * @default ['.env', '.env.*', '*.crt', '*.pem']
   */
  deny?: string[]

  /**
   * Enable caching of fs calls. It is enabled by default if no custom watch ignored patterns are provided.
   *
   * @experimental
   * @default undefined
   */
  cachedChecks?: boolean
}

export type ServerHook = (
  this: void,
  server: ViteDevServer,
) => (() => void) | void | Promise<(() => void) | void>

export type HttpServer = http.Server | Http2SecureServer

export interface ViteDevServer {
  /**
   * The resolved vite config object 包含已解析的 Vite 配置对象
   */
  config: ResolvedConfig
  /**
   * A connect app instance.
   * - Can be used to attach custom middlewares to the dev server.
   * - Can also be used as the handler function of a custom http server
   *   or as a middleware in any connect-style Node.js frameworks
   *
   * 一个 Connect 应用实例。可以用来附加自定义中间件，或者作为自定义 HTTP 服务器的处理函数
   *
   * https://github.com/senchalabs/connect#use-middleware
   */
  middlewares: Connect.Server
  /**
   * native Node http server instance
   * will be null in middleware mode
   * 原生的 Node HTTP 服务器实例。如果是中间件模式，则为 null
   */
  httpServer: HttpServer | null
  /**
   * chokidar watcher instance 文件系统监视器实例，基于 chokidar 库，用于监控文件变化
   * https://github.com/paulmillr/chokidar#api
   */
  watcher: FSWatcher
  /**
   * web socket server with `send(payload)` method
   * @deprecated use `hot` instead
   * WebSocket 服务器，用于客户端通信，尤其是热模块替换（HMR）。该属性已废弃，推荐使用 hot
   */
  ws: WebSocketServer
  /**
   * HMR broadcaster that can be used to send custom HMR messages to the client
   *
   * Always sends a message to at least a WebSocket client. Any third party can
   * add a channel to the broadcaster to process messages
   * 热模块替换广播器，用于向客户端发送自定义的 HMR 消息
   */
  hot: HMRBroadcaster
  /**
   * Rollup plugin container that can run plugin hooks on a given file
   * Rollup 插件容器，用于在特定文件上运行插件钩子
   */
  pluginContainer: PluginContainer
  /**
   * Module graph that tracks the import relationships, url to file mapping
   * and hmr state.
   * 模块图，用于追踪依赖关系、URL 到文件的映射及 HMR 状态
   */
  moduleGraph: ModuleGraph
  /**
   * The resolved urls Vite prints on the CLI. null in middleware mode or
   * before `server.listen` is called.
   * 服务器的已解析 URL，Vite 在 CLI 中会打印这些 URL。如果是中间件模式或者在 server.listen 被调用之前，则为 null
   */
  resolvedUrls: ResolvedServerUrls | null
  /**
   * Programmatically resolve, load and transform a URL and get the result
   * without going through the http request pipeline.
   * 转换指定 URL 的内容并返回转换结果，而无需经过 HTTP 请求管道
   */
  transformRequest(
    url: string,
    options?: TransformOptions,
  ): Promise<TransformResult | null>
  /**
   * Same as `transformRequest` but only warm up the URLs so the next request
   * will already be cached. The function will never throw as it handles and
   * reports errors internally.
   * 预热 URL 请求，使得下一次请求时内容已被缓存。该方法不会抛出错误，而是会内部处理并报告。
   */
  warmupRequest(url: string, options?: TransformOptions): Promise<void>
  /**
   * Apply vite built-in HTML transforms and any plugin HTML transforms.
   * 转换 HTML 内容，主要用于应用 Vite 自身和插件的 HTML 转换
   */
  transformIndexHtml(
    url: string,
    html: string,
    originalUrl?: string,
  ): Promise<string>
  /**
   * Transform module code into SSR format.
   * 将模块代码转换为 SSR 格式，适用于服务器端渲染
   */
  ssrTransform(
    code: string,
    inMap: SourceMap | { mappings: '' } | null,
    url: string,
    originalCode?: string,
  ): Promise<TransformResult | null>
  /**
   * Load a given URL as an instantiated module for SSR.
   * 加载指定 URL 的 SSR 模块，并可选择修复堆栈跟踪
   */
  ssrLoadModule(
    url: string,
    opts?: { fixStacktrace?: boolean },
  ): Promise<Record<string, any>>
  /**
   * Fetch information about the module for Vite SSR runtime.
   * @experimental
   */
  ssrFetchModule(id: string, importer?: string): Promise<FetchResult>
  /**
   * Returns a fixed version of the given stack
   */
  ssrRewriteStacktrace(stack: string): string
  /**
   * Mutates the given SSR error by rewriting the stacktrace
   */
  ssrFixStacktrace(e: Error): void
  /**
   * Triggers HMR for a module in the module graph. You can use the `server.moduleGraph`
   * API to retrieve the module to be reloaded. If `hmr` is false, this is a no-op.
   * 重新加载模块，通常用于热模块替换（HMR）
   */
  reloadModule(module: ModuleNode): Promise<void>
  /**
   * Start the server.重新加载模块，通常用于热模块替换（HMR）
   */
  listen(port?: number, isRestart?: boolean): Promise<ViteDevServer>
  /**
   * Stop the server.停止服务器
   */
  close(): Promise<void>
  /**
   * Print server urls 打印服务器的 URL 地址，例如本地地址和网络地址
   */
  printUrls(): void
  /**
   * Bind CLI shortcuts 绑定 CLI 快捷键到服务器
   */
  bindCLIShortcuts(options?: BindCLIShortcutsOptions<ViteDevServer>): void
  /**
   * Restart the server.
   * 重启服务器。如果 forceOptimize 为 true，会强制重新打包应用，类似于 CLI 中的 --force 标志
   *
   * @param forceOptimize - force the optimizer to re-bundle, same as --force cli flag
   */
  restart(forceOptimize?: boolean): Promise<void>

  /**
   * Open browser 打开浏览器，查看应用（如果支持）
   */
  openBrowser(): void
  /**
   * Calling `await server.waitForRequestsIdle(id)` will wait until all static imports
   * are processed. If called from a load or transform plugin hook, the id needs to be
   * passed as a parameter to avoid deadlocks. Calling this function after the first
   * static imports section of the module graph has been processed will resolve immediately.
   * 等待直到所有静态导入被处理完毕。适用于插件中的加载或转换，防止死锁
   * @experimental
   */
  waitForRequestsIdle: (ignoredId?: string) => Promise<void>
  /**
   * @internal
   */
  _registerRequestProcessing: (id: string, done: () => Promise<unknown>) => void
  /**
   * @internal
   */
  _onCrawlEnd(cb: () => void): void
  /**
   * @internal
   */
  _setInternalServer(server: ViteDevServer): void
  /**
   * @internal
   */
  _importGlobMap: Map<string, { affirmed: string[]; negated: string[] }[]>
  /**
   * @internal
   */
  _restartPromise: Promise<void> | null
  /**
   * @internal
   */
  _forceOptimizeOnRestart: boolean
  /**
   * @internal
   */
  _pendingRequests: Map<
    string,
    {
      request: Promise<TransformResult | null>
      timestamp: number
      abort: () => void
    }
  >
  /**
   * @internal
   */
  _fsDenyGlob: Matcher
  /**
   * @internal
   */
  _shortcutsOptions?: BindCLIShortcutsOptions<ViteDevServer>
  /**
   * @internal
   */
  _currentServerPort?: number | undefined
  /**
   * @internal
   */
  _configServerPort?: number | undefined
}

export interface ResolvedServerUrls {
  local: string[]
  network: string[]
}

export function createServer(
  inlineConfig: InlineConfig = {},
): Promise<ViteDevServer> {
  return _createServer(inlineConfig, { hotListen: true })
}

/**
 * 异步函数，主要用于创建并初始化一个 Vite 开发服务器实例。该函数接受两个参数：
 *
 * @param inlineConfig Vite 的配置项
 * @param options 包含一个布尔值 hotListen，用于指示是否启用热更新
 */
export async function _createServer(
  inlineConfig: InlineConfig = {},
  options: { hotListen: boolean },
): Promise<ViteDevServer> {
  // Vite 配置整合，解析 Vite 配置
  const config = await resolveConfig(inlineConfig, 'serve')
  // 初始化公共文件
  const initPublicFilesPromise = initPublicFiles(config)

  const { root, server: serverConfig } = config
  // 解析 HTTPS 配置
  const httpsOptions = await resolveHttpsConfig(config.server.https)
  // 是否以中间件模式创建 Vite 服务器
  const { middlewareMode } = serverConfig

  // 获取解析后的输出目录
  const resolvedOutDirs = getResolvedOutDirs(
    config.root,
    config.build.outDir,
    config.build.rollupOptions?.output,
  )
  const emptyOutDir = resolveEmptyOutDir(
    config.build.emptyOutDir,
    config.root,
    resolvedOutDirs,
  )
  // 配置文件变动监视
  const resolvedWatchOptions = resolveChokidarOptions(
    config,
    {
      disableGlobbing: true,
      ...serverConfig.watch,
    },
    resolvedOutDirs,
    emptyOutDir,
  )

  // 使用了 connect() 来创建一个 Connect.Server 实例，并根据 middlewareMode 的值来决定是否创建一个 HTTP 服务器
  const middlewares = connect() as Connect.Server
  // 创建http服务
  const httpServer = middlewareMode
    ? null
    : await resolveHttpServer(serverConfig, middlewares, httpsOptions)

  // 创建ws服务
  const ws = createWebSocketServer(httpServer, config, httpsOptions)
  const hot = createHMRBroadcaster()
    .addChannel(ws) // 处理与客户端（如浏览器）的通信，实时推送热更新
    .addChannel(createServerHMRChannel()) // 处理服务器端的模块更新，可能会触发某些特定的行为或操作
  if (typeof config.server.hmr === 'object' && config.server.hmr.channels) {
    // 这部分检查 config.server.hmr 配置对象中的 channels 属性是否存在。如果存在，意味着用户配置了额外的 HMR 通道
    // 如果配置中定义了额外的 HMR 通道，这些通道也会被添加进来，扩展了 HMR 的广播能力
    config.server.hmr.channels.forEach((channel) => hot.addChannel(channel))
  }

  const publicFiles = await initPublicFilesPromise
  const { publicDir } = config

  if (httpServer) {
    setClientErrorHandler(httpServer, config.logger)
  }

  // eslint-disable-next-line eqeqeq
  const watchEnabled = serverConfig.watch !== null
  // 创建 watcher，设置代码文件监听(chokidar 后文会解析)
  // 使用 chokidar 创建文件监听器，监听文件的添加、删除、更新等变动
  const watcher = watchEnabled
    ? (chokidar.watch(
        // config file dependencies and env file might be outside of root
        [
          root,
          ...config.configFileDependencies,
          ...getEnvFilesForMode(config.mode, config.envDir),
          // Watch the public directory explicitly because it might be outside
          // of the root directory.
          ...(publicDir && publicFiles ? [publicDir] : []),
        ],
        resolvedWatchOptions,
      ) as FSWatcher)
    : createNoopWatcher(resolvedWatchOptions)

  // 定义了一个名为 moduleGraph 的变量，它是一个 ModuleGraph 实例。ModuleGraph 用来管理模块的关系图，通常用于构建工具中，以便追踪模块的依赖关系和解决模块之间的引用
  const moduleGraph: ModuleGraph = new ModuleGraph((url, ssr) =>
    container.resolveId(url, undefined, { ssr }),
  )

  // 创建 Vite 插件容器
  const container = await createPluginContainer(config, moduleGraph, watcher)
  const closeHttpServer = createServerCloseFn(httpServer)

  let exitProcess: () => void

  const devHtmlTransformFn = createDevHtmlTransformFn(config)

  // 这是一个存储回调函数的数组。每当爬虫完成时（onCrawlEnd 被触发），这些回调函数将会依次执行
  const onCrawlEndCallbacks: (() => void)[] = []
  // crawlEndFinder 是通过调用 setupOnCrawlEnd 函数来设置的，它接受一个回调函数作为参数，目的是在爬虫结束时执行该回调
  const crawlEndFinder = setupOnCrawlEnd(() => {
    // 这个回调函数的作用是遍历 onCrawlEndCallbacks 数组并执行其中的所有回调函数
    onCrawlEndCallbacks.forEach((cb) => cb())
  })
  // 这是一个用于等待请求变为空闲状态的方法。它返回一个 Promise，在指定的请求完成并变为空闲时解决
  // ignoredId 可选参数表示某个请求 ID 需要被忽略，通常用于在某些特定情况下跳过特定请求
  function waitForRequestsIdle(ignoredId?: string): Promise<void> {
    return crawlEndFinder.waitForRequestsIdle(ignoredId)
  }

  /**
   * 这个函数用于注册请求的处理
   * @param id 请求的唯一标识符
   * @param done 一个 Promise，表示请求处理完成的操作
   */
  function _registerRequestProcessing(id: string, done: () => Promise<any>) {
    crawlEndFinder.registerRequestProcessing(id, done)
  }
  // 这个函数用于将回调函数添加到 onCrawlEndCallbacks 数组中，表示在爬虫结束时需要执行的操作
  function _onCrawlEnd(cb: () => void) {
    onCrawlEndCallbacks.push(cb)
  }

  // 创建server对象，包含了服务器生命周期管理、请求处理、模块转换、浏览器打开、重启等功能。
  // 该对象还包含了一些专用方法，如 warmupRequest 和 transformRequest，以及用于关闭服务器和清理资源的 close 方法
  let server: ViteDevServer = {
    config, // Vite 配置
    middlewares, // 中间件处理
    httpServer, // HTTP 服务器实例
    watcher, // 用于监视文件变化的工具
    pluginContainer: container, // 插件容器，处理插件的生命周期和钩子
    ws, // WebSocket 和热更新相关的对象
    hot,
    moduleGraph, // 模块依赖图，跟踪各个模块之间的关系
    resolvedUrls: null, // will be set on listen 服务器启动后解析的 URL

    /**
     * 该方法用于处理 SSR 转换，调用外部的 ssrTransform 函数进行代码转换
     * @param code
     * @param inMap
     * @param url
     * @param originalCode
     */
    ssrTransform(
      code: string,
      inMap: SourceMap | { mappings: '' } | null,
      url: string,
      originalCode = code,
    ) {
      return ssrTransform(code, inMap, url, originalCode, server.config)
    },
    /**
     * 处理传入请求的转换。调用 transformRequest 方法来处理给定 URL 的请求
     * @param url
     * @param options
     */
    transformRequest(url, options) {
      return transformRequest(url, server, options)
    },
    /**
     * 预热请求，提前加载和处理某些请求以加速后续访问
     * @param url
     * @param options
     */
    async warmupRequest(url, options) {
      try {
        await transformRequest(url, server, options)
      } catch (e) {
        if (
          e?.code === ERR_OUTDATED_OPTIMIZED_DEP ||
          e?.code === ERR_CLOSED_SERVER
        ) {
          // these are expected errors
          return
        }
        // Unexpected error, log the issue but avoid an unhandled exception
        server.config.logger.error(`Pre-transform error: ${e.message}`, {
          error: e,
          timestamp: true,
        })
      }
    },
    /**
     * 该方法用于转换 HTML 文件中的内容，调用 devHtmlTransformFn 来应用一系列 HTML 转换钩子
     * @param url
     * @param html
     * @param originalUrl
     */
    transformIndexHtml(url, html, originalUrl) {
      return devHtmlTransformFn(server, url, html, originalUrl)
    },
    /**
     * 用于加载指定的模块
     * @param url
     * @param opts
     */
    async ssrLoadModule(url, opts?: { fixStacktrace?: boolean }) {
      return ssrLoadModule(
        url,
        server,
        undefined,
        undefined,
        opts?.fixStacktrace,
      )
    },
    /**
     * 用于从 SSR 环境中获取模块
     * @param url
     * @param importer
     */
    async ssrFetchModule(url: string, importer?: string) {
      return ssrFetchModule(server, url, importer)
    },
    ssrFixStacktrace(e) {
      ssrFixStacktrace(e, moduleGraph)
    },
    ssrRewriteStacktrace(stack: string) {
      return ssrRewriteStacktrace(stack, moduleGraph)
    },
    async reloadModule(module) {
      if (serverConfig.hmr !== false && module.file) {
        updateModules(module.file, [module], Date.now(), server)
      }
    },
    /**
     * 启动服务器，监听指定端口。如果成功启动，还会解析 URL 并在浏览器中打开
     * @param port
     * @param isRestart
     */
    async listen(port?: number, isRestart?: boolean) {
      await startServer(server, port)
      if (httpServer) {
        server.resolvedUrls = await resolveServerUrls(
          httpServer,
          config.server,
          config,
        )
        if (!isRestart && config.server.open) server.openBrowser()
      }
      return server
    },
    // 根据解析的 URL 启动浏览器
    openBrowser() {
      const options = server.config.server
      const url =
        server.resolvedUrls?.local[0] ?? server.resolvedUrls?.network[0]
      if (url) {
        const path =
          typeof options.open === 'string'
            ? new URL(options.open, url).href
            : url

        // We know the url that the browser would be opened to, so we can
        // start the request while we are awaiting the browser. This will
        // start the crawling of static imports ~500ms before.
        // preTransformRequests needs to be enabled for this optimization.
        if (server.config.server.preTransformRequests) {
          setTimeout(() => {
            const getMethod = path.startsWith('https:') ? httpsGet : httpGet

            getMethod(
              path,
              {
                headers: {
                  // Allow the history middleware to redirect to /index.html
                  Accept: 'text/html',
                },
              },
              (res) => {
                res.on('end', () => {
                  // Ignore response, scripts discovered while processing the entry
                  // will be preprocessed (server.config.server.preTransformRequests)
                })
              },
            )
              .on('error', () => {
                // Ignore errors
              })
              .end()
          }, 0)
        }

        _openBrowser(path, true, server.config.logger)
      } else {
        server.config.logger.warn('No URL available to open in browser')
      }
    },
    // 关闭服务器，停止监视器、热更新、插件容器等并清理资源。同时等待所有挂起请求完成
    async close() {
      if (!middlewareMode) {
        process.off('SIGTERM', exitProcess)
        if (process.env.CI !== 'true') {
          process.stdin.off('end', exitProcess)
        }
      }
      await Promise.allSettled([
        watcher.close(),
        hot.close(),
        container.close(),
        crawlEndFinder?.cancel(),
        getDepsOptimizer(server.config)?.close(),
        getDepsOptimizer(server.config, true)?.close(),
        closeHttpServer(),
      ])
      // Await pending requests. We throw early in transformRequest
      // and in hooks if the server is closing for non-ssr requests,
      // so the import analysis plugin stops pre-transforming static
      // imports and this block is resolved sooner.
      // During SSR, we let pending requests finish to avoid exposing
      // the server closed error to the users.
      while (server._pendingRequests.size > 0) {
        await Promise.allSettled(
          [...server._pendingRequests.values()].map(
            (pending) => pending.request,
          ),
        )
      }
      server.resolvedUrls = null
    },
    // 打印服务器的 URL 地址。需要确保服务器已经启动并解析了 URL，否则会抛出错误
    printUrls() {
      if (server.resolvedUrls) {
        printServerUrls(
          server.resolvedUrls,
          serverConfig.host,
          config.logger.info,
        )
      } else if (middlewareMode) {
        throw new Error('cannot print server URLs in middleware mode.')
      } else {
        throw new Error(
          'cannot print server URLs before server.listen is called.',
        )
      }
    },
    bindCLIShortcuts(options) {
      bindCLIShortcuts(server, options)
    },
    /**
     * 重启服务器，可以选择是否强制优化。_restartPromise 保证了只有一个重启操作在同一时间内进行
     * @param forceOptimize
     */
    async restart(forceOptimize?: boolean) {
      if (!server._restartPromise) {
        server._forceOptimizeOnRestart = !!forceOptimize
        server._restartPromise = restartServer(server).finally(() => {
          server._restartPromise = null
          server._forceOptimizeOnRestart = false
        })
      }
      return server._restartPromise
    },

    // 这些方法用于处理请求的生命周期，确保在关闭服务器之前所有请求都已完成。
    //
    // waitForRequestsIdle：等待所有请求变为空闲状态。
    // _registerRequestProcessing：注册请求的处理。
    // _onCrawlEnd：在爬虫（Crawl）结束时执行回调。
    waitForRequestsIdle,
    _registerRequestProcessing,
    _onCrawlEnd,

    // 用于在重启后重新绑定内部的服务器实例
    _setInternalServer(_server: ViteDevServer) {
      // Rebind internal the server variable so functions reference the user
      // server instance after a restart
      server = _server
    },
    _restartPromise: null,
    _importGlobMap: new Map(),
    _forceOptimizeOnRestart: false,
    _pendingRequests: new Map(),
    _fsDenyGlob: picomatch(
      // matchBase: true does not work as it's documented
      // https://github.com/micromatch/picomatch/issues/89
      // convert patterns without `/` on our side for now
      config.server.fs.deny.map((pattern) =>
        pattern.includes('/') ? pattern : `**/${pattern}`,
      ),
      {
        matchBase: false,
        nocase: true,
        dot: true,
      },
    ),
    _shortcutsOptions: undefined,
  }

  // maintain consistency with the server instance after restarting.
  // 这段代码创建了一个 Proxy 对象 reflexServer，用于维护 server 实例在重启后的属性一致性。
  // 通过 Proxy 对象，可以捕捉对 server 对象的所有 get 和 set 操作，从而在 server 实例重启后确保访问属性时的一致性
  const reflexServer = new Proxy(server, {
    get: (_, property: keyof ViteDevServer) => {
      return server[property]
    },
    set: (_, property: keyof ViteDevServer, value: never) => {
      server[property] = value
      return true
    },
  })

  // 这段代码是用于处理服务器在进程终止时的清理工作，特别是在非 middlewareMode 模式下，确保服务器可以正确地关闭和退出
  // 这部分代码首先检查是否不处于 middlewareMode 模式。middlewareMode 很可能是一个标志，表示当前是否在中间件模式下运行。如果在中间件模式下，则不执行这段代码
  if (!middlewareMode) {
    // 如果不处于 middlewareMode，则定义一个 exitProcess 函数，目的是在进程终止时执行关闭操作。
    // exitProcess 是一个异步函数，它会先调用 server.close() 来关闭服务器，然后调用 process.exit() 来退出当前进程
    exitProcess = async () => {
      try {
        // 用来关闭服务器，这里假设 server 是一个可以调用 close() 方法的对象。这个方法通常会停止监听端口、关闭网络连接等
        await server.close()
      } finally {
        // 关闭当前 Node.js 进程。如果传入一个状态码（默认是 0），表示正常退出；非零状态码表示异常退出
        process.exit()
      }
    }
    // process.once('SIGTERM', exitProcess) 监听了 SIGTERM 信号。SIGTERM 是操作系统发出的终止信号，通常是请求程序优雅地关闭。
    // 如果进程收到该信号，exitProcess 函数将会被调用，执行关闭服务器和退出进程的操作。
    process.once('SIGTERM', exitProcess)
    // 如果环境变量 CI 的值不为 'true'，代码会监听 process.stdin 的 end 事件。
    // 这个事件通常在输入流（如命令行输入）结束时触发。在事件触发时，也会调用 exitProcess 来关闭服务器并退出进程。
    if (process.env.CI !== 'true') {
      process.stdin.on('end', exitProcess)
    }
  }

  // 文件监听变动，websocket向前端通信
  const onHMRUpdate = async (
    type: 'create' | 'delete' | 'update',
    file: string,
  ) => {
    if (serverConfig.hmr !== false) {
      try {
        await handleHMRUpdate(type, file, server)
      } catch (err) {
        hot.send({
          type: 'error',
          err: prepareError(err),
        })
      }
    }
  }

  /**
   * 实现了一个文件添加或删除的处理函数 onFileAddUnlink，用于在文件系统中文件被创建（add）或删除（unlink）时，更新相关的文件信息并触发 HMR（热模块替换）更新
   * @param file
   * @param isUnlink
   */
  const onFileAddUnlink = async (file: string, isUnlink: boolean) => {
    // 这行代码将文件路径规范化，可能是为了确保路径格式一致（如解决路径分隔符的问题）。normalizePath 函数通常会确保路径是统一的标准格式，适用于不同操作系统的路径
    file = normalizePath(file)
    // 触发 watchChange 事件，告诉监听器文件发生了变化。具体来说：
    // 如果 isUnlink 为 true，则表示文件被删除，事件类型是 'delete'。
    // 否则，表示文件被创建，事件类型是 'create'。
    await container.watchChange(file, { event: isUnlink ? 'delete' : 'create' })

    // publicDir 和 publicFiles 可能是用来管理静态文件和公共资源的。publicDir 代表公共目录，publicFiles 是存储公共文件路径的集合
    if (publicDir && publicFiles) {
      if (file.startsWith(publicDir)) {
        const path = file.slice(publicDir.length)
        publicFiles[isUnlink ? 'delete' : 'add'](path)
        // 如果文件被添加（isUnlink 为 false），并且它对应的模块有相同的路径，则会删除该模块的 etag，以确保公共文件在下一次请求时优先于模块加载。
        // etag 是一种用于缓存管理的标识符，可以确保客户端缓存的内容与服务器上返回的内容一致
        if (!isUnlink) {
          const moduleWithSamePath = await moduleGraph.getModuleByUrl(path)
          const etag = moduleWithSamePath?.transformResult?.etag
          if (etag) {
            // The public file should win on the next request over a module with the
            // same path. Prevent the transform etag fast path from serving the module
            moduleGraph.etagToModuleMap.delete(etag)
          }
        }
      }
    }
    // 如果 isUnlink 为 true，表示文件被删除，此时调用 moduleGraph.onFileDelete(file) 来更新模块图，移除该文件的模块信息
    if (isUnlink) moduleGraph.onFileDelete(file)
    await onHMRUpdate(isUnlink ? 'delete' : 'create', file)
  }

  // 文件监听变动，websocket向前端通信
  watcher.on('change', async (file) => {
    file = normalizePath(file)
    await container.watchChange(file, { event: 'update' })
    // invalidate module graph cache on file change
    moduleGraph.onFileChange(file)
    await onHMRUpdate('update', file)
  })

  // 设置了文件系统（FS）监听器，当文件被添加或删除时，触发相应的回调函数
  // 初始化文件系统监视器（Watcher）
  getFsUtils(config).initWatcher?.(watcher)

  // 监听文件添加（add）事件
  watcher.on('add', (file) => {
    // file 是被添加的文件路径。
    // false 表示该文件是被添加（创建），并且会在 onFileAddUnlink 函数中被处理
    onFileAddUnlink(file, false)
  })
  // 监听文件删除（unlink）事件
  watcher.on('unlink', (file) => {
    // file 是被删除的文件路径。
    // true 表示该文件是被删除，将会在 onFileAddUnlink 函数中进行处理
    onFileAddUnlink(file, true)
  })

  // 处理 热模块替换（HMR） 中的 invalidate 事件，用于在某个模块的内容被标记为无效时，触发相应的更新操作
  // 事件回调接收一个包含两个属性的对象：path 和 message：
  // * path：无效模块的路径。
  // * message（可选）：与无效模块相关的消息。
  hot.on('vite:invalidate', async ({ path, message }) => {
    // 根据传入的 path（模块路径），从 moduleGraph.urlToModuleMap 中查找对应的模块信息。moduleGraph 是 Vite 的模块图，存储了模块之间的依赖关系。
    const mod = moduleGraph.urlToModuleMap.get(path)
    if (
      mod && // 确保模块存在
      mod.isSelfAccepting && // 检查该模块是否支持自我接受（即该模块是否具有热更新能力）
      mod.lastHMRTimestamp > 0 && // 确保模块有有效的 HMR 时间戳，表示模块内容被更新过
      !mod.lastHMRInvalidationReceived // 检查该模块是否已经接收过无效化请求。如果没有接收过，则继续处理
    ) {
      mod.lastHMRInvalidationReceived = true // 标记该模块已经接收到无效化请求，防止重复处理
      // 打印一条日志，表示该模块被无效化
      config.logger.info(
        colors.yellow(`hmr invalidate `) +
          colors.dim(path) +
          (message ? ` ${message}` : ''),
        { timestamp: true },
      )
      // 获取模块的文件名
      const file = getShortName(mod.file!, config.root)
      // 调用 updateModules 函数更新模块
      updateModules(
        file, // 模块的简短文件名
        [...mod.importers], // 模块的导入者，表示依赖该模块的其他模块
        mod.lastHMRTimestamp, // 模块的最后 HMR 时间戳，用于标记模块的更新时间
        server, // 当前 Vite 开发服务器实例
        true, // 标记为热更新操作，表示这次更新是由 HMR 触发的
      )
    }
  })

  // 监听 HTTP 服务器的 listening 事件
  if (!middlewareMode && httpServer) {
    httpServer.once('listening', () => {
      // update actual port since this may be different from initial value
      serverConfig.port = (httpServer.address() as net.AddressInfo).port
    })
  }

  // apply server configuration hooks from plugins 执行插件钩子 configureServer
  const postHooks: ((() => void) | void)[] = []
  // 从插件配置中获取所有 configureServer 类型的钩子，并按照顺序排序。这些钩子函数通常用于在服务器启动后，执行一些额外的服务器配置操作。
  for (const hook of config.getSortedPluginHooks('configureServer')) {
    // 通过 for...of 循环依次执行每个钩子，钩子函数接收 reflexServer 作为参数，reflexServer 是代理的服务器实例，它确保了即使服务器在重启后，新的引用仍能继续使用
    postHooks.push(await hook(reflexServer)) // 执行每个钩子并将返回值（如果有的话）推入 postHooks 数组
  }

  // Internal middlewares ------------------------------------------------------
  // 非常多的 middleware 配置服务器使用的各种中间件，比如 CORS 中间件、代理中间件、静态文件服务等
  // request timer
  if (process.env.DEBUG) { // 如果 DEBUG 环境变量为真（一般用于调试环境），则会启用一个 timeMiddleware 中间件
    // 这个中间件用于记录请求的处理时间，通常用于调试和性能分析。root 可能是服务器的根路径，用于特定的路径配置
    middlewares.use(timeMiddleware(root))
  }

  // cors (enabled by default) 根据服务器配置是否启用 CORS
  const { cors } = serverConfig
  if (cors !== false) {
    // 如果启用了 CORS，corsMiddleware 中间件会被添加到中间件链中，负责处理跨域请求。
    // typeof cors === 'boolean' ? {} 用来判断 cors 是否为布尔值，如果是布尔值，则使用默认配置；否则使用自定义的 CORS 配置
    middlewares.use(corsMiddleware(typeof cors === 'boolean' ? {} : cors))
  }

  // 此中间件处理缓存转换相关的逻辑，可能是对编译过的文件进行缓存处理，提升请求效率
  middlewares.use(cachedTransformMiddleware(server))

  // proxy 如果 proxy 配置存在，则会使用 proxyMiddleware 将请求代理到配置的目标服务器
  const { proxy } = serverConfig
  if (proxy) {
    // middlewareServer 根据 middlewareMode 或 httpServer 来决定使用哪个服务器实例
    const middlewareServer =
      (isObject(middlewareMode) ? middlewareMode.server : null) || httpServer
    // 代理中间件可以用于将某些请求转发到其他服务，常用于开发环境中模拟 API 或接口请求
    middlewares.use(proxyMiddleware(middlewareServer, proxy, config))
  }

  // base 基路径中间件
  if (config.base !== '/') {
    // 如果 config.base 配置的值不是根路径 /，则会启用基路径中间件。baseMiddleware 处理所有与基础路径相关的操作，比如将 URL 重定向或调整请求路径。
    middlewares.use(baseMiddleware(config.rawBase, !!middlewareMode))
  }

  // open in editor support 当请求 URL 为 /__open-in-editor 时，会启用 launchEditorMiddleware 中间件
  // 这个中间件通常用来与编辑器集成，在开发过程中直接从浏览器打开代码编辑器并定位到相关文件或代码行
  // launchEditorMiddleware() 中的逻辑可能会根据请求的内容（如请求头、查询参数、路径等）决定是否启动编辑器，以及如何启动
  middlewares.use('/__open-in-editor', launchEditorMiddleware())

  // 处理 HMR 更新：
  // * 监听文件变化并通过 WebSocket 通知前端。
  // * 配置了对 HMR 更新的处理逻辑。
  // ping request handler
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  // 这种中间件通常用于支持 Vite 的 HMR（Hot Module Replacement）功能。HMR 是一种允许浏览器在不重新加载页面的情况下更新应用程序模块的技术。在 Vite 中，HMR 客户端会定期发送一个特殊的 ping 请求，服务器需要对这些请求进行响应，以确认 HMR 连接仍然有效。
  middlewares.use(function viteHMRPingMiddleware(req, res, next) {
    // 当请求头中包含 accept: text/x-vite-ping 时，服务器会响应一个 HTTP 状态码 204 No Content，表示没有返回任何内容。
    // 如果请求不包含这个特定的头部，next() 会被调用，表示请求继续传递到下一个中间件或处理器。
    if (req.headers['accept'] === 'text/x-vite-ping') {
      res.writeHead(204).end()
    } else {
      next()
    }
  })

  // serve static files under /public
  // this applies before the transform middleware so that these files are served
  // as-is without transforms.
  if (publicDir) { // 静态文件服务，如果配置了 publicDir，表示你有一个公共目录用于存放不需要经过转换的静态文件（例如图片、字体、HTML 文件等）
    // 这个中间件会为位于 publicDir 目录中的文件提供服务。publicFiles 可能是一个集合，包含了这些文件的路径列表。
    // 静态文件会直接返回，而不会经过任何转换或处理。这个中间件的作用是提前将静态文件提供给客户端，确保这些文件可以直接访问。
    middlewares.use(servePublicMiddleware(server, publicFiles))
  }

  // main transform middleware
  // 这是核心的文件转换中间件，负责处理请求的模块（如 JS、CSS、TypeScript 等），将它们转换成浏览器可执行的代码。
  // Vite 使用这个中间件来处理和转换源代码，应用插件，执行构建和转译任务
  // 这个中间件会在请求文件时对文件进行转换处理，通常用于代码打包、压缩、转译等操作。它会在静态文件服务后、最终提供服务前执行
  middlewares.use(transformMiddleware(server))

  // serve static files
  // 这个中间件用于从文件系统直接提供文件服务，可能是为了支持一些更原始的、未经处理的文件访问。它可以用来处理某些不需要经过转换的文件类型（例如某些未编译的原始文件）
  middlewares.use(serveRawFsMiddleware(server))
  // 这个中间件通常用于提供公共的、没有经过任何转换或处理的静态资源（如图片、视频等）。它会根据配置的路径直接从文件系统中查找资源并返回
  middlewares.use(serveStaticMiddleware(server))

  // 这段代码主要是在配置 Vite 开发服务器时，针对不同的应用类型（SPA 或 MPA）设置一些特定的中间件
  // html fallback
  if (config.appType === 'spa' || config.appType === 'mpa') {
    // 这个中间件处理 HTML 文件的回退逻辑，特别是针对 SPA（单页面应用）和 MPA（多页面应用）。
    // 它的主要作用是确保当请求某个路径时，如果没有找到匹配的文件，可以回退到 index.html
    middlewares.use(
      htmlFallbackMiddleware(
        root, // 项目的根目录，通常是 index.html 所在的位置
        config.appType === 'spa', // 如果是 SPA，回退的目标是 index.html，因为通常 SPA 会通过客户端路由来处理路径，而不是服务器端返回不同的 HTML 文件
        getFsUtils(config), // 获取文件系统工具，通常用于读取文件系统中的文件
      ),
    )
  }

  // run post config hooks
  // This is applied before the html middleware so that user middleware can
  // serve custom content instead of index.html.
  // postHooks：这些钩子是在服务器配置完成后执行的函数。它们通常是在插件的 configureServer 钩子中定义的
  // 作用：执行这些钩子是为了让用户在 Vite 启动后执行一些额外的配置或操作。
  // 这些钩子在 HTML 中间件之前执行，以便用户能够覆盖默认的 index.html 或提供其他自定义的内容
  postHooks.forEach((fn) => fn && fn())

  if (config.appType === 'spa' || config.appType === 'mpa') {
    // transform index.html
    // indexHtmlMiddleware(root, server)：这个中间件会处理 index.html 文件的转换。
    // 在 SPA 应用中，通常需要将 index.html 文件作为一个模板来注入 JavaScript、CSS 等资源。这可以通过该中间件来实现。
    // * root：项目根目录，包含 index.html 文件。
    // * server：Vite 服务器实例，用于执行转换。
    middlewares.use(indexHtmlMiddleware(root, server))

    // handle 404s
    // 这个中间件用于处理 404 错误。如果请求的文件或页面没有找到，会返回一个 404 错误页面。
    // 对于 SPA，通常会把所有的路径都回退到 index.html，而 MPA 则可能有多个页面，notFoundMiddleware 用于处理这些未匹配的 URL
    middlewares.use(notFoundMiddleware())
  }

  // error handler 用于处理开发过程中出现的错误。如果服务器遇到任何问题
  middlewares.use(errorMiddleware(server, !!middlewareMode))

  // httpServer.listen can be called multiple times
  // when port when using next port number
  // this code is to avoid calling buildStart multiple times
  // 初始化服务器
  let initingServer: Promise<void> | undefined
  let serverInited = false
  // 负责初始化服务器的各种功能，包括依赖优化器和文件预热
  const initServer = async () => {
    if (serverInited) return
    if (initingServer) return initingServer

    initingServer = (async function () {
      // 启动构建过程，准备好插件和构建配置
      await container.buildStart({})// TODO buildStart hook
      // start deps optimizer after all container plugins are ready
      // 检查是否启用依赖优化器（依赖项的优化和缓存），如果启用，则调用 initDepsOptimizer 初始化优化器
      if (isDepsOptimizerEnabled(config, false)) {
        await initDepsOptimizer(config, server)
      }
      // 预热文件缓存，确保文件能够在请求时快速响应
      warmupFiles(server)
      initingServer = undefined
      serverInited = true
    })()
    return initingServer
  }

  // 覆盖 httpServer.listen 方法
  if (!middlewareMode && httpServer) {
    // overwrite listen to init optimizer before server start
    const listen = httpServer.listen.bind(httpServer)
    // 覆盖 listen 方法，确保在调用 httpServer.listen 启动 HTTP 服务器之前，执行必要的初始化工作
    httpServer.listen = (async (port: number, ...args: any[]) => {
      try {
        // ensure ws server started
        hot.listen()  // 通过 hot.listen() 启动热模块替换，并在文件变动时更新前端页面
        await initServer() // 等待服务器初始化完成，确保所有依赖和文件预热操作都已完成
      } catch (e) {
        httpServer.emit('error', e)
        return
      }
      return listen(port, ...args) // 在 listen 方法中，启动 HTTP 服务器并解析服务器 URL
    }) as any
  } else {
    if (options.hotListen) {
      hot.listen() // 通过 hot.listen() 启动热模块替换，并在文件变动时更新前端页面
    }
    await initServer()
  }

  return server
}

/**
 * 用于启动 Vite 开发服务器的关键部分
 * @param server
 * @param inlinePort
 */
async function startServer(
  server: ViteDevServer,
  inlinePort?: number,
): Promise<void> {
  // 首先获取 server 实例的 httpServer 属性，确保开发服务器中已经有一个 HTTP 服务器实例。如果没有（例如在中间件模式下），就抛出错误
  const httpServer = server.httpServer
  if (!httpServer) {
    throw new Error('Cannot call server.listen in middleware mode.')
  }

  const options = server.config.server
  // 用于解析主机名。options.host 是从 Vite 配置文件中获取的服务器主机名。如果没有配置主机名，可能会使用默认值
  const hostname = await resolveHostname(options.host)
  // 配置文件中的端口号。如果传入了 inlinePort 参数，则使用 inlinePort，否则使用 options.port
  const configPort = inlinePort ?? options.port
  // When using non strict port for the dev server, the running port can be different from the config one.
  // When restarting, the original port may be available but to avoid a switch of URL for the running
  // browser tabs, we enforce the previously used port, expect if the config port changed.
  // 这段代码用于确定最终的端口号。它的逻辑是：
  // * 如果 configPort 没有设置或与之前配置的端口相同，使用上次运行时的端口（server._currentServerPort）。
  // * 如果 configPort 不同，则使用 configPort。
  // * 如果都没有指定，使用默认端口 DEFAULT_DEV_PORT。
  const port =
    (!configPort || configPort === server._configServerPort
      ? server._currentServerPort
      : configPort) ?? DEFAULT_DEV_PORT
  // 保存当前的配置端口到 server._configServerPort，以便后续比较和使用
  server._configServerPort = configPort

  // 调用 httpServerStart 启动 HTTP 服务器
  const serverPort = await httpServerStart(httpServer, {
    port, // 要监听的端口
    strictPort: options.strictPort, // 是否启用严格的端口控制（确保端口不可用时抛出错误）
    host: hostname.host, // 主机名
    logger: server.config.logger, // Vite 配置中的日志记录器，用于输出日志
  })
  // httpServerStart 会返回实际启动的端口号，存储在 server._currentServerPort 中。这确保了每次服务器启动后，能够知道当前实际使用的端口号
  server._currentServerPort = serverPort
}

/**
 * 用于创建一个能够优雅关闭 HTTP 服务器的闭包
 * @param server
 */
export function createServerCloseFn(
  server: HttpServer | null,
): () => Promise<void> {
  // 如果没有提供 server（即 server 为 null），函数会返回一个立刻解析的 Promise，不做任何操作
  if (!server) {
    return () => Promise.resolve()
  }

  // hasListened 初始为 false，表示服务器尚未开始监听连接。这个标志会在服务器开始监听后设置为 true
  let hasListened = false
  // openSockets 集合用于跟踪所有当前打开的套接字。每当建立一个新的连接时，对应的套接字会被添加到这个集合中，当套接字关闭时，它会被移除
  const openSockets = new Set<net.Socket>()

  // connection 事件：每当有新的连接建立时，connection 事件会被触发。代表该连接的套接字会被添加到 openSockets 集合中
  server.on('connection', (socket) => {
    openSockets.add(socket)
    // close 事件：每个套接字都有一个 close 事件监听器，当套接字关闭时，它会被从 openSockets 集合中移除，确保套接字集合是最新的
    socket.on('close', () => {
      openSockets.delete(socket)
    })
  })

  // close 事件：每个套接字都有一个 close 事件监听器，当套接字关闭时，它会被从 openSockets 集合中移除，确保套接字集合是最新的
  server.once('listening', () => {
    hasListened = true
  })

  // 返回的关闭函数：这是一个实际用于关闭服务器的函数。它返回一个 Promise，当服务器关闭或发生错误时，Promise 会解析或拒绝。
  return () =>
    new Promise<void>((resolve, reject) => {
      // 在关闭服务器之前，函数会遍历所有打开的套接字，并调用 s.destroy() 立即销毁这些连接，确保没有连接被挂起
      openSockets.forEach((s) => s.destroy())
      // 关闭服务器
      if (hasListened) {
        server.close((err) => {
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        })
      } else {
        resolve()
      }
    })
}

function resolvedAllowDir(root: string, dir: string): string {
  return normalizePath(path.resolve(root, dir))
}

export function resolveServerOptions(
  root: string,
  raw: ServerOptions | undefined,
  logger: Logger,
): ResolvedServerOptions {
  const server: ResolvedServerOptions = {
    preTransformRequests: true,
    ...(raw as Omit<ResolvedServerOptions, 'sourcemapIgnoreList'>),
    sourcemapIgnoreList:
      raw?.sourcemapIgnoreList === false
        ? () => false
        : raw?.sourcemapIgnoreList || isInNodeModules,
    middlewareMode: raw?.middlewareMode || false,
  }
  let allowDirs = server.fs?.allow
  const deny = server.fs?.deny || ['.env', '.env.*', '*.{crt,pem}']

  if (!allowDirs) {
    allowDirs = [searchForWorkspaceRoot(root)]
  }

  if (process.versions.pnp) {
    try {
      const enableGlobalCache =
        execSync('yarn config get enableGlobalCache', { cwd: root })
          .toString()
          .trim() === 'true'
      const yarnCacheDir = execSync(
        `yarn config get ${enableGlobalCache ? 'globalFolder' : 'cacheFolder'}`,
        { cwd: root },
      )
        .toString()
        .trim()
      allowDirs.push(yarnCacheDir)
    } catch (e) {
      logger.warn(`Get yarn cache dir error: ${e.message}`, {
        timestamp: true,
      })
    }
  }

  allowDirs = allowDirs.map((i) => resolvedAllowDir(root, i))

  // only push client dir when vite itself is outside-of-root
  const resolvedClientDir = resolvedAllowDir(root, CLIENT_DIR)
  if (!allowDirs.some((dir) => isParentDirectory(dir, resolvedClientDir))) {
    allowDirs.push(resolvedClientDir)
  }

  server.fs = {
    strict: server.fs?.strict ?? true,
    allow: allowDirs,
    deny,
    cachedChecks: server.fs?.cachedChecks,
  }

  if (server.origin?.endsWith('/')) {
    server.origin = server.origin.slice(0, -1)
    logger.warn(
      colors.yellow(
        `${colors.bold('(!)')} server.origin should not end with "/". Using "${
          server.origin
        }" instead.`,
      ),
    )
  }

  return server
}

async function restartServer(server: ViteDevServer) {
  global.__vite_start_time = performance.now()
  const shortcutsOptions = server._shortcutsOptions

  let inlineConfig = server.config.inlineConfig
  if (server._forceOptimizeOnRestart) {
    inlineConfig = mergeConfig(inlineConfig, {
      optimizeDeps: {
        force: true,
      },
    })
  }

  // Reinit the server by creating a new instance using the same inlineConfig
  // This will triger a reload of the config file and re-create the plugins and
  // middlewares. We then assign all properties of the new server to the existing
  // server instance and set the user instance to be used in the new server.
  // This allows us to keep the same server instance for the user.
  {
    let newServer = null
    try {
      // delay ws server listen
      newServer = await _createServer(inlineConfig, { hotListen: false })
    } catch (err: any) {
      server.config.logger.error(err.message, {
        timestamp: true,
      })
      server.config.logger.error('server restart failed', { timestamp: true })
      return
    }

    await server.close()

    // Assign new server props to existing server instance
    const middlewares = server.middlewares
    newServer._configServerPort = server._configServerPort
    newServer._currentServerPort = server._currentServerPort
    Object.assign(server, newServer)

    // Keep the same connect instance so app.use(vite.middlewares) works
    // after a restart in middlewareMode (.route is always '/')
    middlewares.stack = newServer.middlewares.stack
    server.middlewares = middlewares

    // Rebind internal server variable so functions reference the user server
    newServer._setInternalServer(server)
  }

  const {
    logger,
    server: { port, middlewareMode },
  } = server.config
  if (!middlewareMode) {
    await server.listen(port, true)
  } else {
    server.hot.listen()
  }
  logger.info('server restarted.', { timestamp: true })

  if (shortcutsOptions) {
    shortcutsOptions.print = false
    bindCLIShortcuts(server, shortcutsOptions)
  }
}

/**
 * Internal function to restart the Vite server and print URLs if changed
 */
export async function restartServerWithUrls(
  server: ViteDevServer,
): Promise<void> {
  if (server.config.server.middlewareMode) {
    await server.restart()
    return
  }

  const { port: prevPort, host: prevHost } = server.config.server
  const prevUrls = server.resolvedUrls

  await server.restart()

  const {
    logger,
    server: { port, host },
  } = server.config
  if (
    (port ?? DEFAULT_DEV_PORT) !== (prevPort ?? DEFAULT_DEV_PORT) ||
    host !== prevHost ||
    diffDnsOrderChange(prevUrls, server.resolvedUrls)
  ) {
    logger.info('')
    server.printUrls()
  }
}

const callCrawlEndIfIdleAfterMs = 50

interface CrawlEndFinder {
  registerRequestProcessing: (id: string, done: () => Promise<any>) => void
  waitForRequestsIdle: (ignoredId?: string) => Promise<void>
  cancel: () => void
}

function setupOnCrawlEnd(onCrawlEnd: () => void): CrawlEndFinder {
  const registeredIds = new Set<string>()
  const seenIds = new Set<string>()
  const onCrawlEndPromiseWithResolvers = promiseWithResolvers<void>()

  let timeoutHandle: NodeJS.Timeout | undefined

  let cancelled = false
  function cancel() {
    cancelled = true
  }

  let crawlEndCalled = false
  function callOnCrawlEnd() {
    if (!cancelled && !crawlEndCalled) {
      crawlEndCalled = true
      onCrawlEnd()
    }
    onCrawlEndPromiseWithResolvers.resolve()
  }

  function registerRequestProcessing(
    id: string,
    done: () => Promise<any>,
  ): void {
    if (!seenIds.has(id)) {
      seenIds.add(id)
      registeredIds.add(id)
      done()
        .catch(() => {})
        .finally(() => markIdAsDone(id))
    }
  }

  function waitForRequestsIdle(ignoredId?: string): Promise<void> {
    if (ignoredId) {
      seenIds.add(ignoredId)
      markIdAsDone(ignoredId)
    }
    return onCrawlEndPromiseWithResolvers.promise
  }

  function markIdAsDone(id: string): void {
    if (registeredIds.has(id)) {
      registeredIds.delete(id)
      checkIfCrawlEndAfterTimeout()
    }
  }

  function checkIfCrawlEndAfterTimeout() {
    if (cancelled || registeredIds.size > 0) return

    if (timeoutHandle) clearTimeout(timeoutHandle)
    timeoutHandle = setTimeout(
      callOnCrawlEndWhenIdle,
      callCrawlEndIfIdleAfterMs,
    )
  }
  async function callOnCrawlEndWhenIdle() {
    if (cancelled || registeredIds.size > 0) return
    callOnCrawlEnd()
  }

  return {
    registerRequestProcessing,
    waitForRequestsIdle,
    cancel,
  }
}
