import path from 'node:path'
import type { OutgoingHttpHeaders, ServerResponse } from 'node:http'
import type { Options } from 'sirv'
import sirv from 'sirv'
import type { Connect } from 'dep-types/connect'
import escapeHtml from 'escape-html'
import type { ViteDevServer } from '../..'
import { FS_PREFIX } from '../../constants'
import {
  fsPathFromId,
  fsPathFromUrl,
  isFileReadable,
  isImportRequest,
  isInternalRequest,
  isParentDirectory,
  isSameFileUri,
  normalizePath,
  removeLeadingSlash,
} from '../../utils'
import {
  cleanUrl,
  isWindows,
  slash,
  withTrailingSlash,
} from '../../../shared/utils'

const knownJavascriptExtensionRE = /\.[tj]sx?$/

const sirvOptions = ({
  getHeaders,
}: {
  getHeaders: () => OutgoingHttpHeaders | undefined
}): Options => {
  return {
    dev: true,
    etag: true,
    extensions: [],
    setHeaders(res, pathname) {
      // Matches js, jsx, ts, tsx.
      // The reason this is done, is that the .ts file extension is reserved
      // for the MIME type video/mp2t. In almost all cases, we can expect
      // these files to be TypeScript files, and for Vite to serve them with
      // this Content-Type.
      if (knownJavascriptExtensionRE.test(pathname)) {
        res.setHeader('Content-Type', 'text/javascript')
      }
      const headers = getHeaders()
      if (headers) {
        for (const name in headers) {
          res.setHeader(name, headers[name]!)
        }
      }
    },
  }
}

/**
 * 用于在 Vite 开发服务器中提供公共目录（publicDir）文件的中间件。
 * 它使用了 sirv 库来高效地处理静态文件的请求。这个中间件会拦截请求并检查请求的 URL 是否匹配公共文件夹中的文件路径，如果匹配，则将该文件作为静态资源响应
 * @param server
 * @param publicFiles
 */
export function servePublicMiddleware(
  server: ViteDevServer,
  publicFiles?: Set<string>,
): Connect.NextHandleFunction {
  // dir 是 Vite 配置中的 publicDir，即存放静态资源的目录
  const dir = server.config.publicDir
  // sirv 是一个高效的静态文件服务器，用于服务公共目录中的文件。通过传递配置项 sirvOptions，可以自定义一些行为，例如设置响应头（getHeaders），这会从 Vite 的配置中获取 server.headers
  const serve = sirv(
    dir,
    sirvOptions({
      getHeaders: () => server.config.server.headers,
    }),
  )

  // URL 处理，将 URL 转换为文件路径
  const toFilePath = (url: string) => {
    let filePath = cleanUrl(url) // 清理 URL
    if (filePath.indexOf('%') !== -1) {
      try {
        filePath = decodeURI(filePath) // 解码 URL 中的百分号编码
      } catch (err) {
        /* malform uri */
      }
    }
    return normalizePath(filePath) // 规范化路径
  }

  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function viteServePublicMiddleware(req, res, next) {
    // To avoid the performance impact of `existsSync` on every request, we check against an
    // in-memory set of known public files. This set is updated on restarts.
    // also skip import request and internal requests `/@fs/ /@vite-client` etc...
    // 如果提供了 publicFiles，中间件会通过查找请求的文件路径是否存在于 publicFiles 中来决定是否提供该文件。如果路径不在 publicFiles 集合中，说明请求的不是公共文件，则跳过当前中间件，调用 next() 传递给下一个中间件
    if (
      (publicFiles && !publicFiles.has(toFilePath(req.url!))) || // 判断是否为已知的公共文件
      isImportRequest(req.url!) || // 跳过导入请求
      isInternalRequest(req.url!) // 跳过内部请求
    ) {
      return next() // 如果不是公共文件请求，传递给下一个中间件
    }
    serve(req, res, next) // 否则，通过 sirv 提供静态文件
  }
}

/**
 * 用于在 Vite 开发服务器中提供静态文件服务的中间件。它将根据配置的根目录（root）提供文件，特别是在请求不是 HTML 或内部请求时。
 * 这个中间件还支持路径重定向和别名替换，使得静态资源路径的处理更加灵活
 *
 * 这个中间件适用于以下场景：
 *
 * 1. 提供静态资源：它使得 Vite 能够提供静态资源文件，例如 JS、CSS、图片等，前提是这些文件位于 Vite 项目的根目录（root）下。
 * 2. 路径别名支持：对于项目中使用了路径别名的情况（例如 @assets），它会自动将请求路径中的别名替换为实际路径。
 * 3. HTML 请求的排除：对于 .html 文件请求，或者以 / 结尾的目录请求，它会让其他中间件处理（例如 Vite 的 HTML 处理），而不是直接提供静态文件。
 * 4. 路径访问控制：它会确保静态文件的访问是被授权的，避免访问到项目目录之外的文件。
 * @param server
 */
