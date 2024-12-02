import colors from 'picocolors'
import type { RollupError } from 'rollup'
import type { Connect } from 'dep-types/connect'
import strip from 'strip-ansi'
import type { ErrorPayload } from 'types/hmrPayload'
import { pad } from '../../utils'
import type { ViteDevServer } from '../..'

export function prepareError(err: Error | RollupError): ErrorPayload['err'] {
  // only copy the information we need and avoid serializing unnecessary
  // properties, since some errors may attach full objects (e.g. PostCSS)
  return {
    message: strip(err.message),
    stack: strip(cleanStack(err.stack || '')),
    id: (err as RollupError).id,
    frame: strip((err as RollupError).frame || ''),
    plugin: (err as RollupError).plugin,
    pluginCode: (err as RollupError).pluginCode?.toString(),
    loc: (err as RollupError).loc,
  }
}

export function buildErrorMessage(
  err: RollupError,
  args: string[] = [],
  includeStack = true,
): string {
  if (err.plugin) args.push(`  Plugin: ${colors.magenta(err.plugin)}`)
  const loc = err.loc ? `:${err.loc.line}:${err.loc.column}` : ''
  if (err.id) args.push(`  File: ${colors.cyan(err.id)}${loc}`)
  if (err.frame) args.push(colors.yellow(pad(err.frame)))
  if (includeStack && err.stack) args.push(pad(cleanStack(err.stack)))
  return args.join('\n')
}

function cleanStack(stack: string) {
  return stack
    .split(/\n/g)
    .filter((l) => /^\s*at/.test(l))
    .join('\n')
}

export function logError(server: ViteDevServer, err: RollupError): void {
  const msg = buildErrorMessage(err, [
    colors.red(`Internal server error: ${err.message}`),
  ])

  server.config.logger.error(msg, {
    clear: true,
    timestamp: true,
    error: err,
  })

  server.hot.send({
    type: 'error',
    err: prepareError(err),
  })
}

/**
 * 用于处理错误的中间件，它的作用是捕获在 Vite 服务中发生的错误，并返回一个错误响应。可以选择是否将错误传递给下一个中间件，或者直接终止请求并展示错误页面
 *
 * errorMiddleware 中间件适用于以下场景：
 *
 * 1. 开发环境中的错误捕获：可以用来捕获 Vite 服务中的错误，并返回详细的错误信息到浏览器，帮助开发者快速定位和修复问题。
 * 2. 自定义错误页面：当发生错误时，返回一个自定义的错误页面，而不是默认的 500 错误响应。
 * 3. 调试和日志记录：通过 logError 函数记录详细的错误信息，方便开发人员排查问题。
 * @param server
 * @param allowNext
 */
export function errorMiddleware(
  server: ViteDevServer,
  allowNext = false,
): Connect.ErrorHandleFunction {
  // note the 4 args must be kept for connect to treat this as error middleware
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  /**
   * 这个函数接收四个参数：
   * err: 捕获的错误对象（通常是 RollupError 类型）。
   * _req: 请求对象，未使用。
   * res: 响应对象，处理中会用到。
   * next: 用于传递控制权到下一个中间件，处理完错误后调用。
   */
  return function viteErrorMiddleware(err: RollupError, _req, res, next) {
    logError(server, err) // 记录错误日志

    if (allowNext) {
      next() // 如果 allowNext 为 true，传递错误到下一个中间件
    } else {
      res.statusCode = 500
      res.end(`
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="UTF-8" />
            <title>Error</title>
            <script type="module">
              import { ErrorOverlay } from '/@vite/client'
              document.body.appendChild(new ErrorOverlay(${JSON.stringify(
                prepareError(err),
              ).replace(/</g, '\\u003c')}))
            </script>
          </head>
          <body>
          </body>
        </html>
      `)// 渲染一个包含错误信息的 HTML 页面
    }
  }
}
