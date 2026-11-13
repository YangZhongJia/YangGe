import { describe, expect, it } from 'vitest'
import { resolve, sep } from 'node:path'
import { resolveGuandanAsset } from './guandan-assets'

const root = resolve('test-guandan-root')

describe('掼蛋静态资源解析', () => {
  it('映射首页与资源文件', () => {
    expect(resolveGuandanAsset(root, 'yangge-game://guandan/index.html')).toBe(resolve(root, 'index.html'))
    expect(resolveGuandanAsset(root, 'yangge-game://guandan/assets/main.js')).toBe(resolve(root, 'assets', 'main.js'))
    expect(resolveGuandanAsset(root, 'yangge-game://guandan/')).toBe(resolve(root, 'index.html'))
  })

  it('拒绝其他协议/域名与路径穿越', () => {
    expect(resolveGuandanAsset(root, 'yangge-game://other/index.html')).toBeNull()
    expect(resolveGuandanAsset(root, 'https://guandan/index.html')).toBeNull()
    expect(resolveGuandanAsset(root, `yangge-game://guandan/..${sep}..${sep}secret.txt`)).toBeNull()
    expect(resolveGuandanAsset(root, 'yangge-game://guandan/%2e%2e%2f%2e%2e%2fsecret.txt')).toBeNull()
    expect(resolveGuandanAsset(root, 'not a url')).toBeNull()
  })
})
