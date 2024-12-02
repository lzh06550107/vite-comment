import path from 'node:path'
import type { IncomingMessage, Server } from 'node:http'
import { STATUS_CODES, createServer as createHttpServer } from 'node:http'
import type { ServerOptions as HttpsServerOptions } from 'node:https'
import { createServer as createHttpsServer } from 'node:https'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import colors from 'picocolors'
import type { WebSocket as WebSocketRaw } from 'ws'
import { WebSocketServer as WebSocketServerRaw_ } from 'ws'
import type { WebSocket as WebSocketTypes } from 'dep-types/ws'
import type { CustomPayload, ErrorPayload, HMRPayload } from 'types/hmrPayload'
import type { InferCustomEventPayload } from 'types/customEvent'
import type { ResolvedConfig } from '..'
import { isObject } from '../utils'
import type { HMRChannel } from './hmr'
import type { HttpServer } from '.'

/* In Bun, the `ws` module is overridden to hook into the native code. Using the bundled `js` version
 * of `ws` will not work as Bun's req.socket does not allow reading/writing to the underlying socket.
 */
const WebSocketServerRaw = process.versions.bun
  ? // @ts-expect-error: Bun defines `import.meta.require`
    import.meta.require('ws').WebSocketServer
  : WebSocketServerRaw_

export const HMR_HEADER = 'vite-hmr'

export type WebSocketCustomListener<T> = (
  data: T,
  client: WebSocketClient,
) => void

export interface WebSocketServer extends HMRChannel {
  /**
   * Listen on port and host
   */
  listen(): void
  /**
   * Get all connected clients.
   */
  clients: Set<WebSocketClient>
  /**
   * Disconnect all clients and terminate the server.
   */
  close(): Promise<void>
  /**
   * Handle custom event emitted by `import.meta.hot.send`
   */
  on: WebSocketTypes.Server['on'] & {
    <T extends string>(
      event: T,
      listener: WebSocketCustomListener<InferCustomEventPayload<T>>,
    ): void
  }
  /**
   * Unregister event listener.
   */
  off: WebSocketTypes.Server['off'] & {
    (event: string, listener: Function): void
  }
}

export interface WebSocketClient {
  /**
   * Send event to the client
   */
  send(payload: HMRPayload): void
  /**
   * Send custom event
   */
  send(event: string, payload?: CustomPayload['data']): void
  /**
   * The raw WebSocket instance
   * @advanced
   */
  socket: WebSocketTypes
}

const wsServerEvents = [
  'connection',
  'error',
  'headers',
  'listening',
  'message',
]

/**
 * 用于在 Vite 开发服务器中创建 WebSocket 服务器，支持与客户端进行实时通信，特别是在启用了热模块替换（HMR）功能时。
 * 这个 WebSocket 服务器用于处理连接、消息发送、客户端事件的处理等任务
 * @param server 关联的 HTTP 服务器。如果没有提供，将会创建一个新的服务器
 * @param config 解析后的配置对象
 * @param httpsOptions 可选的 HTTPS 配置，用于加密 WebSocket 连接
 */
