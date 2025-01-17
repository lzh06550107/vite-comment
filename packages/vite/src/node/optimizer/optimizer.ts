import colors from 'picocolors'
import { createDebugger, getHash, promiseWithResolvers } from '../utils'
import type { PromiseWithResolvers } from '../utils'
import { getDepOptimizationConfig } from '../config'
import type { ResolvedConfig, ViteDevServer } from '..'
import {
  addManuallyIncludedOptimizeDeps,
  addOptimizedDepInfo,
  createIsOptimizedDepFile,
  createIsOptimizedDepUrl,
  depsFromOptimizedDepInfo,
  depsLogString,
  discoverProjectDependencies,
  extractExportsData,
  getOptimizedDepPath,
  initDepsOptimizerMetadata,
  loadCachedDepOptimizationMetadata,
  optimizeServerSsrDeps,
  runOptimizeDeps,
  toDiscoveredDependencies,
} from '.'
import type { DepOptimizationResult, DepsOptimizer, OptimizedDepInfo } from '.'

const debug = createDebugger('vite:deps')

/**
 * The amount to wait for requests to register newly found dependencies before triggering
 * a re-bundle + page reload
 */
const debounceMs = 100

const depsOptimizerMap = new WeakMap<ResolvedConfig, DepsOptimizer>()
const devSsrDepsOptimizerMap = new WeakMap<ResolvedConfig, DepsOptimizer>()

/**
 * 用于根据传入的配置和可选的 ssr 参数获取对应的依赖优化器（DepsOptimizer）
 * @param config Vite 配置对象，包含了与项目相关的所有配置信息
 * @param ssr 可选参数，表示是否为 SSR（服务器端渲染）模式。默认值为 false，如果传入 true，则会获取 SSR 模式下的依赖优化器
 */
export function getDepsOptimizer(
  config: ResolvedConfig,
  ssr?: boolean,
): DepsOptimizer | undefined {
  // 如果 ssr 参数为 true，则从 devSsrDepsOptimizerMap 中获取优化器。
  // 如果 ssr 参数为 false 或者未传入 ssr 参数，则从 depsOptimizerMap 中获取优化器。
  return (ssr ? devSsrDepsOptimizerMap : depsOptimizerMap).get(config)
}

/**
 * 主要用于初始化依赖优化器（Deps Optimizer）。它会根据传入的 config 和 server 参数来检查是否启用依赖优化功能，并在必要时创建并初始化依赖优化器
 * @param config Vite 的配置对象，包含了与项目相关的所有配置信息
 * @param server Vite 开发服务器实例，包含与服务器相关的功能
 */
export async function initDepsOptimizer(
  config: ResolvedConfig,
  server: ViteDevServer,
): Promise<void> {
  // 检查是否启用了依赖优化。如果未启用，则会调用 createDepsOptimizer 来创建并初始化依赖优化器
  if (!getDepsOptimizer(config, false)) {
    // 调用 createDepsOptimizer(config, server) 来创建并初始化优化器
    await createDepsOptimizer(config, server)
  }
}

let creatingDevSsrOptimizer: Promise<void> | undefined
export async function initDevSsrDepsOptimizer(
  config: ResolvedConfig,
  server: ViteDevServer,
): Promise<void> {
  if (getDepsOptimizer(config, true)) {
    // ssr
    return
  }
  if (creatingDevSsrOptimizer) {
    return creatingDevSsrOptimizer
  }
  creatingDevSsrOptimizer = (async function () {
    // Important: scanning needs to be done before starting the SSR dev optimizer
    // If ssrLoadModule is called before server.listen(), the main deps optimizer
    // will not be yet created
    const ssr = false
    if (!getDepsOptimizer(config, ssr)) {
      await initDepsOptimizer(config, server)
    }
    await getDepsOptimizer(config, ssr)!.scanProcessing

    await createDevSsrDepsOptimizer(config)
    creatingDevSsrOptimizer = undefined
  })()
  return await creatingDevSsrOptimizer
}

/**
 * 创建依赖优化器
 * @param config
 * @param server
 */
