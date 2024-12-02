import type { Connect } from 'dep-types/connect'

/**
 * 用于处理 404 错误（即找不到资源）请求的中间件。它的作用是在请求的资源无法找到时，返回一个 404 状态码，并结束响应
 *
 * notFoundMiddleware 可以用于以下几种情况：
 *
 * 1. 处理未知路径：当请求的 URL 不能匹配任何已注册的资源路径时，触发该中间件返回 404 错误。这通常在 URL 没有匹配到任何有效路由或资源时使用。
 * 2. 作为路由链中的最后一个中间件：这个中间件通常会被放在所有其他路由中间件的最后，以便当没有任何其他中间件处理请求时，返回 404 错误。例如，所有的静态文件中间件和 API 路由都没有匹配时，就会进入到这个中间件，最终返回 404。
 * 3. 用于自定义错误页面：可以在客户端接收到 404 错误后，显示一个自定义的错误页面。
 */
export function notFoundMiddleware(): Connect.NextHandleFunction {
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function vite404Middleware(_, res) {
    res.statusCode = 404 // 设置响应状态码为 404
    res.end() // 结束响应，表示请求的资源未找到
  }
}
