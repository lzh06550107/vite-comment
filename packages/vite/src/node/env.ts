import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'dotenv'
import { type DotenvPopulateInput, expand } from 'dotenv-expand'
import { arraify, normalizePath, tryStatSync } from './utils'
import type { UserConfig } from './config'

/**
 * 根据给定的环境模式（mode）和环境变量文件所在的目录（envDir），生成一组可能的 .env 配置文件路径。
 * 这些路径包括默认的 .env 文件、局部配置文件（如 .env.local）、以及基于不同环境模式的配置文件（如 .env.production、.env.production.local）
 * @param mode
 * @param envDir
 */
export function getEnvFilesForMode(mode: string, envDir: string): string[] {
  return [
    /** default file */ `.env`, // 默认文件：.env，这是通用的配置文件
    /** local file */ `.env.local`, // 本地文件：.env.local，通常用于本地开发时的配置，优先级高于 .env 文件
    /** mode file */ `.env.${mode}`, // 模式文件：.env.${mode}，这是与当前运行模式（mode）相关的文件，通常用于环境区分，例如 .env.production 或 .env.development
    /** mode local file */ `.env.${mode}.local`, // 模式本地文件：.env.${mode}.local，这是与特定模式相关的本地配置文件，例如 .env.production.local
  ].map((file) => normalizePath(path.join(envDir, file)))
  // 该函数返回一个数组，数组中的每个元素是一个文件路径，所有这些文件路径都指向 envDir 目录下的 .env 配置文件。
  // 这些路径被 normalizePath 处理以确保平台一致性，并且通过 path.join 拼接生成完整的文件路径
}

/**
 * 这个函数的主要作用是加载和处理指定模式下的 .env 配置文件，解析其中的环境变量，并根据前缀筛选出需要暴露给客户端的变量
 * @param mode 环境模式，例如 "development", "production" 等
 * @param envDir 环境变量文件所在的目录路径
 * @param prefixes 环境变量的前缀，默认为 'VITE_'。可以是字符串或字符串数组
 */
export function loadEnv(
  mode: string,
  envDir: string,
  prefixes: string | string[] = 'VITE_',
): Record<string, string> {
  if (mode === 'local') {
    throw new Error(
      `"local" cannot be used as a mode name because it conflicts with ` +
        `the .local postfix for .env files.`,
    )
  }
  prefixes = arraify(prefixes)
  const env: Record<string, string> = {}
  // 获取当前模式下的 .env 文件，并解析其中的环境变量
  const envFiles = getEnvFilesForMode(mode, envDir)

  // 在解析的环境变量中检查并处理 NODE_ENV、BROWSER 和 BROWSER_ARGS 等特定的环境变量，并根据需要设置 process.env 中的对应值
  const parsed = Object.fromEntries(
    envFiles.flatMap((filePath) => {
      if (!tryStatSync(filePath)?.isFile()) return []

      return Object.entries(parse(fs.readFileSync(filePath)))
    }),
  )

  // test NODE_ENV override before expand as otherwise process.env.NODE_ENV would override this
  if (parsed.NODE_ENV && process.env.VITE_USER_NODE_ENV === undefined) {
    process.env.VITE_USER_NODE_ENV = parsed.NODE_ENV
  }
  // support BROWSER and BROWSER_ARGS env variables
  if (parsed.BROWSER && process.env.BROWSER === undefined) {
    process.env.BROWSER = parsed.BROWSER
  }
  if (parsed.BROWSER_ARGS && process.env.BROWSER_ARGS === undefined) {
    process.env.BROWSER_ARGS = parsed.BROWSER_ARGS
  }

  // let environment variables use each other. make a copy of `process.env` so that `dotenv-expand`
  // doesn't re-assign the expanded values to the global `process.env`.
  // 使用 dotenv-expand 来扩展环境变量，使其能够引用其他环境变量（例如：$VITE_API_URL）
  const processEnv = { ...process.env } as DotenvPopulateInput
  expand({ parsed, processEnv })

  // only keys that start with prefix are exposed to client
  // 只保留那些以指定的前缀（prefixes）开头的环境变量，这些变量将暴露给客户端
  for (const [key, value] of Object.entries(parsed)) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      env[key] = value
    }
  }

  // check if there are actual env variables starting with VITE_*
  // these are typically provided inline and should be prioritized
  // 最后，再次检查 process.env，如果有任何以 prefixes 开头的环境变量，它们会被加入到最终返回的对象中
  for (const key in process.env) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      env[key] = process.env[key] as string
    }
  }

  return env
}

/**
 * 该函数确保环境变量的前缀在配置中正确且安全
 * @param envPrefix
 */
export function resolveEnvPrefix({
  envPrefix = 'VITE_',
}: UserConfig): string[] {
  envPrefix = arraify(envPrefix)
  if (envPrefix.includes('')) {
    throw new Error(
      `envPrefix option contains value '', which could lead unexpected exposure of sensitive information.`,
    )
  }
  return envPrefix
}
