import type {
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from 'node:http'
import path from 'node:path'
import convertSourceMap from 'convert-source-map'
import getEtag from 'etag'
import type { SourceMap } from 'rollup'
import MagicString from 'magic-string'
import { createDebugger, removeTimestampQuery } from '../utils'
import { getCodeWithSourcemap } from './sourcemap'

// 这段代码定义了一个名为 send 的函数，它用于处理 HTTP 响应，发送内容（如 JavaScript、CSS 或 JSON），并支持 ETag、缓存控制、源映射（source maps）等功能。
// 这个 send 函数通常用于构建工具或开发服务器中，在客户端请求资源时，提供支持源映射、缓存管理和正确的响应头设置等功能。它可以处理静态资源（如 JS、CSS、HTML 文件）并进行优化，提高开发体验和性能

const debug = createDebugger('vite:send', {
  onlyWhenFocused: true,
})

// 这是一个映射表，用于根据文件类型推断内容的 MIME 类型
const alias: Record<string, string | undefined> = {
  js: 'text/javascript',
  css: 'text/css',
  html: 'text/html',
  json: 'application/json',
}

export interface SendOptions {
  etag?: string
  cacheControl?: string
  headers?: OutgoingHttpHeaders
  map?: SourceMap | { mappings: '' } | null
}

/**
 * 根据请求和选项，发送响应给客户端
 * @param req HTTP 请求对象
 * @param res HTTP 响应对象
 * @param content 要发送的内容，可以是字符串（如 HTML）或缓冲区（如二进制数据）
 * @param type 内容类型（如 'js', 'css', 'html'）
 * @param options 一个可选的配置对象，包含以下字段
 */
export function send(
  req: IncomingMessage,
  res: ServerResponse,
  content: string | Buffer,
  type: string,
  options: SendOptions,
): void {
  const {
    etag = getEtag(content, { weak: true }), // ETag 值（如果未提供，则自动生成）
    cacheControl = 'no-cache', // 缓存控制策略（默认为 'no-cache'）
    headers, // 要添加到响应头中的其他自定义头信息
    map, // 可选的源映射对象（如果需要注入源映射）
  } = options

  if (res.writableEnded) {
    return
  }

  // 如果请求中包含与当前内容 ETag 相同的值（即缓存未被修改），则响应 HTTP 304（未修改），并直接结束响应
  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304
    res.end()
    return
  }

  // 响应头设置
  res.setHeader('Content-Type', alias[type] || type)
  res.setHeader('Cache-Control', cacheControl)
  res.setHeader('Etag', etag)

  if (headers) {
    for (const name in headers) {
      res.setHeader(name, headers[name]!)
    }
  }

  // inject source map reference
  // 如果提供了源映射（map），并且 type 为 js 或 css，则将源映射注入到代码中。这是通过调用 getCodeWithSourcemap 函数来实现的，getCodeWithSourcemap 可能会将源映射注入到代码的末尾，或者以其他方式处理
  if (map && 'version' in map && map.mappings) {
    if (type === 'js' || type === 'css') {
      content = getCodeWithSourcemap(type, content.toString(), map)
    }
  }
  // inject fallback sourcemap for js for improved debugging
  // https://github.com/vitejs/vite/pull/13514#issuecomment-1592431496
    // JavaScript 源映射的回退处理：如果是 js 文件，并且没有提供源映射（或者源映射为空字符串），则尝试生成一个回退的源映射。在生成源映射时，代码检查是否已经包含了内联源映射（使用 convertSourceMap.mapFileCommentRegex 来检测），如果已包含则跳过回退源映射的注入。
  else if (type === 'js' && (!map || map.mappings !== '')) {
    const code = content.toString()
    // if the code has existing inline sourcemap, assume it's correct and skip
    if (convertSourceMap.mapFileCommentRegex.test(code)) {
      debug?.(`Skipped injecting fallback sourcemap for ${req.url}`)
    } else {
      const urlWithoutTimestamp = removeTimestampQuery(req.url!)
      // MagicString：这是一个用于处理源代码的库，可以轻松地编辑 JavaScript 或其他代码，并生成源映射。它的 generateMap 方法用于生成新的源映射
      const ms = new MagicString(code)
      content = getCodeWithSourcemap(
        type,
        code,
        ms.generateMap({
          source: path.basename(urlWithoutTimestamp),
          hires: 'boundary',
          includeContent: true,
        }),
      )
    }
  }

  res.statusCode = 200
  res.end(content)
  return
}