export function serveStaticMiddleware(
  server: ViteDevServer,
): Connect.NextHandleFunction {
  const dir = server.config.root
  // sirv 用于处理静态文件请求，serve 是用于处理来自指定目录（dir）的静态文件的函数。
  // sirvOptions 用于配置静态文件的响应头，通过 server.config.server.headers 获取配置
  const serve = sirv(
    dir,
    sirvOptions({
      getHeaders: () => server.config.server.headers,
    }),
  )

  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function viteServeStaticMiddleware(req, res, next) {
    // only serve the file if it's not an html request or ends with `/`
    // so that html requests can fallthrough to our html middleware for
    // special processing
    // also skip internal requests `/@fs/ /@vite-client` etc...
    // cleanUrl 用于清理请求 URL，确保 URL 不包含多余的斜杠或其他可能干扰路径解析的字符
    const cleanedUrl = cleanUrl(req.url!)
    // 如果请求的 URL 是以 / 结尾，或者请求的是 .html 文件，或者是内部请求（例如 /@vite-client 或 /@fs/ 等），则跳过静态文件服务，继续调用下一个中间件
    if (
      cleanedUrl[cleanedUrl.length - 1] === '/' ||
      path.extname(cleanedUrl) === '.html' ||
      isInternalRequest(req.url!)
    ) {
      return next()
    }

    // 请求的 URL 被转换为 URL 对象，并且去除多余的斜杠（//）。decodeURI 用于解码路径中的任何 URI 编码
    const url = new URL(req.url!.replace(/^\/{2,}/, '/'), 'http://example.com')
    const pathname = decodeURI(url.pathname)

    // apply aliases to static requests as well
    // 遍历 Vite 配置中的路径别名（resolve.alias），检查请求的路径是否匹配别名。如果匹配，则将路径重定向到替换后的路径
    let redirectedPathname: string | undefined
    for (const { find, replacement } of server.config.resolve.alias) {
      const matches =
        typeof find === 'string'
          ? pathname.startsWith(find)
          : find.test(pathname)
      if (matches) {
        redirectedPathname = pathname.replace(find, replacement)
        break
      }
    }
    // 如果路径被重定向，则去除根目录（dir）部分，使得路径是相对于服务器根目录的
    if (redirectedPathname) {
      // dir is pre-normalized to posix style
      if (redirectedPathname.startsWith(withTrailingSlash(dir))) {
        redirectedPathname = redirectedPathname.slice(dir.length)
      }
    }

    // 根据重定向后的路径或原始路径，计算出文件的实际路径（fileUrl）
    const resolvedPathname = redirectedPathname || pathname
    let fileUrl = path.resolve(dir, removeLeadingSlash(resolvedPathname))
    if (
      resolvedPathname[resolvedPathname.length - 1] === '/' &&
      fileUrl[fileUrl.length - 1] !== '/'
    ) {
      fileUrl = withTrailingSlash(fileUrl)
    }
    // 调用 ensureServingAccess 确保该文件路径是可以访问的。如果访问受限，则返回，避免继续处理请求
    if (!ensureServingAccess(fileUrl, server, res, next)) {
      return
    }

    // 如果路径发生了重定向，则更新请求的 URL，以便正确地服务重定向后的资源
    if (redirectedPathname) {
      url.pathname = encodeURI(redirectedPathname)
      req.url = url.href.slice(url.origin.length)
    }

    // 最后，调用 serve 来提供静态文件。sirv 会根据路径从服务器的根目录提供文件
    serve(req, res, next)
  }
}

/**
 * 用于在 Vite 开发服务器中提供文件系统访问的中间件。这个中间件允许你在某些情况下通过 /@fs/ 前缀来访问文件系统中的文件，而不仅限于公共目录（publicDir）。
 * 它主要用于支持一些特定场景，比如 monorepos 或者其他类型的文件系统结构，其中文件可能位于 Vite 项目根目录之外。
 * @param server
 */
