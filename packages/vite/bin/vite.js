#!/usr/bin/env node
import { performance } from 'node:perf_hooks'

// 如果不是从 node_modules 中加载的脚本（通常意味着是开发环境），则尝试动态导入 source-map-support 模块。
// 这个模块用于支持堆栈跟踪中的源映射，帮助在调试时提供更清晰的错误信息
if (!import.meta.url.includes('node_modules')) {
  try {
    // only available as dev dependency
    await import('source-map-support').then((r) => r.default.install())
  } catch (e) {}
}

// 使用 performance.now() 记录脚本开始执行的时间，这通常用于性能分析
global.__vite_start_time = performance.now()

// check debug mode first before requiring the CLI.
// 处理命令行参数
// -d 或 --debug 用于启用调试模式
const debugIndex = process.argv.findIndex((arg) => /^(?:-d|--debug)$/.test(arg))
// -f 或 --filter 用于过滤日志
const filterIndex = process.argv.findIndex((arg) =>
  /^(?:-f|--filter)$/.test(arg),
)
// --profile 用于启用性能分析
const profileIndex = process.argv.indexOf('--profile')

// 如果用户在命令行中指定了调试模式（-d 或 --debug），则设置 process.env.DEBUG 环境变量。
// 此环境变量用于启用指定模块的调试日志。如果没有指定具体的模块，默认启用 vite:* 的调试输出。
if (debugIndex > 0) {
  let value = process.argv[debugIndex + 1]
  if (!value || value.startsWith('-')) {
    value = 'vite:*'
  } else {
    // support debugging multiple flags with comma-separated list
    value = value
      .split(',')
      .map((v) => `vite:${v}`)
      .join(',')
  }
  process.env.DEBUG = `${
    process.env.DEBUG ? process.env.DEBUG + ',' : ''
  }${value}`

  // 如果指定了 -f 或 --filter 参数，用于进一步过滤调试信息的输出
  if (filterIndex > 0) {
    const filter = process.argv[filterIndex + 1]
    if (filter && !filter.startsWith('-')) {
      process.env.VITE_DEBUG_FILTER = filter
    }
  }
}

// 用于动态导入并执行 Vite 的 CLI 实现，cli.js 是最终执行的 Vite CLI 脚本
function start() {
  return import('../dist/node/cli.js')
}

// 如果命令行中包含 --profile 参数，则启用性能分析功能
if (profileIndex > 0) {
  process.argv.splice(profileIndex, 1)
  const next = process.argv[profileIndex]
  if (next && !next.startsWith('-')) {
    process.argv.splice(profileIndex, 1)
  }
  // 通过 node:inspector 模块创建一个 profiler 会话，连接到 V8 引擎的性能分析工具
  const inspector = await import('node:inspector').then((r) => r.default)
  // 启用 Profiler 功能并开始性能分析
  const session = (global.__vite_profile_session = new inspector.Session())
  session.connect()
  session.post('Profiler.enable', () => {
    // 在性能分析开始后，执行 start() 函数来启动 Vite CLI
    session.post('Profiler.start', start)
  })
} else {
  start()
}