async function createDepsOptimizer(
  config: ResolvedConfig,
  server: ViteDevServer,
): Promise<void> {
  const { logger } = config // 从 config 中提取日志记录器
  const ssr = false // 设为 false，表示这不是一个 SSR（服务器端渲染）环境
  const sessionTimestamp = Date.now().toString() // 获取当前的时间戳作为会话标识

  // 加载缓存的依赖优化元数据
  const cachedMetadata = await loadCachedDepOptimizationMetadata(config, ssr)

  // 定义 debounceProcessingHandle 来处理防抖操作
  let debounceProcessingHandle: NodeJS.Timeout | undefined

  // 关闭标志，用于标识优化处理是否已结束
  let closed = false

  // 如果缓存的元数据存在，就使用缓存的数据，否则调用 initDepsOptimizerMetadata 来初始化优化元数据
  let metadata =
    cachedMetadata || initDepsOptimizerMetadata(config, ssr, sessionTimestamp)

  // 获取依赖优化配置
  const options = getDepOptimizationConfig(config, ssr)

  const { noDiscovery, holdUntilCrawlEnd } = options

  // depsOptimizer 包含了多个方法，用于执行依赖优化操作（如注册缺失的导入、运行优化、判断是否是优化过的依赖文件等）
  const depsOptimizer: DepsOptimizer = {
    metadata,
    registerMissingImport,
    run: () => debouncedProcessing(0),
    isOptimizedDepFile: createIsOptimizedDepFile(config),
    isOptimizedDepUrl: createIsOptimizedDepUrl(config),
    getOptimizedDepId: (depInfo: OptimizedDepInfo) =>
      `${depInfo.file}?v=${depInfo.browserHash}`,
    close,
    options,
  }

  depsOptimizerMap.set(config, depsOptimizer)

  // 用于跟踪新发现的依赖
  let newDepsDiscovered = false

  // 用于延迟记录新发现的依赖
  let newDepsToLog: string[] = []
  let newDepsToLogHandle: NodeJS.Timeout | undefined
  // 在日志中输出新优化的依赖
  const logNewlyDiscoveredDeps = () => {
    if (newDepsToLog.length) {
      config.logger.info(
        colors.green(
          `✨ new dependencies optimized: ${depsLogString(newDepsToLog)}`,
        ),
        {
          timestamp: true,
        },
      )
      newDepsToLog = []
    }
  }

  // 用于存储扫描过程中发现的依赖
  let discoveredDepsWhileScanning: string[] = []
  // 记录扫描过程中发现的依赖
  const logDiscoveredDepsWhileScanning = () => {
    if (discoveredDepsWhileScanning.length) {
      config.logger.info(
        colors.green(
          `✨ discovered while scanning: ${depsLogString(
            discoveredDepsWhileScanning,
          )}`,
        ),
        {
          timestamp: true,
        },
      )
      discoveredDepsWhileScanning = []
    }
  }

  // 用于管理优化处理的 promise
  let depOptimizationProcessing = promiseWithResolvers<void>()
  // 存储待处理的优化任务
  let depOptimizationProcessingQueue: PromiseWithResolvers<void>[] = []
  const resolveEnqueuedProcessingPromises = () => {
    // Resolve all the processings (including the ones which were delayed)
    for (const processing of depOptimizationProcessingQueue) {
      processing.resolve()
    }
    depOptimizationProcessingQueue = []
  }

  let enqueuedRerun: (() => void) | undefined
  let currentlyProcessing = false

  let firstRunCalled = !!cachedMetadata
  let warnAboutMissedDependencies = false

  // If this is a cold run, we wait for static imports discovered
  // from the first request before resolving to minimize full page reloads.
  // On warm start or after the first optimization is run, we use a simpler
  // debounce strategy each time a new dep is discovered.
  let waitingForCrawlEnd = false
  // 如果是冷启动（即第一次运行），waitingForCrawlEnd 标志会被设置为 true，表示需要等待爬虫扫描完成后再执行依赖优化
  if (!cachedMetadata) {
    // 当 cachedMetadata 不存在时，注册 onCrawlEnd 函数来处理爬取结束的事件，
    // 并将 waitingForCrawlEnd 设置为 true，表示系统在等待静态导入的爬取结束后再进行后续操作。
    server._onCrawlEnd(onCrawlEnd)
    waitingForCrawlEnd = true
  }

  let optimizationResult:
    | {
        cancel: () => Promise<void>
        result: Promise<DepOptimizationResult>
      }
    | undefined

  let discover:
    | {
        cancel: () => Promise<void>
        result: Promise<Record<string, string>>
      }
    | undefined

  // 关闭当前处理并等待所有异步任务完成
  async function close() {
    closed = true
    await Promise.allSettled([
      discover?.cancel(),
      depsOptimizer.scanProcessing,
      optimizationResult?.cancel(),
    ])
  }

  // 如果没有缓存的元数据，则进入依赖优化的流程
  if (!cachedMetadata) {
    // Enter processing state until crawl of static imports ends
    currentlyProcessing = true

    // Initialize discovered deps with manually added optimizeDeps.include info

    // 初始化手动添加的依赖（manuallyIncludedDeps），并添加到 discovered 列表中，准备进行依赖优化
    const manuallyIncludedDeps: Record<string, string> = {}
    await addManuallyIncludedOptimizeDeps(manuallyIncludedDeps, config, ssr)

    const manuallyIncludedDepsInfo = toDiscoveredDependencies(
      config,
      manuallyIncludedDeps,
      ssr,
      sessionTimestamp,
    )

    for (const depInfo of Object.values(manuallyIncludedDepsInfo)) {
      addOptimizedDepInfo(metadata, 'discovered', {
        ...depInfo,
        processing: depOptimizationProcessing.promise,
      })
      newDepsDiscovered = true
    }

    // 如果没有依赖发现 (noDiscovery)，则直接运行优化器 runOptimizer()，否则会进行依赖扫描
    if (noDiscovery) {
      // We don't need to scan for dependencies or wait for the static crawl to end
      // Run the first optimization run immediately
      runOptimizer()
    } else { // 依赖扫描和优化
      // Important, the scanner is dev only 通过 depsOptimizer.scanProcessing 启动一个后台扫描，扫描项目中的依赖项
      depsOptimizer.scanProcessing = new Promise((resolve) => {
        // Runs in the background in case blocking high priority tasks
        ;(async () => {
          try {
            debug?.(colors.green(`scanning for dependencies...`))

            discover = discoverProjectDependencies(config) // 执行依赖发现
            const deps = await discover.result
            discover = undefined

            const manuallyIncluded = Object.keys(manuallyIncludedDepsInfo)
            discoveredDepsWhileScanning.push(
              ...Object.keys(metadata.discovered).filter(
                (dep) => !deps[dep] && !manuallyIncluded.includes(dep),
              ),
            )

            // Add these dependencies to the discovered list, as these are currently
            // used by the preAliasPlugin to support aliased and optimized deps.
            // This is also used by the CJS externalization heuristics in legacy mode
            for (const id of Object.keys(deps)) {
              if (!metadata.discovered[id]) {
                addMissingDep(id, deps[id])
              }
            }

            const knownDeps = prepareKnownDeps()
            startNextDiscoveredBatch()

            // For dev, we run the scanner and the first optimization
            // run on the background
            optimizationResult = runOptimizeDeps(config, knownDeps, ssr) // 对已知依赖进行优化

            // If the holdUntilCrawlEnd stratey is used, we wait until crawling has
            // ended to decide if we send this result to the browser or we need to
            // do another optimize step
            if (!holdUntilCrawlEnd) {
              // If not, we release the result to the browser as soon as the scanner
              // is done. If the scanner missed any dependency, and a new dependency
              // is discovered while crawling static imports, then there will be a
              // full-page reload if new common chunks are generated between the old
              // and new optimized deps.
              optimizationResult.result.then((result) => {
                // Check if the crawling of static imports has already finished. In that
                // case, the result is handled by the onCrawlEnd callback
                if (!waitingForCrawlEnd) return

                optimizationResult = undefined // signal that we'll be using the result

                runOptimizer(result) // 运行优化器，处理依赖的优化步骤
              })
            }
          } catch (e) {
            logger.error(e.stack || e.message)
          } finally {
            resolve()
            depsOptimizer.scanProcessing = undefined
          }
        })()
      })
    }
  }

  function startNextDiscoveredBatch() {
    newDepsDiscovered = false

    // Add the current depOptimizationProcessing to the queue, these
    // promises are going to be resolved once a rerun is committed
    depOptimizationProcessingQueue.push(depOptimizationProcessing)

    // Create a new promise for the next rerun, discovered missing
    // dependencies will be assigned this promise from this point
    depOptimizationProcessing = promiseWithResolvers()
  }

  function prepareKnownDeps() {
    const knownDeps: Record<string, OptimizedDepInfo> = {}
    // Clone optimized info objects, fileHash, browserHash may be changed for them
    for (const dep of Object.keys(metadata.optimized)) {
      knownDeps[dep] = { ...metadata.optimized[dep] }
    }
    for (const dep of Object.keys(metadata.discovered)) {
      // Clone the discovered info discarding its processing promise
      const { processing, ...info } = metadata.discovered[dep]
      knownDeps[dep] = info
    }
    return knownDeps
  }

  async function runOptimizer(preRunResult?: DepOptimizationResult) {
    // a successful completion of the optimizeDeps rerun will end up
    // creating new bundled version of all current and discovered deps
    // in the cache dir and a new metadata info object assigned
    // to _metadata. A fullReload is only issued if the previous bundled
    // dependencies have changed.

    // if the rerun fails, _metadata remains untouched, current discovered
    // deps are cleaned, and a fullReload is issued

    // All deps, previous known and newly discovered are rebundled,
    // respect insertion order to keep the metadata file stable

    const isRerun = firstRunCalled
    firstRunCalled = true

    // Ensure that rerun is called sequentially
    enqueuedRerun = undefined

    // Ensure that a rerun will not be issued for current discovered deps
    if (debounceProcessingHandle) clearTimeout(debounceProcessingHandle)

    if (closed) {
      currentlyProcessing = false
      return
    }

    currentlyProcessing = true

    try {
      let processingResult: DepOptimizationResult
      if (preRunResult) {
        processingResult = preRunResult
      } else {
        const knownDeps = prepareKnownDeps()
        startNextDiscoveredBatch()

        optimizationResult = runOptimizeDeps(config, knownDeps, ssr)
        processingResult = await optimizationResult.result
        optimizationResult = undefined
      }

      if (closed) {
        currentlyProcessing = false
        processingResult.cancel()
        resolveEnqueuedProcessingPromises()
        return
      }

      const newData = processingResult.metadata

      const needsInteropMismatch = findInteropMismatches(
        metadata.discovered,
        newData.optimized,
      )

      // After a re-optimization, if the internal bundled chunks change a full page reload
      // is required. If the files are stable, we can avoid the reload that is expensive
      // for large applications. Comparing their fileHash we can find out if it is safe to
      // keep the current browser state.
      const needsReload =
        needsInteropMismatch.length > 0 ||
        metadata.hash !== newData.hash ||
        Object.keys(metadata.optimized).some((dep) => {
          return (
            metadata.optimized[dep].fileHash !== newData.optimized[dep].fileHash
          )
        })

      const commitProcessing = async () => {
        await processingResult.commit()

        // While optimizeDeps is running, new missing deps may be discovered,
        // in which case they will keep being added to metadata.discovered
        for (const id in metadata.discovered) {
          if (!newData.optimized[id]) {
            addOptimizedDepInfo(newData, 'discovered', metadata.discovered[id])
          }
        }

        // If we don't reload the page, we need to keep browserHash stable
        if (!needsReload) {
          newData.browserHash = metadata.browserHash
          for (const dep in newData.chunks) {
            newData.chunks[dep].browserHash = metadata.browserHash
          }
          for (const dep in newData.optimized) {
            newData.optimized[dep].browserHash = (
              metadata.optimized[dep] || metadata.discovered[dep]
            ).browserHash
          }
        }

        // Commit hash and needsInterop changes to the discovered deps info
        // object. Allow for code to await for the discovered processing promise
        // and use the information in the same object
        for (const o in newData.optimized) {
          const discovered = metadata.discovered[o]
          if (discovered) {
            const optimized = newData.optimized[o]
            discovered.browserHash = optimized.browserHash
            discovered.fileHash = optimized.fileHash
            discovered.needsInterop = optimized.needsInterop
            discovered.processing = undefined
          }
        }

        if (isRerun) {
          newDepsToLog.push(
            ...Object.keys(newData.optimized).filter(
              (dep) => !metadata.optimized[dep],
            ),
          )
        }

        metadata = depsOptimizer.metadata = newData
        resolveEnqueuedProcessingPromises()
      }

      if (!needsReload) {
        await commitProcessing()

        if (!debug) {
          if (newDepsToLogHandle) clearTimeout(newDepsToLogHandle)
          newDepsToLogHandle = setTimeout(() => {
            newDepsToLogHandle = undefined
            logNewlyDiscoveredDeps()
            if (warnAboutMissedDependencies) {
              logDiscoveredDepsWhileScanning()
              config.logger.info(
                colors.magenta(
                  `❗ add these dependencies to optimizeDeps.include to speed up cold start`,
                ),
                { timestamp: true },
              )
              warnAboutMissedDependencies = false
            }
          }, 2 * debounceMs)
        } else {
          debug(
            colors.green(
              `✨ ${
                !isRerun
                  ? `dependencies optimized`
                  : `optimized dependencies unchanged`
              }`,
            ),
          )
        }
      } else {
        if (newDepsDiscovered) {
          // There are newly discovered deps, and another rerun is about to be
          // executed. Avoid the current full reload discarding this rerun result
          // We don't resolve the processing promise, as they will be resolved
          // once a rerun is committed
          processingResult.cancel()

          debug?.(
            colors.green(
              `✨ delaying reload as new dependencies have been found...`,
            ),
          )
        } else {
          await commitProcessing()

          if (!debug) {
            if (newDepsToLogHandle) clearTimeout(newDepsToLogHandle)
            newDepsToLogHandle = undefined
            logNewlyDiscoveredDeps()
            if (warnAboutMissedDependencies) {
              logDiscoveredDepsWhileScanning()
              config.logger.info(
                colors.magenta(
                  `❗ add these dependencies to optimizeDeps.include to avoid a full page reload during cold start`,
                ),
                { timestamp: true },
              )
              warnAboutMissedDependencies = false
            }
          }

          logger.info(
            colors.green(`✨ optimized dependencies changed. reloading`),
            {
              timestamp: true,
            },
          )
          if (needsInteropMismatch.length > 0) {
            config.logger.warn(
              `Mixed ESM and CJS detected in ${colors.yellow(
                needsInteropMismatch.join(', '),
              )}, add ${
                needsInteropMismatch.length === 1 ? 'it' : 'them'
              } to optimizeDeps.needsInterop to speed up cold start`,
              {
                timestamp: true,
              },
            )
          }

          fullReload()
        }
      }
    } catch (e) {
      logger.error(
        colors.red(`error while updating dependencies:\n${e.stack}`),
        { timestamp: true, error: e },
      )
      resolveEnqueuedProcessingPromises()

      // Reset missing deps, let the server rediscover the dependencies
      metadata.discovered = {}
    }

    currentlyProcessing = false
    // @ts-expect-error `enqueuedRerun` could exist because `debouncedProcessing` may run while awaited
    enqueuedRerun?.()
  }

  function fullReload() {
    // Cached transform results have stale imports (resolved to
    // old locations) so they need to be invalidated before the page is
    // reloaded.
    server.moduleGraph.invalidateAll()

    server.hot.send({
      type: 'full-reload',
      path: '*',
    })
  }

  async function rerun() {
    // debounce time to wait for new missing deps finished, issue a new
    // optimization of deps (both old and newly found) once the previous
    // optimizeDeps processing is finished
    const deps = Object.keys(metadata.discovered)
    const depsString = depsLogString(deps)
    debug?.(colors.green(`new dependencies found: ${depsString}`))
    runOptimizer()
  }

  function getDiscoveredBrowserHash(
    hash: string,
    deps: Record<string, string>,
    missing: Record<string, string>,
  ) {
    return getHash(
      hash + JSON.stringify(deps) + JSON.stringify(missing) + sessionTimestamp,
    )
  }

  function registerMissingImport(
    id: string,
    resolved: string,
  ): OptimizedDepInfo {
    const optimized = metadata.optimized[id]
    if (optimized) {
      return optimized
    }
    const chunk = metadata.chunks[id]
    if (chunk) {
      return chunk
    }
    let missing = metadata.discovered[id]
    if (missing) {
      // We are already discover this dependency
      // It will be processed in the next rerun call
      return missing
    }

    missing = addMissingDep(id, resolved)

    // Until the first optimize run is called, avoid triggering processing
    // We'll wait until the user codebase is eagerly processed by Vite so
    // we can get a list of every missing dependency before giving to the
    // browser a dependency that may be outdated, thus avoiding full page reloads

    if (!waitingForCrawlEnd) {
      // Debounced rerun, let other missing dependencies be discovered before
      // the running next optimizeDeps
      debouncedProcessing()
    }

    // Return the path for the optimized bundle, this path is known before
    // esbuild is run to generate the pre-bundle
    return missing
  }

  function addMissingDep(id: string, resolved: string) {
    newDepsDiscovered = true

    return addOptimizedDepInfo(metadata, 'discovered', {
      id,
      file: getOptimizedDepPath(id, config, ssr),
      src: resolved,
      // Adding a browserHash to this missing dependency that is unique to
      // the current state of known + missing deps. If its optimizeDeps run
      // doesn't alter the bundled files of previous known dependencies,
      // we don't need a full reload and this browserHash will be kept
      browserHash: getDiscoveredBrowserHash(
        metadata.hash,
        depsFromOptimizedDepInfo(metadata.optimized),
        depsFromOptimizedDepInfo(metadata.discovered),
      ),
      // loading of this pre-bundled dep needs to await for its processing
      // promise to be resolved
      processing: depOptimizationProcessing.promise,
      exportsData: extractExportsData(resolved, config, ssr),
    })
  }

  function debouncedProcessing(timeout = debounceMs) {
    // Debounced rerun, let other missing dependencies be discovered before
    // the next optimizeDeps run
    enqueuedRerun = undefined
    if (debounceProcessingHandle) clearTimeout(debounceProcessingHandle)
    if (newDepsToLogHandle) clearTimeout(newDepsToLogHandle)
    newDepsToLogHandle = undefined
    debounceProcessingHandle = setTimeout(() => {
      debounceProcessingHandle = undefined
      enqueuedRerun = rerun
      if (!currentlyProcessing) {
        enqueuedRerun()
      }
    }, timeout)
  }

  // onCrawlEnd is called once when the server starts and all static
  // imports after the first request have been crawled (dynamic imports may also
  // be crawled if the browser requests them right away).
  async function onCrawlEnd() { // 当静态导入爬取结束后，会调用 onCrawlEnd 函数来处理依赖优化的最终步骤
    // switch after this point to a simple debounce strategy
    waitingForCrawlEnd = false

    debug?.(colors.green(`✨ static imports crawl ended`))
    if (closed) {
      return
    }

    // Await for the scan+optimize step running in the background
    // It normally should be over by the time crawling of user code ended
    await depsOptimizer.scanProcessing

    if (optimizationResult && !config.optimizeDeps.noDiscovery) {
      // In the holdUntilCrawlEnd strategy, we don't release the result of the
      // post-scanner optimize step to the browser until we reach this point
      // If there are new dependencies, we do another optimize run, if not, we
      // use the post-scanner optimize result
      // If holdUntilCrawlEnd is false and we reach here, it means that the
      // scan+optimize step finished after crawl end. We follow the same
      // process as in the holdUntilCrawlEnd in this case.
      const afterScanResult = optimizationResult.result
      optimizationResult = undefined // signal that we'll be using the result

      const result = await afterScanResult
      currentlyProcessing = false

      const crawlDeps = Object.keys(metadata.discovered)
      const scanDeps = Object.keys(result.metadata.optimized)

      if (scanDeps.length === 0 && crawlDeps.length === 0) {
        debug?.(
          colors.green(
            `✨ no dependencies found by the scanner or crawling static imports`,
          ),
        )
        // We still commit the result so the scanner isn't run on the next cold start
        // for projects without dependencies
        startNextDiscoveredBatch()
        runOptimizer(result)
        return
      }

      const needsInteropMismatch = findInteropMismatches(
        metadata.discovered,
        result.metadata.optimized,
      )
      const scannerMissedDeps = crawlDeps.some((dep) => !scanDeps.includes(dep))
      const outdatedResult =
        needsInteropMismatch.length > 0 || scannerMissedDeps

      if (outdatedResult) {
        // Drop this scan result, and perform a new optimization to avoid a full reload
        result.cancel()

        // Add deps found by the scanner to the discovered deps while crawling
        for (const dep of scanDeps) {
          if (!crawlDeps.includes(dep)) {
            addMissingDep(dep, result.metadata.optimized[dep].src!)
          }
        }
        if (scannerMissedDeps) {
          debug?.(
            colors.yellow(
              `✨ new dependencies were found while crawling that weren't detected by the scanner`,
            ),
          )
        }
        debug?.(colors.green(`✨ re-running optimizer`))
        debouncedProcessing(0)
      } else {
        debug?.(
          colors.green(
            `✨ using post-scan optimizer result, the scanner found every used dependency`,
          ),
        )
        startNextDiscoveredBatch()
        runOptimizer(result)
      }
    } else if (!holdUntilCrawlEnd) {
      // The post-scanner optimize result has been released to the browser
      // If new deps have been discovered, issue a regular rerun of the
      // optimizer. A full page reload may still be avoided if the new
      // optimize result is compatible in this case
      if (newDepsDiscovered) {
        debug?.(
          colors.green(
            `✨ new dependencies were found while crawling static imports, re-running optimizer`,
          ),
        )
        warnAboutMissedDependencies = true
        debouncedProcessing(0)
      }
    } else {
      const crawlDeps = Object.keys(metadata.discovered)
      currentlyProcessing = false

      if (crawlDeps.length === 0) {
        debug?.(
          colors.green(
            `✨ no dependencies found while crawling the static imports`,
          ),
        )
        firstRunCalled = true
      }

      // queue the first optimizer run, even without deps so the result is cached
      // 这个函数用于防止多次触发优化过程。它会延迟执行，等待新的缺失依赖被发现后再进行优化
      debouncedProcessing(0)
    }
  }
}

