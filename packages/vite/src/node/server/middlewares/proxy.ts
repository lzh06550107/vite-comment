import type * as http from 'node:http'
import type * as net from 'node:net'
import httpProxy from 'http-proxy'
import type { Connect } from 'dep-types/connect'
import type { HttpProxy } from 'dep-types/http-proxy'
import colors from 'picocolors'
import { createDebugger } from '../../utils'
import type { CommonServerOptions, ResolvedConfig } from '../..'
import type { HttpServer } from '..'

const debug = createDebugger('vite:proxy')

export interface ProxyOptions extends HttpProxy.ServerOptions {
  /**
   * rewrite path
   */
  rewrite?: (path: string) => string
  /**
   * configure the proxy server (e.g. listen to events)
   */
  configure?: (proxy: HttpProxy.Server, options: ProxyOptions) => void
  /**
   * webpack-dev-server style bypass function
   */
  bypass?: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options: ProxyOptions,
  ) => void | null | undefined | false | string
}

/**
 * 用于为 Vite 服务器设置代理功能。它通过 http-proxy 库将请求转发到指定的目标服务器，支持 WebSocket 代理和 HTTP 请求代理。
 *
 * 主要功能：
 * 1. 创建代理服务器：代码通过 http-proxy.createProxyServer 为每个代理配置创建一个代理服务器。每个代理配置可以包括目标地址、rewrite 规则、bypass 函数等。
 * 2. 代理错误处理：代码监听代理事件 error，如果代理出现错误（如连接失败、响应超时等），它会记录错误日志并进行适当的处理，保证代理服务器稳定性。
 * 3. WebSocket 代理：如果请求是 WebSocket 连接（ws 或 wss），则会通过 proxy.ws() 方法转发 WebSocket 请求。
 * 4. 代理请求的拦截和重写：在处理每个请求时，首先检查请求的 URL 是否符合某个代理上下文的匹配规则。若匹配成功，可以对请求进行 URL 重写、绕过处理等操作，然后将请求通过代理转发到目标服务器。
 * @param httpServer
 * @param options
 * @param config
 */
