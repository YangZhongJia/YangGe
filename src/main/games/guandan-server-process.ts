import { fork, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'

/** 内嵌掼蛋的局域网房间服务；固定端口便于同事用 IP 直连。 */
export const GUANDAN_PORT = 17890

let child: ChildProcess | null = null

export function startGuandanServer(options: {
  scriptPath: string
  scoresPath: string
  port?: number
}): void {
  if (child || !existsSync(options.scriptPath)) return
  child = fork(options.scriptPath, [], {
    env: {
      ...process.env,
      // 复用 Electron 可执行文件的 Node 模式，不额外要求用户安装 Node。
      ELECTRON_RUN_AS_NODE: '1',
      GUANDAN_PORT: String(options.port ?? GUANDAN_PORT),
      GUANDAN_SCORES: options.scoresPath
    },
    stdio: 'ignore'
  })
  child.on('exit', () => {
    child = null
  })
  child.unref()
}

export function stopGuandanServer(): void {
  child?.kill()
  child = null
}
