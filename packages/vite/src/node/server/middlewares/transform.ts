import path from 'node:path'
import fsp from 'node:fs/promises'
import type { Connect } from 'dep-types/connect'
import colors from 'picocolors'
import type { ExistingRawSourceMap } from 'rollup'
import type { ViteDevServer } from '..'
import {
  createDebugger,
  fsPathFromId,
  injectQuery,
  isImportRequest,
  isJSRequest,
  normalizePath,
  prettifyUrl,
  removeImportQuery,
  removeTimestampQuery,
  urlRE,
} from '../../utils'
import { send } from '../send'
import { ERR_LOAD_URL, transformRequest } from '../transformRequest'
import { applySourcemapIgnoreList } from '../sourcemap'
import { isHTMLProxy } from '../../plugins/html'
import { DEP_VERSION_RE, FS_PREFIX } from '../../constants'
import {
  isCSSRequest,
  isDirectCSSRequest,
  isDirectRequest,
} from '../../plugins/css'
import {
  ERR_FILE_NOT_FOUND_IN_OPTIMIZED_DEP_DIR,
  ERR_OPTIMIZE_DEPS_PROCESSING_ERROR,
  ERR_OUTDATED_OPTIMIZED_DEP,
} from '../../plugins/optimizedDeps'
import { ERR_CLOSED_SERVER } from '../pluginContainer'
import { getDepsOptimizer } from '../../optimizer'
import { cleanUrl, unwrapId, withTrailingSlash } from '../../../shared/utils'
import { NULL_BYTE_PLACEHOLDER } from '../../../shared/constants'

const debugCache = createDebugger('vite:cache')

const knownIgnoreList = new Set(['/', '/favicon.ico'])

/**
 * A middleware that short-circuits the middleware chain to serve cached transformed modules
 * 用于处理请求缓存和响应 304 状态码。它的主要功能是根据请求头中的 If-None-Match 来判断是否可以返回一个 304 响应，从而避免不必要的资源重新加载
 */
export function cachedTransformMiddleware(
  server: ViteDevServer,
): Connect.NextHandleFunction {
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function viteCachedTransformMiddleware(req, res, next) {
    // check if we can return 304 early
    // If-None-Match 是一个 HTTP 请求头，通常用于缓存控制。当请求的资源的 ETag（实体标签）和缓存中保存的 ETag 匹配时，服务器可以返回 304 状态码，表示资源没有改变，客户端可以继续使用缓存的资源。
    const ifNoneMatch = req.headers['if-none-match']
    if (ifNoneMatch) {
      // 通过 server.moduleGraph.getModuleByEtag 查找与 If-None-Match 中的 ETag 匹配的模块。
      // 如果模块的 ETag 和请求头中的 If-None-Match 匹配，说明资源没有变化。
      const moduleByEtag = server.moduleGraph.getModuleByEtag(ifNoneMatch)
      if (moduleByEtag?.transformResult?.etag === ifNoneMatch) {
        // For CSS requests, if the same CSS file is imported in a module,
        // the browser sends the request for the direct CSS request with the etag
        // from the imported CSS module. We ignore the etag in this case.
        // 如果请求的 URL 是一个 CSS 文件，isCSSRequest 函数会判断当前请求是否为 CSS 资源。
        // 如果是 CSS 请求，则忽略缓存逻辑，因为 CSS 文件可能被多个模块引用，无法简单通过 ETag 判断是否需要返回 304
        const maybeMixedEtag = isCSSRequest(req.url!)
        if (!maybeMixedEtag) {
          // 如果条件满足，即资源没有变化，并且不是 CSS 请求，则返回 304 响应，表示资源没有更新
          debugCache?.(`[304] ${prettifyUrl(req.url!, server.config.root)}`)
          res.statusCode = 304
          return res.end()
        }
      }
    }
    // 如果条件不满足，调用 next() 继续处理请求
    next()
  }
}

/**
 * 根据请求的类型处理不同的请求并进行相应的转化
 *
 * 1. 源映射逻辑：为优化过的依赖或非优化依赖返回源映射。
 * 2. 缓存与头部设置：支持缓存策略（例如对于优化过的依赖使用 max-age=31536000）并管理 304 Not Modified 响应。
 * 3. 错误代码处理：对于依赖缺失、过期请求等特定错误，发送相应的 HTTP 状态码（如 504 或 404）。
 * 4. 公用资源路径警告：当公用目录的资源使用不当时，给出警告提示。
 * @param server
 */
