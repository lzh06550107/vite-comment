import fsp from 'node:fs/promises'
import path from 'node:path'
import MagicString from 'magic-string'
import type { SourceMapInput } from 'rollup'
import type { Connect } from 'dep-types/connect'
import type { DefaultTreeAdapterMap, Token } from 'parse5'
import type { IndexHtmlTransformHook } from '../../plugins/html'
import {
  addToHTMLProxyCache,
  applyHtmlTransforms,
  assetAttrsConfig,
  extractImportExpressionFromClassicScript,
  findNeedTransformStyleAttribute,
  getAttrKey,
  getScriptInfo,
  htmlEnvHook,
  htmlProxyResult,
  injectCspNonceMetaTagHook,
  injectNonceAttributeTagHook,
  nodeIsElement,
  overwriteAttrValue,
  postImportMapHook,
  preImportMapHook,
  resolveHtmlTransforms,
  traverseHtml,
} from '../../plugins/html'
import type { PreviewServer, ResolvedConfig, ViteDevServer } from '../..'
import { send } from '../send'
import { CLIENT_PUBLIC_PATH, FS_PREFIX } from '../../constants'
import {
  ensureWatchedFile,
  fsPathFromId,
  getHash,
  injectQuery,
  isDevServer,
  isJSRequest,
  joinUrlSegments,
  normalizePath,
  processSrcSetSync,
  stripBase,
} from '../../utils'
import { getFsUtils } from '../../fsUtils'
import { checkPublicFile } from '../../publicDir'
import { isCSSRequest } from '../../plugins/css'
import { getCodeWithSourcemap, injectSourcesContent } from '../sourcemap'
import { cleanUrl, unwrapId, wrapId } from '../../../shared/utils'

interface AssetNode {
  start: number
  end: number
  code: string
}

interface InlineStyleAttribute {
  index: number
  location: Token.Location
  code: string
}

/**
 * 创建一个用于在开发环境中处理 HTML 内容的函数。这个函数在处理 HTML 内容时，会依次应用多个钩子（hooks）进行转换操作，最终返回修改后的 HTML
 * @param config 包含 Vite 配置信息，主要用于获取插件和日志记录器
 * 返回一个函数，该函数用于在开发环境中处理 HTML 内容
 */
export function createDevHtmlTransformFn(
  config: ResolvedConfig,
): (
  server: ViteDevServer,
  url: string,
  html: string,
  originalUrl?: string,
) => Promise<string> {
  // 首先通过 resolveHtmlTransforms 函数获取三个类型的 HTML 转换钩子
  // preHooks：在 HTML 中导入模块之前执行的钩子。
  // normalHooks：常规的 HTML 转换钩子。
  // postHooks：在 HTML 转换的最后阶段执行的钩子。
  const [preHooks, normalHooks, postHooks] = resolveHtmlTransforms(
    config.plugins,
    config.logger,
  )
  // 创建转换钩子数组
  // 函数会通过多个钩子函数（如 preImportMapHook, injectCspNonceMetaTagHook, htmlEnvHook 等）将这些钩子合并成一个完整的钩子链。
  // 每个钩子函数都将执行特定的 HTML 转换任务，例如注入 CSP（Content Security Policy）Nonce、添加环境变量、修改 HTML 内容等
  const transformHooks = [
    preImportMapHook(config),
    injectCspNonceMetaTagHook(config),
    ...preHooks,
    htmlEnvHook(config),
    devHtmlHook,
    ...normalHooks,
    ...postHooks,
    injectNonceAttributeTagHook(config),
    postImportMapHook(),
  ]
  // 返回一个异步函数
  return (
    server: ViteDevServer, // Vite 开发服务器实例
    url: string, // 当前请求的 URL
    html: string, // 需要处理的 HTML 内容
    originalUrl?: string, // （可选）：原始的 URL
  ): Promise<string> => {
    // 该返回的函数会通过 applyHtmlTransforms 函数应用所有的钩子，最终生成修改后的 HTML 内容
    return applyHtmlTransforms(html, transformHooks, {
      path: url, // 当前请求的 URL
      filename: getHtmlFilename(url, server), // 从 url 和 server 中推断出来的 HTML 文件名
      server, // Vite 开发服务器实例
      originalUrl, // 可选的原始 URL
    })
  }
}

function getHtmlFilename(url: string, server: ViteDevServer) {
  if (url.startsWith(FS_PREFIX)) {
    return decodeURIComponent(fsPathFromId(url))
  } else {
    return decodeURIComponent(
      normalizePath(path.join(server.config.root, url.slice(1))),
    )
  }
}

