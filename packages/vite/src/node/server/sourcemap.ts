import path from 'node:path'
import fsp from 'node:fs/promises'
import convertSourceMap from 'convert-source-map'
import type { ExistingRawSourceMap, SourceMap } from 'rollup'
import type { Logger } from '../logger'
import { blankReplacer, createDebugger } from '../utils'
import { cleanUrl } from '../../shared/utils'

// 这段代码涉及到源映射（source map）的处理，它包括了从代码中提取、注入源映射内容、生成源映射链接等操作

const debug = createDebugger('vite:sourcemap', {
  onlyWhenFocused: true,
})

// Virtual modules should be prefixed with a null byte to avoid a
// false positive "missing source" warning. We also check for certain
// prefixes used for special handling in esbuildDepPlugin.
const virtualSourceRE = /^(?:dep:|browser-external:|virtual:)|\0/

interface SourceMapLike {
  sources: string[]
  sourcesContent?: (string | null)[]
  sourceRoot?: string
}

/**
 *
 * @param map
 * @param file
 */
async function computeSourceRoute(map: SourceMapLike, file: string) {
  let sourceRoot: string | undefined
  try {
    // The source root is undefined for virtual modules and permission errors.
    sourceRoot = await fsp.realpath(
      path.resolve(path.dirname(file), map.sourceRoot || ''),
    )
  } catch {}
  return sourceRoot
}

/**
 * 向源映射中注入源文件内容
 * @param map
 * @param file
 * @param logger
 */
export async function injectSourcesContent(
  map: SourceMapLike,
  file: string,
  logger: Logger,
): Promise<void> {
  let sourceRootPromise: Promise<string | undefined>

  const missingSources: string[] = []
  const sourcesContent = map.sourcesContent || []
  const sourcesContentPromises: Promise<void>[] = []
  for (let index = 0; index < map.sources.length; index++) {
    const sourcePath = map.sources[index]
    if (
      sourcesContent[index] == null &&
      sourcePath &&
      !virtualSourceRE.test(sourcePath)
    ) {
      sourcesContentPromises.push(
        (async () => {
          // inject content from source file when sourcesContent is null
          sourceRootPromise ??= computeSourceRoute(map, file)
          const sourceRoot = await sourceRootPromise
          let resolvedSourcePath = cleanUrl(decodeURI(sourcePath))
          if (sourceRoot) {
            resolvedSourcePath = path.resolve(sourceRoot, resolvedSourcePath)
          }

          sourcesContent[index] = await fsp
            .readFile(resolvedSourcePath, 'utf-8')
            .catch(() => {
              missingSources.push(resolvedSourcePath)
              return null
            })
        })(),
      )
    }
  }

  await Promise.all(sourcesContentPromises)

  map.sourcesContent = sourcesContent

  // Use this command…
  //    DEBUG="vite:sourcemap" vite build
  // …to log the missing sources.
  if (missingSources.length) {
    logger.warnOnce(`Sourcemap for "${file}" points to missing source files`)
    debug?.(`Missing sources:\n  ` + missingSources.join(`\n  `))
  }
}

/**
 * 生成源映射的 URL
 * @param map
 */
export function genSourceMapUrl(map: SourceMap | string): string {
  if (typeof map !== 'string') {
    map = JSON.stringify(map)
  }
  return `data:application/json;base64,${Buffer.from(map).toString('base64')}`
}

/**
 * 它的作用是将源代码和源映射（source map）结合，生成带有源映射链接的代码
 * @param type 指定代码类型，可以是 JavaScript ('js') 或 CSS ('css')
 * @param code 源代码（JavaScript 或 CSS 代码），在此函数中将会添加源映射链接
 * @param map 源映射对象，通常是 JSON 格式的，表示源代码的映射关系，帮助调试工具定位源文件和代码行
 */
export function getCodeWithSourcemap(
  type: 'js' | 'css',
  code: string,
  map: SourceMap,
): string {
  // 在调试模式下，源映射对象（map）会被序列化为 JSON 字符串，并注入到代码的末尾
  if (debug) {
    code += `\n/*${JSON.stringify(map, null, 2).replace(/\*\//g, '*\\/')}*/\n`
  }

  // 根据代码类型（JavaScript 或 CSS），添加适当的源映射 URL
  if (type === 'js') {
    code += `\n//# sourceMappingURL=${genSourceMapUrl(map)}`
  } else if (type === 'css') {
    code += `\n/*# sourceMappingURL=${genSourceMapUrl(map)} */`
  }

  return code
}

/**
 * 应用源映射忽略列表
 * @param map
 * @param sourcemapPath
 * @param sourcemapIgnoreList
 * @param logger
 */
export function applySourcemapIgnoreList(
  map: ExistingRawSourceMap,
  sourcemapPath: string,
  sourcemapIgnoreList: (sourcePath: string, sourcemapPath: string) => boolean,
  logger?: Logger,
): void {
  let { x_google_ignoreList } = map
  if (x_google_ignoreList === undefined) {
    x_google_ignoreList = []
  }
  for (
    let sourcesIndex = 0;
    sourcesIndex < map.sources.length;
    ++sourcesIndex
  ) {
    const sourcePath = map.sources[sourcesIndex]
    if (!sourcePath) continue

    const ignoreList = sourcemapIgnoreList(
      path.isAbsolute(sourcePath)
        ? sourcePath
        : path.resolve(path.dirname(sourcemapPath), sourcePath),
      sourcemapPath,
    )
    if (logger && typeof ignoreList !== 'boolean') {
      logger.warn('sourcemapIgnoreList function must return a boolean.')
    }

    if (ignoreList && !x_google_ignoreList.includes(sourcesIndex)) {
      x_google_ignoreList.push(sourcesIndex)
    }
  }

  if (x_google_ignoreList.length > 0) {
    if (!map.x_google_ignoreList) map.x_google_ignoreList = x_google_ignoreList
  }
}

/**
 * 从文件中提取源映射
 * @param code
 * @param filePath
 */
export async function extractSourcemapFromFile(
  code: string,
  filePath: string,
): Promise<{ code: string; map: SourceMap } | undefined> {
  const map = (
    convertSourceMap.fromSource(code) ||
    (await convertSourceMap.fromMapFileSource(
      code,
      createConvertSourceMapReadMap(filePath),
    ))
  )?.toObject()

  if (map) {
    return {
      code: code.replace(convertSourceMap.mapFileCommentRegex, blankReplacer),
      map,
    }
  }
}

function createConvertSourceMapReadMap(originalFileName: string) {
  return (filename: string) => {
    return fsp.readFile(
      path.resolve(path.dirname(originalFileName), filename),
      'utf-8',
    )
  }
}
