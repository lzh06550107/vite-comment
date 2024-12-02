import { performance } from 'node:perf_hooks'
import type { Connect } from 'dep-types/connect'
import { createDebugger, prettifyUrl, timeFrom } from '../../utils'

// vite:time 是调试命名空间，意味着调试信息将以该命名空间为前缀显示
const logTime = createDebugger('vite:time')

export function timeMiddleware(root: string): Connect.NextHandleFunction {
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function viteTimeMiddleware(req, res, next) {
    const start = performance.now() // 记录请求开始的时间
    const end = res.end
    // 我们重写了 res.end 方法，以便在响应结束时（即响应发送到客户端时）计算并记录请求处理的时间
    res.end = (...args: readonly [any, any?, any?]) => {
      // 计算请求的响应时间，并在响应结束时打印出来
      logTime?.(`${timeFrom(start)} ${prettifyUrl(req.url!, root)}`)
      // 调用原始的 res.end 方法，确保响应能够正常结束
      return end.call(res, ...args)
    }
    next()
  }
}