function shouldPreTransform(url: string, config: ResolvedConfig) {
  return (
    !checkPublicFile(url, config) && (isJSRequest(url) || isCSSRequest(url))
  )
}

const wordCharRE = /\w/

function isBareRelative(url: string) {
  return wordCharRE.test(url[0]) && !url.includes(':')
}

const isSrcSet = (attr: Token.Attribute) =>
  attr.name === 'srcset' && attr.prefix === undefined
const processNodeUrl = (
  url: string,
  useSrcSetReplacer: boolean,
  config: ResolvedConfig,
  htmlPath: string,
  originalUrl?: string,
  server?: ViteDevServer,
  isClassicScriptLink?: boolean,
): string => {
  // prefix with base (dev only, base is never relative)
  const replacer = (url: string) => {
    if (server?.moduleGraph) {
      const mod = server.moduleGraph.urlToModuleMap.get(url)
      if (mod && mod.lastHMRTimestamp > 0) {
        url = injectQuery(url, `t=${mod.lastHMRTimestamp}`)
      }
    }

    if (
      (url[0] === '/' && url[1] !== '/') ||
      // #3230 if some request url (localhost:3000/a/b) return to fallback html, the relative assets
      // path will add `/a/` prefix, it will caused 404.
      //
      // skip if url contains `:` as it implies a url protocol or Windows path that we don't want to replace.
      //
      // rewrite `./index.js` -> `localhost:5173/a/index.js`.
      // rewrite `../index.js` -> `localhost:5173/index.js`.
      // rewrite `relative/index.js` -> `localhost:5173/a/relative/index.js`.
      ((url[0] === '.' || isBareRelative(url)) &&
        originalUrl &&
        originalUrl !== '/' &&
        htmlPath === '/index.html')
    ) {
      url = path.posix.join(config.base, url)
    }

    if (server && !isClassicScriptLink && shouldPreTransform(url, config)) {
      let preTransformUrl: string | undefined
      if (url[0] === '/' && url[1] !== '/') {
        preTransformUrl = url
      } else if (url[0] === '.' || isBareRelative(url)) {
        preTransformUrl = path.posix.join(
          config.base,
          path.posix.dirname(htmlPath),
          url,
        )
      }
      if (preTransformUrl) {
        preTransformRequest(server, preTransformUrl, config.base)
      }
    }
    return url
  }

  const processedUrl = useSrcSetReplacer
    ? processSrcSetSync(url, ({ url }) => replacer(url))
    : replacer(url)
  return processedUrl
}
const devHtmlHook: IndexHtmlTransformHook = async (
  html,
  { path: htmlPath, filename, server, originalUrl },
) => {
  const { config, moduleGraph, watcher } = server!
  const base = config.base || '/'

  let proxyModulePath: string
  let proxyModuleUrl: string

  const trailingSlash = htmlPath.endsWith('/')
  if (!trailingSlash && getFsUtils(config).existsSync(filename)) {
    proxyModulePath = htmlPath
    proxyModuleUrl = proxyModulePath
  } else {
    // There are users of vite.transformIndexHtml calling it with url '/'
    // for SSR integrations #7993, filename is root for this case
    // A user may also use a valid name for a virtual html file
    // Mark the path as virtual in both cases so sourcemaps aren't processed
    // and ids are properly handled
    const validPath = `${htmlPath}${trailingSlash ? 'index.html' : ''}`
    proxyModulePath = `\0${validPath}`
    proxyModuleUrl = wrapId(proxyModulePath)
  }
  proxyModuleUrl = joinUrlSegments(base, proxyModuleUrl)

  const s = new MagicString(html)
  let inlineModuleIndex = -1
  // The key to the proxyHtml cache is decoded, as it will be compared
  // against decoded URLs by the HTML plugins.
  const proxyCacheUrl = decodeURI(
    cleanUrl(proxyModulePath).replace(normalizePath(config.root), ''),
  )
  const styleUrl: AssetNode[] = []
  const inlineStyles: InlineStyleAttribute[] = []

  const addInlineModule = (
    node: DefaultTreeAdapterMap['element'],
    ext: 'js',
  ) => {
    inlineModuleIndex++

    const contentNode = node.childNodes[0] as DefaultTreeAdapterMap['textNode']

    const code = contentNode.value

    let map: SourceMapInput | undefined
    if (proxyModulePath[0] !== '\0') {
      map = new MagicString(html)
        .snip(
          contentNode.sourceCodeLocation!.startOffset,
          contentNode.sourceCodeLocation!.endOffset,
        )
        .generateMap({ hires: 'boundary' })
      map.sources = [filename]
      map.file = filename
    }

    // add HTML Proxy to Map
    addToHTMLProxyCache(config, proxyCacheUrl, inlineModuleIndex, { code, map })

    // inline js module. convert to src="proxy" (dev only, base is never relative)
    const modulePath = `${proxyModuleUrl}?html-proxy&index=${inlineModuleIndex}.${ext}`

    // invalidate the module so the newly cached contents will be served
    const module = server?.moduleGraph.getModuleById(modulePath)
    if (module) {
      server?.moduleGraph.invalidateModule(module)
    }
    s.update(
      node.sourceCodeLocation!.startOffset,
      node.sourceCodeLocation!.endOffset,
      `<script type="module" src="${modulePath}"></script>`,
    )
    preTransformRequest(server!, modulePath, base)
  }

  await traverseHtml(html, filename, (node) => {
    if (!nodeIsElement(node)) {
      return
    }

    // script tags
    if (node.nodeName === 'script') {
      const { src, sourceCodeLocation, isModule } = getScriptInfo(node)

      if (src) {
        const processedUrl = processNodeUrl(
          src.value,
          isSrcSet(src),
          config,
          htmlPath,
          originalUrl,
          server,
          !isModule,
        )
        if (processedUrl !== src.value) {
          overwriteAttrValue(s, sourceCodeLocation!, processedUrl)
        }
      } else if (isModule && node.childNodes.length) {
        addInlineModule(node, 'js')
      } else if (node.childNodes.length) {
        const scriptNode = node.childNodes[
          node.childNodes.length - 1
        ] as DefaultTreeAdapterMap['textNode']
        for (const {
          url,
          start,
          end,
        } of extractImportExpressionFromClassicScript(scriptNode)) {
          const processedUrl = processNodeUrl(
            url,
            false,
            config,
            htmlPath,
            originalUrl,
          )
          if (processedUrl !== url) {
            s.update(start, end, processedUrl)
          }
        }
      }
    }

    const inlineStyle = findNeedTransformStyleAttribute(node)
    if (inlineStyle) {
      inlineModuleIndex++
      inlineStyles.push({
        index: inlineModuleIndex,
        location: inlineStyle.location!,
        code: inlineStyle.attr.value,
      })
    }

    if (node.nodeName === 'style' && node.childNodes.length) {
      const children = node.childNodes[0] as DefaultTreeAdapterMap['textNode']
      styleUrl.push({
        start: children.sourceCodeLocation!.startOffset,
        end: children.sourceCodeLocation!.endOffset,
        code: children.value,
      })
    }

    // elements with [href/src] attrs
    const assetAttrs = assetAttrsConfig[node.nodeName]
    if (assetAttrs) {
      for (const p of node.attrs) {
        const attrKey = getAttrKey(p)
        if (p.value && assetAttrs.includes(attrKey)) {
          const processedUrl = processNodeUrl(
            p.value,
            isSrcSet(p),
            config,
            htmlPath,
            originalUrl,
          )
          if (processedUrl !== p.value) {
            overwriteAttrValue(
              s,
              node.sourceCodeLocation!.attrs![attrKey],
              processedUrl,
            )
          }
        }
      }
    }
  })

  await Promise.all([
    ...styleUrl.map(async ({ start, end, code }, index) => {
      const url = `${proxyModulePath}?html-proxy&direct&index=${index}.css`

      // ensure module in graph after successful load
      const mod = await moduleGraph.ensureEntryFromUrl(url, false)
      ensureWatchedFile(watcher, mod.file, config.root)

      const result = await server!.pluginContainer.transform(code, mod.id!)
      let content = ''
      if (result) {
        if (result.map && 'version' in result.map) {
          if (result.map.mappings) {
            await injectSourcesContent(
              result.map,
              proxyModulePath,
              config.logger,
            )
          }
          content = getCodeWithSourcemap('css', result.code, result.map)
        } else {
          content = result.code
        }
      }
      s.overwrite(start, end, content)
    }),
    ...inlineStyles.map(async ({ index, location, code }) => {
      // will transform with css plugin and cache result with css-post plugin
      const url = `${proxyModulePath}?html-proxy&inline-css&style-attr&index=${index}.css`

      const mod = await moduleGraph.ensureEntryFromUrl(url, false)
      ensureWatchedFile(watcher, mod.file, config.root)

      await server?.pluginContainer.transform(code, mod.id!)

      const hash = getHash(cleanUrl(mod.id!))
      const result = htmlProxyResult.get(`${hash}_${index}`)
      overwriteAttrValue(s, location, result ?? '')
    }),
  ])

  html = s.toString()

  return {
    html,
    tags: [
      {
        tag: 'script',
        attrs: {
          type: 'module',
          src: path.posix.join(base, CLIENT_PUBLIC_PATH),
        },
        injectTo: 'head-prepend',
      },
    ],
  }
}