export function transformMiddleware(
  server: ViteDevServer,
): Connect.NextHandleFunction {
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`

  // check if public dir is inside root dir
  const { root, publicDir } = server.config
  const publicDirInRoot = publicDir.startsWith(withTrailingSlash(root))
  const publicPath = `${publicDir.slice(root.length)}/`

  return async function viteTransformMiddleware(req, res, next) {
    // 只处理 GET 请求，并且这些请求不在 knownIgnoreList 中
    if (req.method !== 'GET' || knownIgnoreList.has(req.url!)) {
      return next()
    }

    let url: string
    try {
      url = decodeURI(removeTimestampQuery(req.url!)).replace(
        NULL_BYTE_PLACEHOLDER,
        '\0',
      )
    } catch (e) {
      return next(e)
    }

    const withoutQuery = cleanUrl(url)

    try { // 如果请求的 URL 是源映射（以 .map 结尾），则会尝试为预打包的依赖或优化模块返回源映射
      const isSourceMap = withoutQuery.endsWith('.map')
      // since we generate source map references, handle those requests here
      if (isSourceMap) {
        const depsOptimizer = getDepsOptimizer(server.config, false) // non-ssr
        if (depsOptimizer?.isOptimizedDepUrl(url)) {
          // If the browser is requesting a source map for an optimized dep, it
          // means that the dependency has already been pre-bundled and loaded
          const sourcemapPath = url.startsWith(FS_PREFIX)
            ? fsPathFromId(url)
            : normalizePath(path.resolve(server.config.root, url.slice(1)))
          try {
            const map = JSON.parse(
              await fsp.readFile(sourcemapPath, 'utf-8'),
            ) as ExistingRawSourceMap

            applySourcemapIgnoreList(
              map,
              sourcemapPath,
              server.config.server.sourcemapIgnoreList,
              server.config.logger,
            )

            return send(req, res, JSON.stringify(map), 'json', {
              headers: server.config.server.headers,
            })
          } catch (e) {
            // Outdated source map request for optimized deps, this isn't an error
            // but part of the normal flow when re-optimizing after missing deps
            // Send back an empty source map so the browser doesn't issue warnings
            const dummySourceMap = {
              version: 3,
              file: sourcemapPath.replace(/\.map$/, ''),
              sources: [],
              sourcesContent: [],
              names: [],
              mappings: ';;;;;;;;;',
            } // 如果在获取源映射时发生错误，会返回一个空的源映射，以避免浏览器警告。
            return send(req, res, JSON.stringify(dummySourceMap), 'json', {
              cacheControl: 'no-cache',
              headers: server.config.server.headers,
            })
          }
        } else {
          const originalUrl = url.replace(/\.map($|\?)/, '$1')
          const map = (
            await server.moduleGraph.getModuleByUrl(originalUrl, false)
          )?.transformResult?.map
          if (map) {
            return send(req, res, JSON.stringify(map), 'json', {
              headers: server.config.server.headers,
            })
          } else {
            return next()
          }
        }
      }

      // 如果 publicDir 在根目录内，函数会检查请求的 URL 是否包含公用目录的路径，并且在不正确使用时给出警告
      if (publicDirInRoot && url.startsWith(publicPath)) {
        warnAboutExplicitPublicPathInUrl(url)
      }

      if (
        isJSRequest(url) ||
        isImportRequest(url) ||
        isCSSRequest(url) ||
        isHTMLProxy(url)
      ) {
        // strip ?import
        url = removeImportQuery(url)
        // Strip valid id prefix. This is prepended to resolved Ids that are
        // not valid browser import specifiers by the importAnalysis plugin.
        url = unwrapId(url)

        // for CSS, we differentiate between normal CSS requests and imports
        if (isCSSRequest(url)) {
          if (
            req.headers.accept?.includes('text/css') &&
            !isDirectRequest(url)
          ) {
            url = injectQuery(url, 'direct')
          }

          // check if we can return 304 early for CSS requests. These aren't handled
          // by the cachedTransformMiddleware due to the browser possibly mixing the
          // etags of direct and imported CSS
          const ifNoneMatch = req.headers['if-none-match']
          if (
            ifNoneMatch &&
            (await server.moduleGraph.getModuleByUrl(url, false))
              ?.transformResult?.etag === ifNoneMatch
          ) {
            debugCache?.(`[304] ${prettifyUrl(url, server.config.root)}`)
            res.statusCode = 304
            return res.end()
          }
        }

        // resolve, load and transform using the plugin container
        const result = await transformRequest(url, server, {
          html: req.headers.accept?.includes('text/html'),
        })
        if (result) {
          const depsOptimizer = getDepsOptimizer(server.config, false) // non-ssr
          const type = isDirectCSSRequest(url) ? 'css' : 'js'
          const isDep =
            DEP_VERSION_RE.test(url) || depsOptimizer?.isOptimizedDepUrl(url)
          return send(req, res, result.code, type, {
            etag: result.etag,
            // allow browser to cache npm deps!
            cacheControl: isDep ? 'max-age=31536000,immutable' : 'no-cache',
            headers: server.config.server.headers,
            map: result.map,
          })
        }
      }
    } catch (e) {
      if (e?.code === ERR_OPTIMIZE_DEPS_PROCESSING_ERROR) {
        // Skip if response has already been sent
        if (!res.writableEnded) {
          res.statusCode = 504 // status code request timeout
          res.statusMessage = 'Optimize Deps Processing Error'
          res.end()
        }
        // This timeout is unexpected
        server.config.logger.error(e.message)
        return
      }
      if (e?.code === ERR_OUTDATED_OPTIMIZED_DEP) {
        // Skip if response has already been sent
        if (!res.writableEnded) {
          res.statusCode = 504 // status code request timeout
          res.statusMessage = 'Outdated Optimize Dep'
          res.end()
        }
        // We don't need to log an error in this case, the request
        // is outdated because new dependencies were discovered and
        // the new pre-bundle dependencies have changed.
        // A full-page reload has been issued, and these old requests
        // can't be properly fulfilled. This isn't an unexpected
        // error but a normal part of the missing deps discovery flow
        return
      }
      if (e?.code === ERR_CLOSED_SERVER) {
        // Skip if response has already been sent
        if (!res.writableEnded) {
          res.statusCode = 504 // status code request timeout
          res.statusMessage = 'Outdated Request'
          res.end()
        }
        // We don't need to log an error in this case, the request
        // is outdated because new dependencies were discovered and
        // the new pre-bundle dependencies have changed.
        // A full-page reload has been issued, and these old requests
        // can't be properly fulfilled. This isn't an unexpected
        // error but a normal part of the missing deps discovery flow
        return
      }
      if (e?.code === ERR_FILE_NOT_FOUND_IN_OPTIMIZED_DEP_DIR) {
        // Skip if response has already been sent
        if (!res.writableEnded) {
          res.statusCode = 404
          res.end()
        }
        server.config.logger.warn(colors.yellow(e.message))
        return
      }
      if (e?.code === ERR_LOAD_URL) {
        // Let other middleware handle if we can't load the url via transformRequest
        return next()
      }
      return next(e)
    }

    next()
  }

  function warnAboutExplicitPublicPathInUrl(url: string) {
    let warning: string

    if (isImportRequest(url)) {
      const rawUrl = removeImportQuery(url)
      if (urlRE.test(url)) {
        warning =
          `Assets in the public directory are served at the root path.\n` +
          `Instead of ${colors.cyan(rawUrl)}, use ${colors.cyan(
            rawUrl.replace(publicPath, '/'),
          )}.`
      } else {
        warning =
          'Assets in public directory cannot be imported from JavaScript.\n' +
          `If you intend to import that asset, put the file in the src directory, and use ${colors.cyan(
            rawUrl.replace(publicPath, '/src/'),
          )} instead of ${colors.cyan(rawUrl)}.\n` +
          `If you intend to use the URL of that asset, use ${colors.cyan(
            injectQuery(rawUrl.replace(publicPath, '/'), 'url'),
          )}.`
      }
    } else {
      warning =
        `Files in the public directory are served at the root path.\n` +
        `Instead of ${colors.cyan(url)}, use ${colors.cyan(
          url.replace(publicPath, '/'),
        )}.`
    }

    server.config.logger.warn(colors.yellow(warning))
  }
}
