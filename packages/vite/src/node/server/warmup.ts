import fs from 'node:fs/promises'
import path from 'node:path'
import glob from 'fast-glob'
import colors from 'picocolors'
import { FS_PREFIX } from '../constants'
import { normalizePath } from '../utils'
import type { ViteDevServer } from '../index'

// 这段代码的作用是为 ViteDevServer 提供预热功能，确保服务器在启动时已经加载并转换了指定的文件。这主要通过 warmupFiles 和 warmupFile 函数实现，并支持两种类型的文件预热：clientFiles 和 ssrFiles

// 过 warmupFiles 和 warmupFile 函数实现了对指定文件的预热，帮助提高开发服务器的性能，尤其是在处理 HTML 和其他静态资源时。预热功能有助于加速模块热替换（HMR）和 SSR 渲染，确保开发服务器在启动时已处理好相关的文件

/**
 * 该函数接受一个 ViteDevServer 实例，并根据配置中的 clientFiles 和 ssrFiles 预热相应的文件
 * @param server
 */
export function warmupFiles(server: ViteDevServer): void {
  const options = server.config.server.warmup
  const root = server.config.root

  // 使用 mapFiles 将文件路径转换为绝对路径，之后调用 warmupFile 函数逐个预热这些文件
  if (options?.clientFiles?.length) {
    mapFiles(options.clientFiles, root).then((files) => {
      for (const file of files) {
        warmupFile(server, file, false)
      }
    })
  }
  if (options?.ssrFiles?.length) {
    mapFiles(options.ssrFiles, root).then((files) => {
      for (const file of files) {
        warmupFile(server, file, true)
      }
    })
  }
}

/**
 *
 * @param server
 * @param file
 * @param ssr
 */
async function warmupFile(server: ViteDevServer, file: string, ssr: boolean) {
  // transform html with the `transformIndexHtml` hook as Vite internals would
  // pre-transform the imported JS modules linked. this may cause `transformIndexHtml`
  // plugins to be executed twice, but that's probably fine.
  // 根据文件类型进行不同的处理
  if (file.endsWith('.html')) {
    // HTML 文件：调用 transformIndexHtml 钩子将 HTML 内容转换。转换过程中会先读取 HTML 文件的内容，并调用 transformIndexHtml 进行处理。
    const url = htmlFileToUrl(file, server.config.root)
    if (url) {
      try {
        const html = await fs.readFile(file, 'utf-8')
        await server.transformIndexHtml(url, html)
      } catch (e) {
        // Unexpected error, log the issue but avoid an unhandled exception
        server.config.logger.error(
          `Pre-transform error (${colors.cyan(file)}): ${e.message}`,
          {
            error: e,
            timestamp: true,
          },
        )
      }
    }
  }
  // for other files, pass it through `transformRequest` with warmup
  else { // 其他文件：使用 transformRequest 将文件传给服务器进行处理，同时指定是否为 SSR（服务器端渲染）模式
    const url = fileToUrl(file, server.config.root)
    await server.warmupRequest(url, { ssr })
  }
}

/**
 * 用于将 HTML 文件转换为相对于根目录的 URL
 * @param file
 * @param root
 */
function htmlFileToUrl(file: string, root: string) {
  const url = path.relative(root, file)
  // out of root, ignore file
  if (url[0] === '.') return
  // file within root, create root-relative url
  return '/' + normalizePath(url)
}

/**
 * 用于将其他文件转换为 URL。如果文件位于根目录之外，它会添加 /@fs/ 前缀
 * @param file
 * @param root
 */
function fileToUrl(file: string, root: string) {
  const url = path.relative(root, file)
  // out of root, use /@fs/ prefix
  if (url[0] === '.') {
    return path.posix.join(FS_PREFIX, normalizePath(file))
  }
  // file within root, create root-relative url
  return '/' + normalizePath(url)
}

/**
 * 使用 glob 模块将文件路径模式匹配到实际文件，返回文件的绝对路径
 * @param files
 * @param root
 */
function mapFiles(files: string[], root: string) {
  return glob(files, {
    cwd: root,
    absolute: true,
  })
}