/**
 * 用于处理请求并返回 index.html 文件的中间件，通常用于 Vite 开发服务器或预览服务器中。这段代码的核心功能是处理请求 URL，读取相应的 HTML 文件，应用开发环境中的特殊转换，并最终将 HTML 内容返回给客户端
 *
 * 这个中间件的使用场景非常适合于以下几种情况：
 *
 * 1. 开发模式中的 HTML 转换：在开发模式下，index.html 文件可能需要根据不同的请求动态进行转换（例如，注入热更新的 JavaScript）。此中间件在开发模式下会调用 server.transformIndexHtml 对 HTML 文件进行转换，并将最终结果返回。
 * 2. 静态资源处理：如果请求的是一个 .html 文件，且文件存在，则直接返回该 HTML 文件。
 * 3. SPA（单页面应用）：用于处理 SPA 应用的 index.html 文件。在 SPA 中，所有的路由通常会指向同一个 index.html 文件，这个中间件确保了 HTML 文件能够被正确返回。
 * 4. 预览模式：当服务器处于预览模式时，该中间件使用预览模式的响应头返回 HTML 文件。
 * @param root
 * @param server
 */
export function indexHtmlMiddleware(
  root: string,
  server: ViteDevServer | PreviewServer,
): Connect.NextHandleFunction {
  const isDev = isDevServer(server) // 用于判断当前服务器是否处于开发模式
  const fsUtils = getFsUtils(server.config) // 获取一个文件系统工具（fsUtils），用于检查文件是否存在

  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return async function viteIndexHtmlMiddleware(req, res, next) {
    // 首先检查响应是否已经结束，如果是，则直接跳到下一个中间件
    if (res.writableEnded) {
      return next()
    }

    // 对请求 URL 进行清理，去除多余的斜杠等
    const url = req.url && cleanUrl(req.url)
    // htmlFallbackMiddleware appends '.html' to URLs
    // 判断请求的 URL 是否以 .html 结尾，且 sec-fetch-dest 头部不等于 script，即非脚本资源
    if (url?.endsWith('.html') && req.headers['sec-fetch-dest'] !== 'script') {
      let filePath: string
      // 根据当前是否为开发模式（isDev），决定文件路径的解析方式
      if (isDev && url.startsWith(FS_PREFIX)) {
        // 如果是开发模式，且 URL 以 FS_PREFIX 开头，使用 fsPathFromId 进行路径转换
        filePath = decodeURIComponent(fsPathFromId(url))
      } else {
        // 否则，直接将 URL 解码并拼接到服务器根目录路径上
        filePath = path.join(root, decodeURIComponent(url))
      }

      // 检查文件是否存在
      if (fsUtils.existsSync(filePath)) {
        // 根据是否是开发模式来选择使用不同的响应头
        const headers = isDev
          ? server.config.server.headers
          : server.config.preview.headers

        try {
          let html = await fsp.readFile(filePath, 'utf-8')
          // 尝试读取文件并将其作为 HTML 返回。如果是开发模式，还会调用 server.transformIndexHtml 对 HTML 内容进行转换
          if (isDev) {
            // 这是 Vite 的一个 API，用于在开发模式下动态转换 index.html，例如注入热更新脚本等
            html = await server.transformIndexHtml(url, html, req.originalUrl)
          }
          // 调用 send 函数将 HTML 内容发送给客户端，并附上适当的响应头
          return send(req, res, html, 'html', { headers })
        } catch (e) {
          return next(e)
        }
      }
    }
    // 如果文件不存在或遇到错误，调用 next() 进入下一个中间件
    next()
  }
}

function preTransformRequest(server: ViteDevServer, url: string, base: string) {
  if (!server.config.server.preTransformRequests) return

  // transform all url as non-ssr as html includes client-side assets only
  try {
    url = unwrapId(stripBase(decodeURI(url), base))
  } catch {
    // ignore
    return
  }
  server.warmupRequest(url)
}
