import fs from 'node:fs'
import path from 'node:path'
import { cleanUrl, withTrailingSlash } from '../shared/utils'
import type { ResolvedConfig } from './config'
import {
  ERR_SYMLINK_IN_RECURSIVE_READDIR,
  normalizePath,
  recursiveReaddir,
} from './utils'

const publicFilesMap = new WeakMap<ResolvedConfig, Set<string>>()

/**
 * 定义了一个异步函数 initPublicFiles，用于初始化和返回 Vite 配置中 publicDir 目录下的文件列表，并以 Set 数据结构进行存储。接下来我们详细分析这段代码的功能
 * @param config
 */
export async function initPublicFiles(
  config: ResolvedConfig,
): Promise<Set<string> | undefined> {
  let fileNames: string[]
  try {
    // 递归地读取 publicDir 目录中的所有文件并返回文件路径数组。config.publicDir 是 Vite 配置对象中指定的公共目录路径
    fileNames = await recursiveReaddir(config.publicDir)
  } catch (e) {
    // 如果在读取过程中遇到符号链接问题（ERR_SYMLINK_IN_RECURSIVE_READDIR），函数会捕获并直接返回 undefined，避免进一步处理
    if (e.code === ERR_SYMLINK_IN_RECURSIVE_READDIR) {
      return
    }
    throw e
  }
  const publicFiles = new Set(
    // 使用 fileName.slice(config.publicDir.length) 去除路径中的 publicDir 部分，只保留相对于 publicDir 的路径部分
    // 通过 map 方法处理每个文件路径，最终生成一个 Set 对象 publicFiles，用于去重和存储公共目录下的所有文件
    fileNames.map((fileName) => fileName.slice(config.publicDir.length)),
  )
  publicFilesMap.set(config, publicFiles)
  return publicFiles
}

function getPublicFiles(config: ResolvedConfig): Set<string> | undefined {
  return publicFilesMap.get(config)
}

export function checkPublicFile(
  url: string,
  config: ResolvedConfig,
): string | undefined {
  // note if the file is in /public, the resolver would have returned it
  // as-is so it's not going to be a fully resolved path.
  const { publicDir } = config
  if (!publicDir || url[0] !== '/') {
    return
  }

  const fileName = cleanUrl(url)

  // short-circuit if we have an in-memory publicFiles cache
  const publicFiles = getPublicFiles(config)
  if (publicFiles) {
    return publicFiles.has(fileName)
      ? normalizePath(path.join(publicDir, fileName))
      : undefined
  }

  const publicFile = normalizePath(path.join(publicDir, fileName))
  if (!publicFile.startsWith(withTrailingSlash(publicDir))) {
    // can happen if URL starts with '../'
    return
  }

  return fs.existsSync(publicFile) ? publicFile : undefined
}
