import path from 'node:path'
import type { Connect } from 'dep-types/connect'
import { createDebugger } from '../../utils'
import type { FsUtils } from '../../fsUtils'
import { commonFsUtils } from '../../fsUtils'
import { cleanUrl } from '../../../shared/utils'

const debug = createDebugger('vite:html-fallback')

/**
 * 用于处理 HTML 路由回退的中间件，通常用于单页面应用（SPA）。当用户访问的路径对应的静态资源文件（例如 .html 文件）不存在时，依照配置，它会将请求重定向到一个默认的 index.html 文件。这个功能对于 SPA 特别有用，因为 SPA 通常依赖于一个通用的 HTML 文件来处理不同的路由
 *
 * 这个中间件特别适用于以下几种场景：
 *
 * 1. 单页面应用（SPA）：当用户直接访问一个深层次的路径（例如 http://example.com/about），而该路径对应的 .html 文件不存在时，它会回退到 index.html，确保应用能正确加载。
 * 2. 路径重写：对于未找到的 HTML 文件路径（例如 /about），会自动重写为 /about.html 或 /index.html，避免 404 错误。
 * 3. 静态资源的处理：此中间件使得 Vite 能够正确处理静态资源请求，尤其是在 SPA 中，确保所有路由都能通过单一的 HTML 文件进行处理。
 */
export function htmlFallbackMiddleware(
  root: string,
  spaFallback: boolean,
  fsUtils: FsUtils = commonFsUtils,
): Connect.NextHandleFunction {
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function viteHtmlFallbackMiddleware(req, res, next) {
    if (
      // Only accept GET or HEAD
      // 只有当请求方法是 GET 或 HEAD 时，才会继续处理。其他方法（如 POST 或 PUT）会被跳过
      (req.method !== 'GET' && req.method !== 'HEAD') ||
      // Exclude default favicon requests
      // 排除请求 /favicon.ico，因为这通常是浏览器自动请求的图标文件，不需要重写
      req.url === '/favicon.ico' ||
      // Require Accept: text/html or */*
      // 检查请求头中的 Accept 是否包含 text/html 或 */*，这表示浏览器期望接收 HTML 内容
      !(
        req.headers.accept === undefined || // equivalent to `Accept: */*`
        req.headers.accept === '' || // equivalent to `Accept: */*`
        req.headers.accept.includes('text/html') ||
        req.headers.accept.includes('*/*')
      )
    ) {
      return next() // 如果不满足条件，直接跳过
    }

    const url = cleanUrl(req.url!) // 用于清理 URL（去除多余的斜杠等）
    const pathname = decodeURIComponent(url) // 用于解码 URL 中的编码字符

    // .html files are not handled by serveStaticMiddleware
    // so we need to check if the file exists
    // 如果请求的路径以 .html 结尾，检查该文件是否存在。如果文件存在，继续处理请求，不做任何修改
    if (pathname.endsWith('.html')) {
      const filePath = path.join(root, pathname)
      if (fsUtils.existsSync(filePath)) {
        debug?.(`Rewriting ${req.method} ${req.url} to ${url}`)
        req.url = url
        return next()
      }
    }
    // trailing slash should check for fallback index.html
      // 如果路径以 / 结尾，则查找该路径下是否存在 index.html 文件。如果存在，重写 URL，将其指向 index.html
    else if (pathname[pathname.length - 1] === '/') {
      const filePath = path.join(root, pathname, 'index.html')
      if (fsUtils.existsSync(filePath)) {
        const newUrl = url + 'index.html'
        debug?.(`Rewriting ${req.method} ${req.url} to ${newUrl}`)
        req.url = newUrl
        return next()
      }
    }
    // non-trailing slash should check for fallback .html
      // 如果路径不以 / 结尾，检查该路径是否对应一个 .html 文件。如果存在，重写 URL，并将其指向对应的 .html 文件
    else {
      const filePath = path.join(root, pathname + '.html')
      if (fsUtils.existsSync(filePath)) {
        const newUrl = url + '.html'
        debug?.(`Rewriting ${req.method} ${req.url} to ${newUrl}`)
        req.url = newUrl
        return next()
      }
    }

    // 如果启用了 spaFallback（即单页面应用回退），则在上述所有条件都不满足的情况下，强制将 URL 重写为 /index.html。这是为了确保所有未知路径都指向 index.html，由客户端 JavaScript 处理路由
    if (spaFallback) {
      debug?.(`Rewriting ${req.method} ${req.url} to /index.html`)
      req.url = '/index.html'
    }

    // 无论是否修改了请求 URL，都调用 next() 继续执行后续中间件
    next()
  }
}
