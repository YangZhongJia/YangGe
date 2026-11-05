import { describe, expect, it } from 'vitest'
import { hashLockPin, isLockPin, isLockPinHash, verifyLockPin } from './app-lock'

describe('本机锁屏密码', () => {
  it('只接受 6 位数字，哈希带随机盐且不落明文', () => {
    expect(isLockPin('123456')).toBe(true)
    for (const value of ['12345', '1234567', '12345a', 123456, null]) {
      expect(isLockPin(value)).toBe(false)
    }
    const first = hashLockPin('123456')
    const second = hashLockPin('123456')
    expect(isLockPinHash(first)).toBe(true)
    expect(first).not.toBe(second)
    expect(first).not.toContain('123456')
    expect(verifyLockPin('123456', first)).toBe(true)
    expect(verifyLockPin('654321', first)).toBe(false)
    expect(verifyLockPin('123456', 'scrypt$broken')).toBe(false)
  })
})
