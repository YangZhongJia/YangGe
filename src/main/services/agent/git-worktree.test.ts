import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitTaskWorkspace } from './git-worktree'

const directories: string[] = []

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30_000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}\n${stderr}`))
          return
        }
        resolve(stdout)
      }
    )
  })
}

async function createRepository(): Promise<{ root: string; baseCommit: string; worktreeRoot: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'yangge-worktree-test-'))
  directories.push(dir)
  const root = join(dir, 'source repo with spaces')
  const worktreeRoot = join(dir, 'app owned worktrees')
  await mkdir(root, { recursive: true })
  await runGit(root, ['init', '-b', 'main'])
  await runGit(root, ['config', 'user.name', 'YangGe Test'])
  await runGit(root, ['config', 'user.email', 'yangge@example.test'])
  await runGit(root, ['config', 'core.autocrlf', 'false'])
  await writeFile(join(root, 'edit.txt'), 'before\n')
  await writeFile(join(root, 'delete.txt'), 'remove me\n')
  await writeFile(join(root, 'asset.bin'), Buffer.from([0, 1, 2, 3, 255]))
  await runGit(root, ['add', '.'])
  await runGit(root, ['commit', '-m', 'base'])
  const baseCommit = (await runGit(root, ['rev-parse', 'HEAD'])).trim()
  return { root, baseCommit, worktreeRoot }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('GitTaskWorkspace', () => {
  it('refuses a dirty source repository without changing it and creates an isolated worktree', async () => {
    const { root, baseCommit, worktreeRoot } = await createRepository()
    const service = new GitTaskWorkspace(worktreeRoot)

    await writeFile(join(root, 'edit.txt'), 'uncommitted\n')
    const statusBefore = await runGit(root, ['status', '--porcelain=v1'])
    await expect(service.create('dirty-task', root)).rejects.toThrow(
      'repo_must_be_clean'
    )
    expect(await runGit(root, ['status', '--porcelain=v1'])).toBe(statusBefore)
    expect(await readFile(join(root, 'edit.txt'), 'utf8')).toBe('uncommitted\n')

    await writeFile(join(root, 'edit.txt'), 'before\n')
    const created = await service.create('task-1', root)
    expect(created).toMatchObject({
      repoRoot: root,
      sourceBranch: 'main',
      baseCommit,
      taskBranch: 'yangge/task-task-1'
    })
    expect(created.worktreePath.startsWith(worktreeRoot)).toBe(true)
    expect(await exists(join(created.worktreePath, '.git'))).toBe(true)
    expect(await readFile(join(created.worktreePath, 'edit.txt'), 'utf8')).toBe('before\n')
  })

  it('captures added, edited, deleted, binary, and spaced paths and applies them unstaged', async () => {
    const { root, worktreeRoot } = await createRepository()
    const service = new GitTaskWorkspace(worktreeRoot)
    const created = await service.create('changes-task', root)

    await writeFile(join(created.worktreePath, 'edit.txt'), 'after\n')
    await writeFile(join(created.worktreePath, 'asset.bin'), Buffer.from([0, 9, 8, 7, 255]))
    await rm(join(created.worktreePath, 'delete.txt'))
    await mkdir(join(created.worktreePath, 'new dir'), { recursive: true })
    await writeFile(join(created.worktreePath, 'new dir', 'new file.txt'), 'created\n')

    const patch = await service.buildPatch('changes-task')
    const patchText = patch.toString('utf8')
    expect(patchText).toContain('GIT binary patch')
    expect(patchText).toContain('new file.txt')
    expect(patchText).toContain('delete.txt')

    await service.apply('changes-task', root)
    expect(await readFile(join(root, 'edit.txt'), 'utf8')).toBe('after\n')
    expect(await readFile(join(root, 'asset.bin'))).toEqual(Buffer.from([0, 9, 8, 7, 255]))
    expect(await readFile(join(root, 'new dir', 'new file.txt'), 'utf8')).toBe('created\n')
    await expect(readFile(join(root, 'delete.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await runGit(root, ['diff', '--cached', '--name-only'])).toBe('')
  })

  it('refuses to apply after the source branch moves', async () => {
    const { root, worktreeRoot } = await createRepository()
    const service = new GitTaskWorkspace(worktreeRoot)
    const created = await service.create('moved-task', root)
    await writeFile(join(created.worktreePath, 'task-only.txt'), 'task change\n')

    await writeFile(join(root, 'source-only.txt'), 'new source commit\n')
    await runGit(root, ['add', 'source-only.txt'])
    await runGit(root, ['commit', '-m', 'move source branch'])

    await expect(service.apply('moved-task', root)).rejects.toThrow('source_branch_moved')
    expect(await exists(join(root, 'task-only.txt'))).toBe(false)
  })

  it('refuses to apply into a newly dirty source repository', async () => {
    const { root, worktreeRoot } = await createRepository()
    const service = new GitTaskWorkspace(worktreeRoot)
    const created = await service.create('dirty-apply-task', root)
    await writeFile(join(created.worktreePath, 'task-only.txt'), 'task change\n')
    await writeFile(join(root, 'edit.txt'), 'dirty target\n')

    await expect(service.apply('dirty-apply-task', root)).rejects.toThrow(
      'repo_must_be_clean'
    )
    expect(await readFile(join(root, 'edit.txt'), 'utf8')).toBe('dirty target\n')
    expect(await exists(join(root, 'task-only.txt'))).toBe(false)
  })

  it('removes the task worktree and branch', async () => {
    const { root, worktreeRoot } = await createRepository()
    const service = new GitTaskWorkspace(worktreeRoot)
    const created = await service.create('cleanup-task', root)

    await service.remove('cleanup-task')

    expect(await exists(created.worktreePath)).toBe(false)
    expect(await runGit(root, ['branch', '--list', created.taskBranch])).toBe('')
    expect(await runGit(root, ['worktree', 'list', '--porcelain'])).not.toContain(
      created.worktreePath
    )
  })
})
