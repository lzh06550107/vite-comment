import type { Connect } from 'dep-types/connect'
import { joinUrlSegments, stripBase } from '../../utils'
import { cleanUrl, withTrailingSlash } from '../../../shared/utils'

// this middleware is only active when (base !== '/')

/**
 * 主要用于处理与基础路径（base）相关的 URL 重写、重定向和错误处理。它会根据请求的 URL 和 Vite 配置的 base 路径进行处理，以确保请求能正确地访问到对应的资源
 * @param rawBase 配置的基础路径
 * @param middlewareMode 中间件模式，是否跳过一些操作
 */
export function baseMiddleware(
  rawBase: string,
  middlewareMode: boolean,
): Connect.NextHandleFunction {
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function viteBaseMiddleware(req, res, next) {
    const url = req.url! // 获取请求的 URL
    const pathname = cleanUrl(url) // 清理 URL，可能会去掉 query 参数等
    const base = rawBase // 使用传入的基础路径

    if (pathname.startsWith(base)) {
      // rewrite url to remove base. this ensures that other middleware does
      // not need to consider base being prepended or not
      // 如果 URL 以 base 开头，移除 base 并继续处理
      req.url = stripBase(url, base) // 去除基础路径
      return next() // 继续传递给下一个中间件
    }

    // skip redirect and error fallback on middleware mode, #4057
    // 如果是中间件模式，直接跳过后续操作
    if (middlewareMode) {
      return next()
    }

    if (pathname === '/' || pathname === '/index.html') {
      // redirect root visit to based url with search and hash
      // 如果请求的是根路径或者 index.html，进行重定向
      res.writeHead(302, {
        Location: base + url.slice(pathname.length),
      })
      res.end()
      return
    }

    // non-based page visit 其他页面资源的访问
    const redirectPath =
      withTrailingSlash(url) !== base ? joinUrlSegments(base, url) : base
    if (req.headers.accept?.includes('text/html')) {
      // 如果请求的 URL 不以 base 路径开头，并且请求的是 HTML 页面，返回 404 错误页面，并提示用户应该访问带有 base 路径的 URL
      res.writeHead(404, {
        'Content-Type': 'text/html',
      })
      res.end(
        `The server is configured with a public base URL of ${base} - ` +
          `did you mean to visit <a href="${redirectPath}">${redirectPath}</a> instead?`,
      )
      return
    } else {
      // not found for resources
      // 如果请求的是其他资源类型（如图片、JS、CSS 文件等），也返回 404 错误，但以纯文本格式返回
      res.writeHead(404, {
        'Content-Type': 'text/plain',
      })
      res.end(
        `The server is configured with a public base URL of ${base} - ` +
          `did you mean to visit ${redirectPath} instead?`,
      )
      return
    }
  }
}
