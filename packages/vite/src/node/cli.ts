import path from 'node:path'
import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
import { cac } from 'cac'
import colors from 'picocolors'
import { VERSION } from './constants'
import type { BuildOptions } from './build'
import type { ServerOptions } from './server'
import type { CLIShortcut } from './shortcuts'
import type { LogLevel } from './logger'
import { createLogger } from './logger'
import { resolveConfig } from './config'

const cli = cac('vite') // 创建一个 CLI 实例，可以选择指定将用于在帮助和版本消息中显示的程序名称。

// global options
interface GlobalCLIOptions {
  '--'?: string[]
  c?: boolean | string
  config?: string
  base?: string
  l?: LogLevel
  logLevel?: LogLevel
  clearScreen?: boolean
  d?: boolean | string
  debug?: boolean | string
  f?: string
  filter?: string
  m?: string
  mode?: string
  force?: boolean
}

let profileSession = global.__vite_profile_session
let profileCount = 0

export const stopProfiler = (
  log: (message: string) => void,
): void | Promise<void> => {
  if (!profileSession) return
  return new Promise((res, rej) => {
    // TypeScript的感叹号语法是用来定义非空断言的，即告诉编译器某个变量一定不为空，使用方式为在变量名后加上感叹号，如“let x!: number”。 但需要注意，如果实际上该变量为空，运行时会抛出异常。
    profileSession!.post('Profiler.stop', (err: any, { profile }: any) => {
      // Write profile to disk, upload, etc.
      if (!err) {
        const outPath = path.resolve(
          `./vite-profile-${profileCount++}.cpuprofile`,
        )
        fs.writeFileSync(outPath, JSON.stringify(profile))
        log(
          colors.yellow(
            `CPU profile written to ${colors.white(colors.dim(outPath))}`,
          ),
        )
        profileSession = undefined
        res()
      } else {
        rej(err)
      }
    })
  })
}

/**
 const options = {
 a: [1, 2, 3],
 b: ['x', 'y'],
 c: 'test'
 };

 const filtered = filterDuplicateOptions(options);
 console.log(filtered);
 // 输出：{ a: 3, b: 'y', c: 'test' }
 */
const filterDuplicateOptions = <T extends object>(options: T) => {
  for (const [key, value] of Object.entries(options)) {
    if (Array.isArray(value)) {
      // as 类型断言，将数组的最后一个元素赋值给对应的属性
      options[key as keyof T] = value[value.length - 1]
    }
  }
}
/**
 * removing global flags before passing as command specific sub-configs,删除全局标志
 * 这段代码的目的是清理传递给某个函数或命令的选项对象中的全局配置标志，并返回一个仅包含命令特定配置的对象
 */
function cleanOptions<Options extends GlobalCLIOptions>(
  options: Options,
): Omit<Options, keyof GlobalCLIOptions> {
  const ret = { ...options }
  delete ret['--']
  delete ret.c
  delete ret.config
  delete ret.base
  delete ret.l
  delete ret.logLevel
  delete ret.clearScreen
  delete ret.d
  delete ret.debug
  delete ret.f
  delete ret.filter
  delete ret.m
  delete ret.mode

  // convert the sourcemap option to a boolean if necessary
  if ('sourcemap' in ret) {
    // 这行代码强制将 sourcemap 选项的类型转换为一个可能是 true、false、'inline' 或 'hidden' 的字符串类型
    // `${boolean}` 相当于 'true' | 'false'
    const sourcemap = ret.sourcemap as `${boolean}` | 'inline' | 'hidden'
    ret.sourcemap =
      sourcemap === 'true'
        ? true
        : sourcemap === 'false'
          ? false
          : ret.sourcemap
  }

  return ret
}

/**
 * host may be a number (like 0), should convert to string
 */
const convertHost = (v: any) => {
  if (typeof v === 'number') {
    return String(v)
  }
  return v
}

/**
 * base may be a number (like 0), should convert to empty string
 */
const convertBase = (v: any) => {
  if (v === 0) {
    return ''
  }
  return v
}

cli
  .option('-c, --config <file>', `[string] use specified config file`) // 使用指定的配置文件
  .option('--base <path>', `[string] public base path (default: /)`, { // 公共基础路径
    type: [convertBase],
  })
  .option('-l, --logLevel <level>', `[string] info | warn | error | silent`) // 日志层级
  .option('--clearScreen', `[boolean] allow/disable clear screen when logging`) // 允许或禁用打印日志时清除屏幕
  .option('-d, --debug [feat]', `[string | boolean] show debug logs`) // 显示调试日志
  .option('-f, --filter <filter>', `[string] filter debug logs`) // 过滤调试日志
  .option('-m, --mode <mode>', `[string] set env mode`) // 设置环境模式