async function createDevSsrDepsOptimizer(
  config: ResolvedConfig,
): Promise<void> {
  const metadata = await optimizeServerSsrDeps(config)

  const depsOptimizer = {
    metadata,
    isOptimizedDepFile: createIsOptimizedDepFile(config),
    isOptimizedDepUrl: createIsOptimizedDepUrl(config),
    getOptimizedDepId: (depInfo: OptimizedDepInfo) =>
      `${depInfo.file}?v=${depInfo.browserHash}`,

    registerMissingImport: () => {
      throw new Error(
        'Vite Internal Error: registerMissingImport is not supported in dev SSR',
      )
    },
    // noop, there is no scanning during dev SSR
    // the optimizer blocks the server start
    run: () => {},

    close: async () => {},
    options: config.ssr.optimizeDeps,
  }
  devSsrDepsOptimizerMap.set(config, depsOptimizer)
}

function findInteropMismatches(
  discovered: Record<string, OptimizedDepInfo>,
  optimized: Record<string, OptimizedDepInfo>,
) {
  const needsInteropMismatch = []
  for (const dep in discovered) {
    const discoveredDepInfo = discovered[dep]
    const depInfo = optimized[dep]
    if (depInfo) {
      if (
        discoveredDepInfo.needsInterop !== undefined &&
        depInfo.needsInterop !== discoveredDepInfo.needsInterop
      ) {
        // This only happens when a discovered dependency has mixed ESM and CJS syntax
        // and it hasn't been manually added to optimizeDeps.needsInterop
        needsInteropMismatch.push(dep)
        debug?.(colors.cyan(`✨ needsInterop mismatch detected for ${dep}`))
      }
    }
  }
  return needsInteropMismatch
}
