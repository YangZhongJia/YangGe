import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { TaskWorkspace } from '../../../shared/ipc'

const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i

function taskError(code: string, detail?: string): Error {
  return new Error(detail ? `${code}: ${detail}` : code)
}

/**
 * 普通目录工作区：Agent 直接在所选目录内工作。
 * 没有 git 隔离与补丁应用——目录即工作现场，改动实时可见。
 */
export class DirectoryTaskWorkspace {
  async create(taskId: string, dirPath: string): Promise<TaskWorkspace> {
    if (!TASK_ID_PATTERN.test(taskId)) throw taskError('invalid_task_id')
    if (!dirPath.trim() || !isAbsolute(dirPath)) throw taskError('invalid_directory_path')
    const dir = resolve(dirPath)
    const info = await stat(dir).catch(() => null)
    if (!info || !info.isDirectory()) throw taskError('directory_not_found', dir)
    return {
      repoRoot: dir,
      sourceBranch: '',
      baseCommit: '',
      worktreePath: dir,
      taskBranch: ''
    }
  }

  async buildPatch(): Promise<Buffer> {
    throw taskError('patch_unsupported_plain_directory')
  }

  async listChangedFiles(): Promise<string[]> {
    throw taskError('patch_unsupported_plain_directory')
  }

  async apply(): Promise<void> {
    throw taskError('patch_unsupported_plain_directory')
  }

  async remove(): Promise<void> {
    // 普通目录任务没有托管工作区，无需清理。
  }
}