// dev
cli
  .command('[root]', 'start dev server') // default command 项目根目录
  .alias('serve') // the command is called 'serve' in Vite's API
  .alias('dev') // alias to align with the script name
  .option('--host [host]', `[string] specify hostname`, { type: [convertHost] }) // 指定主机名称
  .option('--port <port>', `[number] specify port`) // 指定端口
  .option('--open [path]', `[boolean | string] open browser on startup`) // 启动时打开浏览器
  .option('--cors', `[boolean] enable CORS`) // 启用 CORS
  .option('--strictPort', `[boolean] exit if specified port is already in use`) // 如果指定的端口已在使用中，则退出
  .option(
    '--force',
    `[boolean] force the optimizer to ignore the cache and re-bundle`,
  ) // 强制优化器忽略缓存并重新构建
  .action(async (root: string, options: ServerOptions & GlobalCLIOptions) => {
    filterDuplicateOptions(options) // 过滤重复的选项
    // output structure is preserved even after bundling so require()
    // is ok here
    const { createServer } = await import('./server') //import(module) 表达式加载模块并返回一个 promise，该 promise resolve 为一个包含其所有导出的模块对象。我们可以在代码中的任意位置调用这个表达式。
    try {
      const server = await createServer({
        root, // 服务器的根目录，通常是项目的根目录，项目根目录（index.html 文件所在的位置）。可以是一个绝对路径，或者一个相对于该配置文件本身的相对路径
        base: options.base, // 开发或生产环境服务的公共基础路径
        mode: options.mode, // 环境模式（development、production）
        configFile: options.config, // 配置文件
        logLevel: options.logLevel, // 日志级别（例如：info, warn, error）
        clearScreen: options.clearScreen, // 是否在每次重新启动时清除终端屏幕
        optimizeDeps: { force: options.force }, // 是否强制重新构建依赖项，而忽略之前已经缓存过的、已经优化过的依赖
        server: cleanOptions(options), // 清理后的剩余服务器配置，可能是额外的服务器设置，例如端口、代理等
      })

      if (!server.httpServer) {
        throw new Error('HTTP server not available')
      }

      await server.listen() // 启动监听

      const info = server.config.logger.info

      const viteStartTime = global.__vite_start_time ?? false
      const startupDurationString = viteStartTime
        ? colors.dim(
            `ready in ${colors.reset(
              colors.bold(Math.ceil(performance.now() - viteStartTime)),
            )} ms`,
          )
        : ''
      const hasExistingLogs =
        process.stdout.bytesWritten > 0 || process.stderr.bytesWritten > 0

      info(
        `\n  ${colors.green(
          `${colors.bold('VITE')} v${VERSION}`,
        )}  ${startupDurationString}\n`,
        {
          clear: !hasExistingLogs,
        },
      )

      server.printUrls()
      // typeof操作符用于获取变量的类型，因此操作符后面接的始终是一个变量。
      // 展示了如何在 Vite 开发服务器中自定义快捷键，用于启动或停止性能分析器（Profiler）。
      // 具体来说，定义了一个快捷键 p，其作用是启动或停止性能分析器，使用 node:inspector 模块与 Node.js 的性能分析器进行交互
      const customShortcuts: CLIShortcut<typeof server>[] = []
      if (profileSession) {
        // 数组用于存储自定义的快捷键配置
        customShortcuts.push({
          key: 'p',
          description: 'start/stop the profiler',
          async action(server) {
            // 定义了按下 p 键时执行的操作
            if (profileSession) {
              // 如果 profileSession 已经存在（即已有一个分析会话），则会停止分析器（调用 stopProfiler）
              await stopProfiler(server.config.logger.info)
            } else {
              // 如果 profileSession 不存在，代码会
              // 1. 使用 import('node:inspector') 动态加载 node:inspector 模块。
              // 2. 创建并连接到一个新的 inspector.Session。
              // 3. 启用 Profiler 并开始性能分析。
              const inspector = await import('node:inspector').then(
                (r) => r.default,
              )
              await new Promise<void>((res) => {
                profileSession = new inspector.Session()
                profileSession.connect()
                profileSession.post('Profiler.enable', () => {
                  profileSession!.post('Profiler.start', () => {
                    server.config.logger.info('Profiler started')
                    res()
                  })
                })
              })
            }
          },
        })
      }
      // 将定义的快捷键与服务器进行绑定，使得可以通过命令行快捷键来触发相应的操作
      server.bindCLIShortcuts({ print: true, customShortcuts })
    } catch (e) {
      const logger = createLogger(options.logLevel)
      logger.error(colors.red(`error when starting dev server:\n${e.stack}`), {
        error: e,
      })
      stopProfiler(logger.info)
      process.exit(1)
    }
  })

