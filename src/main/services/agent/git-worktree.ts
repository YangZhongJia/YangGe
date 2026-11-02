import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { RepositoryState, TaskWorkspace } from '../../../shared/ipc'

const GIT_TIMEOUT_MS = 60_000
const GIT_MAX_BUFFER = 8 * 1024 * 1024
const PATCH_MAX_BUFFER = 64 * 1024 * 1024
const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i

export type TaskWorkspaceLookup = (taskId: string) => TaskWorkspace | null

interface GitOptions {
  maxBuffer?: number
}

function gitFailure(prefix: string, error: Error & { stderr?: string | Buffer }): Error {
  const stderr = Buffer.isBuffer(error.stderr) ? error.stderr.toString('utf8') : error.stderr
  const detail = stderr?.trim().slice(0, 2_000)
  return new Error(detail ? `${prefix}: ${detail}` : `${prefix}: ${error.message}`)
}

function runGit(
  cwd: string,
  args: string[],
  options: GitOptions & { binary: true }
): Promise<Buffer>
function runGit(
  cwd: string,
  args: string[],
  options?: GitOptions
): Promise<string>
function runGit(
  cwd: string,
  args: string[],
  options: GitOptions & { binary?: boolean } = {}
): Promise<string | Buffer> {
  const common = {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true
  }
  if (options.binary) {
    return new Promise((resolvePromise, reject) => {
      execFile(
        'git',
        args,
        { ...common, encoding: null },
        (error, stdout, stderr) => {
          if (error) {
            reject(gitFailure('git_failed', Object.assign(error, { stderr })))
            return
          }
          resolvePromise(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout))
        }
      )
    })
  }
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      args,
      { ...common, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          reject(gitFailure('git_failed', Object.assign(error, { stderr })))
          return
        }
        resolvePromise(stdout)
      }
    )
  })
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function taskError(code: string, detail?: string): Error {
  return new Error(detail ? `${code}: ${detail}` : code)
}

function assertTaskId(taskId: string): void {
  if (!TASK_ID_PATTERN.test(taskId)) throw taskError('invalid_task_id')
}

export class GitTaskWorkspace {
  private readonly created = new Map<string, TaskWorkspace>()
  private rootPromise: Promise<string> | null = null

  constructor(
    private readonly configuredRoot: string,
    private readonly lookupTask: TaskWorkspaceLookup = () => null
  ) {
    if (!configuredRoot.trim() || !isAbsolute(configuredRoot)) {
      throw taskError('invalid_worktree_root')
    }
  }

