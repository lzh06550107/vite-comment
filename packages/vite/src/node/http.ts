import fsp from 'node:fs/promises'
import path from 'node:path'
import type { OutgoingHttpHeaders as HttpServerHeaders } from 'node:http'
import type { ServerOptions as HttpsServerOptions } from 'node:https'
import type { Connect } from 'dep-types/connect'
import colors from 'picocolors'
import type { ProxyOptions } from './server/middlewares/proxy'
import type { Logger } from './logger'
import type { HttpServer } from './server'

export interface CommonServerOptions {
  /**
   * Specify server port. Note if the port is already being used, Vite will
   * automatically try the next available port so this may not be the actual
   * port the server ends up listening on.
   */
  port?: number
  /**
   * If enabled, vite will exit if specified port is already in use
   */
  strictPort?: boolean
  /**
   * Specify which IP addresses the server should listen on.
   * Set to 0.0.0.0 to listen on all addresses, including LAN and public addresses.
   */
  host?: string | boolean
  /**
   * Enable TLS + HTTP/2.
   * Note: this downgrades to TLS only when the proxy option is also used.
   */
  https?: HttpsServerOptions
  /**
   * Open browser window on startup
   */
  open?: boolean | string
  /**
   * Configure custom proxy rules for the dev server. Expects an object
   * of `{ key: options }` pairs.
   * Uses [`http-proxy`](https://github.com/http-party/node-http-proxy).
   * Full options [here](https://github.com/http-party/node-http-proxy#options).
   *
   * Example `vite.config.js`:
   * ``` js
   * module.exports = {
   *   proxy: {
   *     // string shorthand
   *     '/foo': 'http://localhost:4567/foo',
   *     // with options
   *     '/api': {
   *       target: 'http://jsonplaceholder.typicode.com',
   *       changeOrigin: true,
   *       rewrite: path => path.replace(/^\/api/, '')
   *     }
   *   }
   * }
   * ```
   */
  proxy?: Record<string, string | ProxyOptions>
  /**
   * Configure CORS for the dev server.
   * Uses https://github.com/expressjs/cors.
   * Set to `true` to allow all methods from any origin, or configure separately
   * using an object.
   */
  cors?: CorsOptions | boolean
  /**
   * Specify server response headers.
   */
  headers?: HttpServerHeaders
}

/**
 * https://github.com/expressjs/cors#configuration-options
 */
export interface CorsOptions {
  origin?:
    | CorsOrigin
    | ((origin: string, cb: (err: Error, origins: CorsOrigin) => void) => void)
  methods?: string | string[]
  allowedHeaders?: string | string[]
  exposedHeaders?: string | string[]
  credentials?: boolean
  maxAge?: number
  preflightContinue?: boolean
  optionsSuccessStatus?: number
}

export type CorsOrigin = boolean | string | RegExp | (string | RegExp)[]

/**
 * 它用于根据配置参数创建并返回一个 HTTP 服务器实例。服务器的类型和配置将依据是否启用了 HTTPS 和代理选项来决定
 * @param proxy 从 CommonServerOptions 中解构出 proxy 属性。proxy 决定是否启用代理支持
 * @param app 一个 Connect.Server 实例，它包含了需要在服务器上运行的中间件
 * @param httpsOptions 可选的 HTTPS 配置，用于创建安全的 HTTPS 服务器
 */
export async function resolveHttpServer(
  { proxy }: CommonServerOptions,
  app: Connect.Server,
  httpsOptions?: HttpsServerOptions,
): Promise<HttpServer> {
  if (!httpsOptions) {
    // 如果没有 httpsOptions，则创建一个普通的 HTTP 服务器
    // import('node:http') 动态导入 Node.js 的 HTTP 模块
    const { createServer } = await import('node:http')
    // createServer(app) 使用传入的 app（Connect.Server）创建一个 HTTP 服务器并返回
    return createServer(app)
  }

  // #484 fallback to http1 when proxy is needed.
  // 如果启用了 proxy 选项且提供了 httpsOptions
  if (proxy) {
    // 如果 proxy 为 true，且提供了 httpsOptions，则创建一个 HTTPS 服务器
    const { createServer } = await import('node:https')
    return createServer(httpsOptions, app)
  } else {
    // 如果未启用代理，并且提供了 httpsOptions（即正常的 HTTPS 配置）
    const { createSecureServer } = await import('node:http2')
    return createSecureServer(
      {
        // Manually increase the session memory to prevent 502 ENHANCE_YOUR_CALM
        // errors on large numbers of requests
        maxSessionMemory: 1000, // 手动增加 HTTP/2 会话的内存，避免因大量请求导致的 502 ENHANCE_YOUR_CALM 错误
        ...httpsOptions,
        allowHTTP1: true, // 允许 HTTP/1 请求
      },
      // @ts-expect-error TODO: is this correct?
      app,
    )
  }
}

