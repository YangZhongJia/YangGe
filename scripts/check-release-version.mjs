// 发版提醒：内网更新只对“严格更高版本”提示。同版本重打包只适合本机自测。
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(process.cwd())
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const setup = resolve(root, 'release', `YangGe-${pkg.version}-win-x64-setup.exe`)

if (existsSync(setup)) {
  console.warn(
    `[release] 当前版本 ${pkg.version} 的安装包已存在于 release/。` +
      '同版本重打包不会让同事端出现内网更新按钮；对外分发前请先递增 package.json 的 patch 版本。'
  )
}
