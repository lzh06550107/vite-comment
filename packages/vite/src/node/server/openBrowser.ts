/**
 * The following is modified based on source found in
 * https://github.com/facebook/create-react-app
 *
 * MIT Licensed
 * Copyright (c) 2015-present, Facebook, Inc.
 * https://github.com/facebook/create-react-app/blob/master/LICENSE
 *
 */

import { join } from 'node:path'
import { exec } from 'node:child_process'
import type { ExecOptions } from 'node:child_process'
import open from 'open'
import spawn from 'cross-spawn'
import colors from 'picocolors'
import type { Logger } from '../logger'
import { VITE_PACKAGE_DIR } from '../constants'

// 这段代码实现了 openBrowser 函数，用于根据 BROWSER 环境变量或提供的选项决定如何打开浏览器。它支持不同的操作系统（如 macOS、Windows），并为特定的浏览器（如 Chromium 系列浏览器）提供了额外的处理。

/**
 * Reads the BROWSER environment variable and decides what to do with it.
 */
export function openBrowser(
  url: string,
  opt: string | true,
  logger: Logger,
): void {
  // The browser executable to open.
  // See https://github.com/sindresorhus/open#app for documentation.
  // 如果 opt 是字符串类型，它会被当作浏览器的可执行文件
  const browser = typeof opt === 'string' ? opt : process.env.BROWSER || ''
  // 如果浏览器指定的是 .js 文件，函数会使用 node 执行这个脚本
  if (browser.toLowerCase().endsWith('.js')) {
    executeNodeScript(browser, url, logger)
  } else if (browser.toLowerCase() !== 'none') { // 如果浏览器被设置为 'none'，则不会打开浏览器
    // 它还会从环境变量 BROWSER_ARGS 中读取自定义的浏览器启动参数
    const browserArgs = process.env.BROWSER_ARGS
      ? process.env.BROWSER_ARGS.split(' ')
      : []
    startBrowserProcess(browser, browserArgs, url)
  }
}

/**
 * 当 BROWSER 环境变量设置为 JavaScript 文件时，执行一个自定义的 Node.js 脚本来打开浏览器
 * @param scriptPath
 * @param url
 * @param logger
 */
function executeNodeScript(scriptPath: string, url: string, logger: Logger) {
  const extraArgs = process.argv.slice(2)
  const child = spawn(process.execPath, [scriptPath, ...extraArgs, url], {
    stdio: 'inherit',
  })
  child.on('close', (code) => {
    if (code !== 0) { // 如果脚本执行失败，它会记录一个错误日志
      logger.error(
        colors.red(
          `\nThe script specified as BROWSER environment variable failed.\n\n${colors.cyan(
            scriptPath,
          )} exited with code ${code}.`,
        ),
        { error: null },
      )
    }
  })
}

const supportedChromiumBrowsers = [
  'Google Chrome Canary',
  'Google Chrome Dev',
  'Google Chrome Beta',
  'Google Chrome',
  'Microsoft Edge',
  'Brave Browser',
  'Vivaldi',
  'Chromium',
]

/**
 * 启动浏览器进程
 * @param browser
 * @param browserArgs
 * @param url
 */
async function startBrowserProcess(
  browser: string | undefined,
  browserArgs: string[],
  url: string,
) {
  // If we're on OS X, the user hasn't specifically
  // requested a different browser, we can try opening
  // a Chromium browser with AppleScript. This lets us reuse an
  // existing tab when possible instead of creating a new one.
  // 如果指定了浏览器，尝试使用 cross-spawn 启动浏览器进程
  const preferredOSXBrowser =
    browser === 'google chrome' ? 'Google Chrome' : browser
  const shouldTryOpenChromeWithAppleScript =
    process.platform === 'darwin' &&
    (!preferredOSXBrowser ||
      supportedChromiumBrowsers.includes(preferredOSXBrowser))

  // 在 macOS 上，如果没有指定浏览器，它会尝试重用现有的 Chromium 浏览器标签页（通过 AppleScript 实现）
  if (shouldTryOpenChromeWithAppleScript) {
    try {
      const ps = await execAsync('ps cax')
      const openedBrowser =
        preferredOSXBrowser && ps.includes(preferredOSXBrowser)
          ? preferredOSXBrowser
          : supportedChromiumBrowsers.find((b) => ps.includes(b))
      if (openedBrowser) {
        // Try our best to reuse existing tab with AppleScript
        await execAsync(
          `osascript openChrome.applescript "${encodeURI(
            url,
          )}" "${openedBrowser}"`,
          {
            cwd: join(VITE_PACKAGE_DIR, 'bin'),
          },
        )
        return true
      }
    } catch (err) {
      // Ignore errors
    }
  }

  // Another special case: on OS X, check if BROWSER has been set to "open".
  // In this case, instead of passing the string `open` to `open` function (which won't work),
  // just ignore it (thus ensuring the intended behavior, i.e. opening the system browser):
  // https://github.com/facebook/create-react-app/pull/1690#issuecomment-283518768
  if (process.platform === 'darwin' && browser === 'open') {
    browser = undefined
  }

  // Fallback to open
  // (It will always open new tab)
  // 如果该方法失败，它会回退到使用 open 模块来打开浏览器
  try {
    const options: open.Options = browser
      ? { app: { name: browser, arguments: browserArgs } }
      : {}
    open(url, options).catch(() => {}) // Prevent `unhandledRejection` error.
    return true
  } catch (err) {
    return false
  }
}

/**
 * 一个实用的函数，用于异步执行 shell 命令
 * @param command
 * @param options
 */
function execAsync(command: string, options?: ExecOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, options, (error, stdout) => {
      if (error) {
        reject(error)
      } else {
        resolve(stdout.toString())
      }
    })
  })
}