/**
 * 用于解析和返回 HTTPS 配置。它的作用是根据传入的 HttpsServerOptions 配置对象，
 * 读取相应的证书文件并将它们加入到配置中。如果配置中有证书文件路径，它会异步读取这些文件内容并返回合并后的 HTTPS 配置
 * @param https
 */
export async function resolveHttpsConfig(
  https: HttpsServerOptions | undefined,
): Promise<HttpsServerOptions | undefined> {
  // 如果 https 参数为 undefined，直接返回 undefined。表示没有需要解析的配置
  if (!https) return undefined

  // Promise.all 用来并发地读取多个文件。传入的文件路径是来自 https 配置对象的属性：ca、cert、key 和 pfx。
  // ca 是证书颁发机构的证书。
  // cert 是服务器的证书文件。
  // key 是服务器的私钥。
  // pfx 是 PFX 格式的证书文件。
  // readFileIfExists 是一个异步函数（假设其功能是检查文件是否存在，并返回文件内容），用于读取每个证书文件。如果文件不存在，可能返回 undefined
  const [ca, cert, key, pfx] = await Promise.all([
    readFileIfExists(https.ca),
    readFileIfExists(https.cert),
    readFileIfExists(https.key),
    readFileIfExists(https.pfx),
  ])
  return { ...https, ca, cert, key, pfx }
}

async function readFileIfExists(value?: string | Buffer | any[]) {
  if (typeof value === 'string') {
    return fsp.readFile(path.resolve(value)).catch(() => value)
  }
  return value
}

/**
 * 用于启动一个 HTTP 服务器，并处理端口冲突的情况
 * @param httpServer 一个 HttpServer 实例，表示要启动的服务器
 * @param serverOptions 包含了服务器配置的对象
 */
export async function httpServerStart(
  httpServer: HttpServer,
  serverOptions: {
    port: number // 服务器监听的端口号
    strictPort: boolean | undefined // 一个布尔值，表示是否严格使用指定的端口。如果端口被占用，strictPort 为 true 时会直接报错；如果为 false，则会尝试下一个端口
    host: string | undefined // 服务器绑定的主机名，通常是 localhost 或者具体的 IP 地址
    logger: Logger // 日志记录器，用于记录错误和信息
  },
): Promise<number> {
  let { port, strictPort, host, logger } = serverOptions

  return new Promise((resolve, reject) => {
    const onError = (e: Error & { code?: string }) => {
      if (e.code === 'EADDRINUSE') {
        if (strictPort) {
          httpServer.removeListener('error', onError)
          reject(new Error(`Port ${port} is already in use`))
        } else {
          logger.info(`Port ${port} is in use, trying another one...`)
          httpServer.listen(++port, host)
        }
      } else {
        httpServer.removeListener('error', onError)
        reject(e)
      }
    }

    // 通过监听 error 事件来捕获端口冲突（EADDRINUSE 错误码）或其他错误
    httpServer.on('error', onError)

    // 如果没有发生冲突，服务器会在成功启动后移除错误监听器，并调用 resolve 以返回启动的端口
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', onError)
      resolve(port)
    })
  })
}

/**
 * 用于为 HTTP 服务器设置客户端错误处理逻辑。当服务器收到客户端请求时，如果发生错误，会根据不同的错误类型发送相应的响应，并记录警告日志
 * @param server HTTP 服务器对象（HttpServer 类型）
 * @param logger 日志记录器，用于输出警告信息
 */
export function setClientErrorHandler(
  server: HttpServer,
  logger: Logger,
): void {
  // 通过 server.on('clientError', ...) 监听客户端错误事件
  // 当服务器接收到客户端请求时，如果发生错误（如请求头太大等），就会触发这个事件
  server.on('clientError', (err, socket) => {
    let msg = '400 Bad Request'
    if ((err as any).code === 'HPE_HEADER_OVERFLOW') {
      msg = '431 Request Header Fields Too Large'
      logger.warn(
        colors.yellow(
          'Server responded with status code 431. ' +
            'See https://vitejs.dev/guide/troubleshooting.html#_431-request-header-fields-too-large.',
        ),
      )
    }
    if ((err as any).code === 'ECONNRESET' || !socket.writable) {
      return
    }
    socket.end(`HTTP/1.1 ${msg}\r\n\r\n`)
  })
}