export function createWebSocketServer(
  server: HttpServer | null,
  config: ResolvedConfig,
  httpsOptions?: HttpsServerOptions,
): WebSocketServer {
  let wss: WebSocketServerRaw_
  let wsHttpServer: Server | undefined = undefined

  // 函数首先检查配置中是否启用了 HMR。如果启用了 HMR，则会设置 WebSocket 服务器来处理 HMR 连接，并根据配置的端口和路径来处理 WebSocket 升级请求。
  // 如果没有启用 HMR，则会创建一个默认的 WebSocket 服务器，并提供一个备用的 HTTP 路由。
  const hmr = isObject(config.server.hmr) && config.server.hmr
  const hmrServer = hmr && hmr.server
  const hmrPort = hmr && hmr.port
  // TODO: the main server port may not have been chosen yet as it may use the next available
  const portsAreCompatible = !hmrPort || hmrPort === config.server.port
  const wsServer = hmrServer || (portsAreCompatible && server)
  let hmrServerWsListener: (
    req: InstanceType<typeof IncomingMessage>,
    socket: Duplex,
    head: Buffer,
  ) => void
  const customListeners = new Map<string, Set<WebSocketCustomListener<any>>>() // 存储自定义事件监听器的映射
  const clientsMap = new WeakMap<WebSocketRaw, WebSocketClient>()
  const port = hmrPort || 24678
  const host = (hmr && hmr.host) || undefined

  if (wsServer) {
    let hmrBase = config.base
    // HMR WebSocket 连接的路径
    const hmrPath = hmr ? hmr.path : undefined
    if (hmrPath) {
      hmrBase = path.posix.join(hmrBase, hmrPath)
    }
    // 使用 WebSocketServerRaw 类创建 WebSocket 服务器。根据是否启用了 HMR，处理 WebSocket 连接的升级请求
    wss = new WebSocketServerRaw({ noServer: true })
    hmrServerWsListener = (req, socket, head) => {
      if (
        req.headers['sec-websocket-protocol'] === HMR_HEADER &&
        req.url === hmrBase
      ) {
        wss.handleUpgrade(req, socket as Socket, head, (ws) => {
          wss.emit('connection', ws, req)
        })
      }
    }
    wsServer.on('upgrade', hmrServerWsListener) // 处理 WebSocket 连接的升级请求
  } else { // 如果没有启用 HMR，则会创建一个默认的 WebSocket 服务器，并提供一个备用的 HTTP 路由
    // http server request handler keeps the same with
    // https://github.com/websockets/ws/blob/45e17acea791d865df6b255a55182e9c42e5877a/lib/websocket-server.js#L88-L96
    const route = ((_, res) => {
      const statusCode = 426
      const body = STATUS_CODES[statusCode]
      if (!body)
        throw new Error(`No body text found for the ${statusCode} status code`)

      res.writeHead(statusCode, {
        'Content-Length': body.length,
        'Content-Type': 'text/plain',
      })
      res.end(body)
    }) as Parameters<typeof createHttpServer>[1]
    if (httpsOptions) {
      wsHttpServer = createHttpsServer(httpsOptions, route)
    } else {
      wsHttpServer = createHttpServer(route)
    }
    // vite dev server in middleware mode
    // need to call ws listen manually
    wss = new WebSocketServerRaw({ server: wsHttpServer })
  }

  // 处理 WebSocket 连接
  // 当有 WebSocket 连接建立时，服务器会监听客户端的消息。如果消息是一个自定义事件（例如 HMR 事件），则会触发相应的监听器
  wss.on('connection', (socket) => {
    // 处理从客户端发送的消息。如果消息是一个自定义事件，就会触发相应的监听器
    socket.on('message', (raw) => {
      if (!customListeners.size) return
      let parsed: any
      try {
        parsed = JSON.parse(String(raw))
      } catch {}
      if (!parsed || parsed.type !== 'custom' || !parsed.event) return
      const listeners = customListeners.get(parsed.event)
      if (!listeners?.size) return
      const client = getSocketClient(socket)
      listeners.forEach((listener) => listener(parsed.data, client))
    })
    // 处理 WebSocket 错误并记录日志
    socket.on('error', (err) => {
      config.logger.error(`${colors.red(`ws error:`)}\n${err.stack}`, {
        timestamp: true,
        error: err,
      })
    })
    // 当客户端连接时，服务器向客户端发送连接成功的消息
    socket.send(JSON.stringify({ type: 'connected' }))
    if (bufferedError) {
      socket.send(JSON.stringify(bufferedError))
      bufferedError = null
    }
  })

  wss.on('error', (e: Error & { code: string }) => {
    if (e.code === 'EADDRINUSE') {
      config.logger.error(
        colors.red(`WebSocket server error: Port is already in use`),
        { error: e },
      )
    } else {
      config.logger.error(
        colors.red(`WebSocket server error:\n${e.stack || e.message}`),
        { error: e },
      )
    }
  })

  // Provide a wrapper to the ws client so we can send messages in JSON format
  // To be consistent with server.ws.send 包装 WebSocket 客户端，允许它发送 JSON 格式的消息
  function getSocketClient(socket: WebSocketRaw) {
    if (!clientsMap.has(socket)) {
      clientsMap.set(socket, {
        send: (...args) => {
          let payload: HMRPayload
          if (typeof args[0] === 'string') {
            payload = {
              type: 'custom',
              event: args[0],
              data: args[1],
            }
          } else {
            payload = args[0]
          }
          // 发送消息到所有连接的客户端。如果消息是错误信息并且尚未有客户端连接，消息将会被缓冲，直到有客户端连接时再发送
          socket.send(JSON.stringify(payload))
        },
        socket,
      })
    }
    return clientsMap.get(socket)!
  }

  // On page reloads, if a file fails to compile and returns 500, the server
  // sends the error payload before the client connection is established.
  // If we have no open clients, buffer the error and send it to the next
  // connected client.
  let bufferedError: ErrorPayload | null = null

  return {
    name: 'ws',
    listen: () => { // 启动 WebSocket 服务器，监听指定端口
      wsHttpServer?.listen(port, host)
    },
    on: ((event: string, fn: () => void) => { // 注册事件监听器
      if (wsServerEvents.includes(event)) wss.on(event, fn)
      else {
        if (!customListeners.has(event)) {
          customListeners.set(event, new Set())
        }
        customListeners.get(event)!.add(fn)
      }
    }) as WebSocketServer['on'],
    off: ((event: string, fn: () => void) => { // 移除事件监听器
      if (wsServerEvents.includes(event)) {
        wss.off(event, fn)
      } else {
        customListeners.get(event)?.delete(fn)
      }
    }) as WebSocketServer['off'],

    get clients() { // 获取所有连接的 WebSocket 客户端
      return new Set(Array.from(wss.clients).map(getSocketClient))
    },

    send(...args: any[]) { // 向所有连接的客户端发送消息
      let payload: HMRPayload
      if (typeof args[0] === 'string') {
        payload = {
          type: 'custom',
          event: args[0],
          data: args[1],
        }
      } else {
        payload = args[0]
      }

      if (payload.type === 'error' && !wss.clients.size) {
        bufferedError = payload
        return
      }

      const stringified = JSON.stringify(payload)
      wss.clients.forEach((client) => {
        // readyState 1 means the connection is open
        if (client.readyState === 1) {
          client.send(stringified)
        }
      })
    },

    close() { // 关闭 WebSocket 服务器，并终止所有连接的客户端
      // should remove listener if hmr.server is set
      // otherwise the old listener swallows all WebSocket connections
      if (hmrServerWsListener && wsServer) {
        wsServer.off('upgrade', hmrServerWsListener)
      }
      return new Promise((resolve, reject) => {
        wss.clients.forEach((client) => {
          client.terminate()
        })
        wss.close((err) => {
          if (err) {
            reject(err)
          } else {
            if (wsHttpServer) {
              wsHttpServer.close((err) => {
                if (err) {
                  reject(err)
                } else {
                  resolve()
                }
              })
            } else {
              resolve()
            }
          }
        })
      })
    },
  }
}
