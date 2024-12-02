import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { isFileReadable } from '../utils'

// 这段代码主要实现了两个函数：searchForPackageRoot 和 searchForWorkspaceRoot，用于在项目目录树中查找 package.json 和工作区根目录。它还包含一些辅助函数，帮助判断特定文件或目录的存在性。

// https://github.com/vitejs/vite/issues/2820#issuecomment-812495079
const ROOT_FILES = [
  // '.git',

  // https://pnpm.io/workspaces/
  'pnpm-workspace.yaml',

  // https://rushjs.io/pages/advanced/config_files/
  // 'rush.json',

  // https://nx.dev/latest/react/getting-started/nx-setup
  // 'workspace.json',
  // 'nx.json',

  // https://github.com/lerna/lerna#lernajson
  'lerna.json',
]

// npm: https://docs.npmjs.com/cli/v7/using-npm/workspaces#installing-workspaces
// yarn: https://classic.yarnpkg.com/en/docs/workspaces/#toc-how-to-use-it
function hasWorkspacePackageJSON(root: string): boolean {
  const path = join(root, 'package.json')
  if (!isFileReadable(path)) { // 检查 package.json 是否可读
    return false
  }
  try {
    const content = JSON.parse(fs.readFileSync(path, 'utf-8')) || {}
    return !!content.workspaces // 解析该文件，检查是否包含 workspaces 字段
  } catch {
    return false
  }
}

function hasRootFile(root: string): boolean {
  // 检查项目根目录是否包含 ROOT_FILES 中的任意文件。ROOT_FILES 包含一些常见的工作区配置文件，如 pnpm-workspace.yaml 和 lerna.json
  // 通过检查这些文件是否存在来推测当前目录是否为一个工作区根目录
  return ROOT_FILES.some((file) => fs.existsSync(join(root, file)))
}

/**
 * 检查给定路径下是否存在 package.json 文件。这个函数的主要目的是判断当前目录是否为一个 Node.js 项目的根目录
 * @param root
 */
function hasPackageJSON(root: string) {
  const path = join(root, 'package.json')
  return fs.existsSync(path)
}

/**
 * 从当前目录 current 向上搜索，直到找到第一个包含 package.json 文件的目录，并返回该目录路径。
 * Search up for the nearest `package.json`
 */
export function searchForPackageRoot(current: string, root = current): string {
  if (hasPackageJSON(current)) return current

  const dir = dirname(current)
  // reach the fs root
  if (!dir || dir === current) return root
  // 如果在当前目录找到 package.json，则返回当前目录。如果没有找到，继续向上搜索父目录，直到达到文件系统的根目录
  return searchForPackageRoot(dir, root)
}

/**
 * 从当前目录 current 向上搜索，直到找到一个包含工作区文件（如 pnpm-workspace.yaml、lerna.json 或者 package.json 中的 workspaces 字段）的目录，并返回该目录路径
 * Search up for the nearest workspace root
 */
export function searchForWorkspaceRoot(
  current: string,
  root = searchForPackageRoot(current),
): string {
  if (hasRootFile(current)) return current
  if (hasWorkspacePackageJSON(current)) return current

  const dir = dirname(current)
  // reach the fs root
  if (!dir || dir === current) return root

  // 它首先检查当前目录是否为工作区根目录，如果不是，继续向上搜索父目录，直到找到工作区的根目录或到达文件系统的根目录
  return searchForWorkspaceRoot(dir, root)
}