export function proxyMiddleware(
  httpServer: HttpServer | null,
  options: NonNullable<CommonServerOptions['proxy']>,
  config: ResolvedConfig,
): Connect.NextHandleFunction {
  // lazy require only when proxy is used
  const proxies: Record<string, [HttpProxy.Server, ProxyOptions]> = {}

  // 遍历 options 对象中的每个代理配置，每个代理配置的 context 是一个 URL 路径的上下文，例如 /api，opts 则是配置对象。
  Object.keys(options).forEach((context) => {
    let opts = options[context]
    if (!opts) {
      return
    }
    // 如果 opts 是一个字符串，则将其转为包含 target 和 changeOrigin 的对象。
    if (typeof opts === 'string') {
      opts = { target: opts, changeOrigin: true } as ProxyOptions
    }
    const proxy = httpProxy.createProxyServer(opts) as HttpProxy.Server

    if (opts.configure) {
      opts.configure(proxy, opts)
    }

    // 这里的 proxy.on('error', ...) 事件监听器用于捕获代理请求中的错误。
    // 如果代理过程中发生错误，它会记录错误日志，并对不同类型的响应对象（HTTP 响应、WebSocket、等）进行不同的错误处理
    proxy.on('error', (err, req, originalRes) => {
      // When it is ws proxy, res is net.Socket
      // originalRes can be falsy if the proxy itself errored
      const res = originalRes as http.ServerResponse | net.Socket | undefined
      if (!res) {
        config.logger.error(
          `${colors.red(`http proxy error: ${err.message}`)}\n${err.stack}`,
          {
            timestamp: true,
            error: err,
          },
        )
      } else if ('req' in res) {
        config.logger.error(
          `${colors.red(`http proxy error: ${originalRes.req.url}`)}\n${
            err.stack
          }`,
          {
            timestamp: true,
            error: err,
          },
        )
        if (!res.headersSent && !res.writableEnded) {
          res
            .writeHead(500, {
              'Content-Type': 'text/plain',
            })
            .end()
        }
      } else {
        config.logger.error(`${colors.red(`ws proxy error:`)}\n${err.stack}`, {
          timestamp: true,
          error: err,
        })
        res.end()
      }
    })

    // WebSocket 代理
    proxy.on('proxyReqWs', (proxyReq, req, socket, options, head) => {
      socket.on('error', (err) => {
        config.logger.error(
          `${colors.red(`ws proxy socket error:`)}\n${err.stack}`,
          {
            timestamp: true,
            error: err,
          },
        )
      })
    })

    // https://github.com/http-party/node-http-proxy/issues/1520#issue-877626125
    // https://github.com/chimurai/http-proxy-middleware/blob/cd58f962aec22c925b7df5140502978da8f87d5f/src/plugins/default/debug-proxy-errors-plugin.ts#L25-L37
    proxy.on('proxyRes', (proxyRes, req, res) => {
      res.on('close', () => {
        if (!res.writableEnded) {
          debug?.('destroying proxyRes in proxyRes close event')
          proxyRes.destroy()
        }
      })
    })

    // clone before saving because http-proxy mutates the options
    proxies[context] = [proxy, { ...opts }]
  })

  // 监听 upgrade 事件，处理 WebSocket 升级请求。
  // 如果请求的目标 URL 匹配某个代理上下文，并且该代理配置支持 WebSocket（ws 或 wss），则会通过 proxy.ws() 方法将 WebSocket 请求转发到目标服务器
  if (httpServer) {
    httpServer.on('upgrade', (req, socket, head) => {
      const url = req.url!
      for (const context in proxies) {
        if (doesProxyContextMatchUrl(context, url)) {
          const [proxy, opts] = proxies[context]
          if (
            opts.ws ||
            opts.target?.toString().startsWith('ws:') ||
            opts.target?.toString().startsWith('wss:')
          ) {
            if (opts.rewrite) {
              req.url = opts.rewrite(url)
            }
            debug?.(`${req.url} -> ws ${opts.target}`)
            proxy.ws(req, socket, head)
            return
          }
        }
      }
    })
  }

  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function viteProxyMiddleware(req, res, next) {
    const url = req.url!
    for (const context in proxies) {
      // 根据请求的 URL 匹配相应的代理上下文
      if (doesProxyContextMatchUrl(context, url)) {
        const [proxy, opts] = proxies[context]
        const options: HttpProxy.ServerOptions = {}

        // 绕过逻辑：如果 opts.bypass 函数存在并返回了 false 或一个字符串，代理会跳过当前请求，返回 404 错误或按照返回的 URL 重写请求
        if (opts.bypass) {
          const bypassResult = opts.bypass(req, res, opts)
          if (typeof bypassResult === 'string') {
            req.url = bypassResult
            debug?.(`bypass: ${req.url} -> ${bypassResult}`)
            return next()
          } else if (bypassResult === false) {
            debug?.(`bypass: ${req.url} -> 404`)
            res.statusCode = 404
            return res.end()
          }
        }

        debug?.(`${req.url} -> ${opts.target || opts.forward}`)
        // URL 重写：如果配置了 rewrite 函数，代理会重写请求 URL
        if (opts.rewrite) {
          req.url = opts.rewrite(req.url!)
        }
        // 最后，调用 proxy.web() 将请求通过代理转发到目标服务器
        proxy.web(req, res, options)
        return
      }
    }
    next()
  }
}

/**
 * 用于判断请求的 URL 是否匹配指定的代理上下文（context）。它的作用是根据不同的匹配规则来判断是否将某个请求转发到代理目标
 * @param context
 * @param url
 */
function doesProxyContextMatchUrl(context: string, url: string): boolean {
  return (
    // 如果 context 以 ^ 字符开头，表示该 context 是一个正则表达式，
    // 函数会使用 new RegExp(context) 创建正则表达式，并用 test 方法判断 url 是否匹配该正则表达式
    (context[0] === '^' && new RegExp(context).test(url)) ||
    url.startsWith(context) // 以 context 开头的字符串匹配
  )
}
