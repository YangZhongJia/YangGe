import { describe, expect, it } from 'vitest'
import {
  applyRefreshedWindowsPath,
  mergePathEntries,
  parseRegistryExportPath,
  refreshWindowsPathEnv
} from './agent-env'

describe('Windows PATH 刷新', () => {
  it('解析 reg export：REG_SZ 引号值与中文路径', () => {
    expect(
      parseRegistryExportPath(
        [
          'Windows Registry Editor Version 5.00',
          '',
          '[HKEY_CURRENT_USER\\Environment]',
          '"Path"="C:\\\\Tools;C:\\\\Users\\\\张三\\\\bin"',
          '"TEMP"=hex(2):25,00,54,00,00,00'
        ].join('\r\n')
      )
    ).toBe('C:\\Tools;C:\\Users\\张三\\bin')
  })

  it('解析 reg export：hex(2) 续行、UTF-16LE 与结尾 NUL', () => {
    // %USERPROFILE%\中文 的 UTF-16LE 字节，拆成两行续行，尾部带 NUL。
    const text = [
      'Windows Registry Editor Version 5.00',
      '',
      '[HKEY_CURRENT_USER\\Environment]',
      '"Path"=hex(2):25,00,55,00,53,00,45,00,52,00,50,00,52,00,4f,00,46,00,49,00,4c,\\',
      '  00,45,00,25,00,5c,00,2d,4e,87,65,00,00'
    ].join('\r\n')
    expect(parseRegistryExportPath(text)).toBe('%USERPROFILE%\\中文')
  })

  it('没有 Path 值时返回 null', () => {
    expect(
      parseRegistryExportPath('Windows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Environment]\r\n"TEMP"="C:\\\\Temp"\r\n')
    ).toBeNull()
    expect(parseRegistryExportPath('错误: 系统找不到指定的注册表项或值。\r\n')).toBeNull()
  })

  it('展开 %VAR%、去重并保留先出现的顺序', () => {
    expect(
      mergePathEntries(
        [
          'C:\\Windows\\System32',
          ' %USERPROFILE%\\bin ',
          '"C:\\Tools\\"',
          '%MISSING%\\bin',
          'relative\\bin',
          'c:\\windows\\system32'
        ],
        { USERPROFILE: 'C:\\Users\\me' }
      )
    ).toEqual(['C:\\Windows\\System32', 'C:\\Users\\me\\bin', 'C:\\Tools'])
  })

  it('非 Windows 原样返回，不做任何替换', () => {
    const env = { PATH: '/usr/local/bin' }
    expect(refreshWindowsPathEnv(env, { platform: 'linux' })).toBe(env)
    expect(applyRefreshedWindowsPath({ platform: 'linux' })).toBe(false)
  })

  it('合并用户与系统注册表 PATH，且不产生重复的大小写键', () => {
    const env = {
      Path: 'C:\\Windows\\System32',
      USERPROFILE: 'C:\\Users\\me',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files'
    }
    const next = refreshWindowsPathEnv(env, {
      platform: 'win32',
      run: (key) =>
        key.startsWith('HKCU')
          ? '%LOCALAPPDATA%\\Programs\\Tern\\omp\\bin;%USERPROFILE%\\AppData\\Roaming\\npm'
          : 'C:\\Windows\\System32;%ProgramFiles%\\nodejs'
    })

    expect(next).not.toBe(env)
    expect(next['Path']).toBe(
      [
        'C:\\Windows\\System32',
        'C:\\Users\\me\\AppData\\Local\\Programs\\Tern\\omp\\bin',
        'C:\\Users\\me\\AppData\\Roaming\\npm',
        'C:\\Program Files\\nodejs'
      ].join(';')
    )
    expect(next['PATH']).toBeUndefined()
  })

  it('注册表不可读时保持原 PATH 不变（返回等价副本）', () => {
    const env = { Path: 'C:\\Windows' }
    expect(
      refreshWindowsPathEnv(env, { platform: 'win32', run: () => null })['Path']
    ).toBe('C:\\Windows')
  })
})