// build
cli
  .command('build [root]', 'build for production')
  .option('--target <target>', `[string] transpile target (default: 'modules')`)
  .option('--outDir <dir>', `[string] output directory (default: dist)`)
  .option(
    '--assetsDir <dir>',
    `[string] directory under outDir to place assets in (default: assets)`,
  )
  .option(
    '--assetsInlineLimit <number>',
    `[number] static asset base64 inline threshold in bytes (default: 4096)`,
  )
  .option(
    '--ssr [entry]',
    `[string] build specified entry for server-side rendering`,
  )
  .option(
    '--sourcemap [output]',
    `[boolean | "inline" | "hidden"] output source maps for build (default: false)`,
  )
  .option(
    '--minify [minifier]',
    `[boolean | "terser" | "esbuild"] enable/disable minification, ` +
      `or specify minifier to use (default: esbuild)`,
  )
  .option('--manifest [name]', `[boolean | string] emit build manifest json`)
  .option('--ssrManifest [name]', `[boolean | string] emit ssr manifest json`)
  .option(
    '--emptyOutDir',
    `[boolean] force empty outDir when it's outside of root`,
  )
  .option('-w, --watch', `[boolean] rebuilds when modules have changed on disk`)
  .action(async (root: string, options: BuildOptions & GlobalCLIOptions) => {
    filterDuplicateOptions(options)
    const { build } = await import('./build')
    const buildOptions: BuildOptions = cleanOptions(options)

    try {
      await build({
        root, // 服务器的根目录，通常是项目的根目录，项目根目录（index.html 文件所在的位置）。可以是一个绝对路径，或者一个相对于该配置文件本身的相对路径
        base: options.base,
        mode: options.mode,
        configFile: options.config,
        logLevel: options.logLevel,
        clearScreen: options.clearScreen,
        build: buildOptions,
      })
    } catch (e) {
      createLogger(options.logLevel).error(
        colors.red(`error during build:\n${e.stack}`),
        { error: e },
      )
      process.exit(1)
    } finally {
      stopProfiler((message) => createLogger(options.logLevel).info(message))
    }
  })

// optimize
cli
  .command('optimize [root]', 'pre-bundle dependencies')
  .option(
    '--force',
    `[boolean] force the optimizer to ignore the cache and re-bundle`,
  )
  .action(
    async (root: string, options: { force?: boolean } & GlobalCLIOptions) => {
      filterDuplicateOptions(options)
      const { optimizeDeps } = await import('./optimizer')
      try {
        const config = await resolveConfig(
          {
            root,
            base: options.base,
            configFile: options.config,
            logLevel: options.logLevel,
            mode: options.mode,
          },
          'serve',
        )
        await optimizeDeps(config, options.force, true)
      } catch (e) {
        createLogger(options.logLevel).error(
          colors.red(`error when optimizing deps:\n${e.stack}`),
          { error: e },
        )
        process.exit(1)
      }
    },
  )

// preview
cli
  .command('preview [root]', 'locally preview production build')
  .option('--host [host]', `[string] specify hostname`, { type: [convertHost] })
  .option('--port <port>', `[number] specify port`)
  .option('--strictPort', `[boolean] exit if specified port is already in use`)
  .option('--open [path]', `[boolean | string] open browser on startup`)
  .option('--outDir <dir>', `[string] output directory (default: dist)`)
  .action(
    async (
      root: string,
      options: {
        host?: string | boolean
        port?: number
        open?: boolean | string
        strictPort?: boolean
        outDir?: string
      } & GlobalCLIOptions,
    ) => {
      filterDuplicateOptions(options)
      const { preview } = await import('./preview')
      try {
        const server = await preview({
          root,
          base: options.base,
          configFile: options.config,
          logLevel: options.logLevel,
          mode: options.mode,
          build: {
            outDir: options.outDir,
          },
          preview: {
            port: options.port,
            strictPort: options.strictPort,
            host: options.host,
            open: options.open,
          },
        })
        server.printUrls()
        server.bindCLIShortcuts({ print: true })
      } catch (e) {
        createLogger(options.logLevel).error(
          colors.red(`error when starting preview server:\n${e.stack}`),
          { error: e },
        )
        process.exit(1)
      } finally {
        stopProfiler((message) => createLogger(options.logLevel).info(message))
      }
    },
  )

cli.help()
cli.version(VERSION)

cli.parse()