export function serveRawFsMiddleware(
  server: ViteDevServer,
): Connect.NextHandleFunction {
  // sirv 用于处理静态文件请求。serveFromRoot 用于服务文件系统根目录中的静态文件，并将文件的响应头从 Vite 的服务器配置中获取
  const serveFromRoot = sirv(
    '/',
    sirvOptions({ getHeaders: () => server.config.server.headers }),
  )

  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function viteServeRawFsMiddleware(req, res, next) {
    // 请求的 URL 被处理成 URL 对象，并去掉了可能存在的多余的斜杠（//）。这是为了确保后续的路径操作是安全且一致的
    const url = new URL(req.url!.replace(/^\/{2,}/, '/'), 'http://example.com')
    // In some cases (e.g. linked monorepos) files outside of root will
    // reference assets that are also out of served root. In such cases
    // the paths are rewritten to `/@fs/` prefixed paths and must be served by
    // searching based from fs root. 处理 @fs 前缀的请求
    if (url.pathname.startsWith(FS_PREFIX)) { // 检查请求的路径是否以 /@fs/ 开头。FS_PREFIX 是一个常量，表示文件系统路径的前缀
      const pathname = decodeURI(url.pathname) // 使用 decodeURI 解码路径，确保 URL 中的特殊字符被正确处理
      // restrict files outside of `fs.allow`
      // 访问权限检查：调用 ensureServingAccess 来检查是否允许访问文件系统中的该文件。它确保了文件访问的安全性，避免不合法的文件访问。slash(path.resolve(fsPathFromId(pathname))) 会将文件路径转化为一个标准的系统路径进行访问控制
      if (
        !ensureServingAccess(
          slash(path.resolve(fsPathFromId(pathname))),
          server,
          res,
          next,
        )
      ) {
        return
      }

      // 路径修正：将路径去除 /@fs/ 前缀并根据操作系统（Windows 会有不同的路径格式）进行适当的修正
      let newPathname = pathname.slice(FS_PREFIX.length)
      if (isWindows) newPathname = newPathname.replace(/^[A-Z]:/i, '')

      url.pathname = encodeURI(newPathname)
      // 重新设置请求 URL：将修改后的路径重新编码并更新 req.url，确保请求被正确处理
      req.url = url.href.slice(url.origin.length)
      // 如果路径通过了访问检查并且是以 /@fs/ 开头，最终会调用 serveFromRoot 来提供文件。这个过程类似于提供公共目录中的文件
      serveFromRoot(req, res, next)
    } else {
      next() // 如果请求路径不是以 /@fs/ 开头，直接调用 next()，传递给下一个中间件进行处理
    }
  }
}

/**
 * Check if the url is allowed to be served, via the `server.fs` config.
 */
export function isFileServingAllowed(
  url: string,
  server: ViteDevServer,
): boolean {
  if (!server.config.server.fs.strict) return true

  const file = fsPathFromUrl(url)

  if (server._fsDenyGlob(file)) return false

  if (server.moduleGraph.safeModulesPath.has(file)) return true

  if (
    server.config.server.fs.allow.some(
      (uri) => isSameFileUri(uri, file) || isParentDirectory(uri, file),
    )
  )
    return true

  return false
}

function ensureServingAccess(
  url: string,
  server: ViteDevServer,
  res: ServerResponse,
  next: Connect.NextFunction,
): boolean {
  if (isFileServingAllowed(url, server)) {
    return true
  }
  if (isFileReadable(cleanUrl(url))) {
    const urlMessage = `The request url "${url}" is outside of Vite serving allow list.`
    const hintMessage = `
${server.config.server.fs.allow.map((i) => `- ${i}`).join('\n')}

Refer to docs https://vitejs.dev/config/server-options.html#server-fs-allow for configurations and more details.`

    server.config.logger.error(urlMessage)
    server.config.logger.warnOnce(hintMessage + '\n')
    res.statusCode = 403
    res.write(renderRestrictedErrorHTML(urlMessage + '\n' + hintMessage))
    res.end()
  } else {
    // if the file doesn't exist, we shouldn't restrict this path as it can
    // be an API call. Middlewares would issue a 404 if the file isn't handled
    next()
  }
  return false
}

function renderRestrictedErrorHTML(msg: string): string {
  // to have syntax highlighting and autocompletion in IDE
  const html = String.raw
  return html`
    <body>
      <h1>403 Restricted</h1>
      <p>${escapeHtml(msg).replace(/\n/g, '<br/>')}</p>
      <style>
        body {
          padding: 1em 2em;
        }
      </style>
    </body>
  `
}