  async inspectRepository(path: string): Promise<RepositoryState> {
    if (!path.trim() || !isAbsolute(path)) throw taskError('invalid_repository_path')
    let rootOutput: string
    let branch: string
    let baseCommit: string
    let status: string
    try {
      rootOutput = await runGit(path, ['rev-parse', '--show-toplevel'])
      branch = (await runGit(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim()
      baseCommit = (await runGit(path, ['rev-parse', '--verify', 'HEAD'])).trim()
      status = await runGit(path, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all'
      ])
    } catch (error) {
      throw taskError(
        'not_git_repository',
        error instanceof Error ? error.message : String(error)
      )
    }
    if (!rootOutput.trim()) throw taskError('not_git_repository')
    if (!branch || branch === 'HEAD') throw taskError('detached_head_unsupported')
    if (!baseCommit) throw taskError('missing_base_commit')
    const repoRoot = await realpath(resolve(rootOutput.trim()))
    return {
      repoRoot,
      sourceBranch: branch,
      baseCommit,
      clean: status.length === 0
    }
  }

  async create(taskId: string, repoPath: string): Promise<TaskWorkspace> {
    assertTaskId(taskId)
    const state = await this.inspectRepository(repoPath)
    if (!state.clean) throw taskError('repo_must_be_clean')

    const root = await this.ensureRoot()
    const worktreePath = join(root, taskId)
    if (await pathExists(worktreePath)) throw taskError('worktree_exists')
    const taskBranch = `yangge/task-${taskId}`
    await runGit(state.repoRoot, [
      'worktree',
      'add',
      '-b',
      taskBranch,
      worktreePath,
      state.baseCommit
    ])
    const workspace: TaskWorkspace = {
      repoRoot: state.repoRoot,
      sourceBranch: state.sourceBranch,
      baseCommit: state.baseCommit,
      worktreePath: await realpath(worktreePath),
      taskBranch
    }
    this.created.set(taskId, workspace)
    return workspace
  }

  async buildPatch(taskId: string): Promise<Buffer> {
    const workspace = this.resolveWorkspace(taskId)
    await runGit(workspace.worktreePath, ['add', '--intent-to-add', '--', '.'])
    return runGit(
      workspace.worktreePath,
      ['diff', '--binary', '--no-ext-diff', '--no-color', workspace.baseCommit, '--'],
      { binary: true, maxBuffer: PATCH_MAX_BUFFER }
    )
  }

  async listChangedFiles(taskId: string): Promise<string[]> {
    const workspace = this.resolveWorkspace(taskId)
    await runGit(workspace.worktreePath, ['add', '--intent-to-add', '--', '.'])
    const output = await runGit(workspace.worktreePath, [
      'diff',
      '--name-only',
      '-z',
      '--no-ext-diff',
      workspace.baseCommit,
      '--'
    ])
    return output.split('\0').filter(Boolean)
  }

  async apply(taskId: string, repoPath: string): Promise<void> {
    const workspace = this.resolveWorkspace(taskId)
    const state = await this.inspectRepository(repoPath)
    if (state.repoRoot !== workspace.repoRoot) throw taskError('repository_mismatch')
    if (state.sourceBranch !== workspace.sourceBranch) {
      throw taskError('source_branch_changed')
    }
    if (state.baseCommit !== workspace.baseCommit) {
      throw taskError('source_branch_moved')
    }
    if (!state.clean) throw taskError('repo_must_be_clean')

    const patch = await this.buildPatch(taskId)
    if (patch.length === 0) throw taskError('patch_empty')
    const root = await this.ensureRoot()
    const patchPath = join(
      root,
      `.apply-${taskId}-${randomBytes(8).toString('hex')}.patch`
    )
    await writeFile(patchPath, patch)
    try {
      await runGit(state.repoRoot, [
        'apply',
        '--binary',
        '--whitespace=nowarn',
        patchPath
      ])
    } finally {
      await unlink(patchPath).catch(() => undefined)
    }
  }

  async remove(taskId: string): Promise<void> {
    const workspace = this.resolveWorkspace(taskId)
    const root = await this.ensureRoot()
    const pathFromRoot = relative(root, workspace.worktreePath)
    if (
      pathFromRoot.startsWith(`..${sep}`) ||
      pathFromRoot === '..' ||
      isAbsolute(pathFromRoot)
    ) {
      throw taskError('worktree_outside_root')
    }

    if (await pathExists(workspace.worktreePath)) {
      await runGit(workspace.repoRoot, [
        'worktree',
        'remove',
        '--force',
        workspace.worktreePath
      ])
    } else {
      await runGit(workspace.repoRoot, ['worktree', 'prune']).catch(() => undefined)
    }
    const existingBranch = (
      await runGit(workspace.repoRoot, ['branch', '--list', workspace.taskBranch])
    ).trim()
    if (existingBranch) {
      await runGit(workspace.repoRoot, ['branch', '-D', workspace.taskBranch])
    }
    this.created.delete(taskId)
  }

  private resolveWorkspace(taskId: string): TaskWorkspace {
    assertTaskId(taskId)
    const workspace = this.created.get(taskId) ?? this.lookupTask(taskId)
    if (!workspace) throw taskError('task_workspace_not_found')
    return workspace
  }

  private ensureRoot(): Promise<string> {
    if (!this.rootPromise) {
      this.rootPromise = mkdir(this.configuredRoot, { recursive: true }).then(() =>
        realpath(this.configuredRoot)
      )
    }
    return this.rootPromise
  }
}
