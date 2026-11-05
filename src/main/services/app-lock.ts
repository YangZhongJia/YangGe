import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const PIN_PATTERN = /^\d{6}$/
const SALT_BYTES = 16
const KEY_BYTES = 32
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const
const HASH_PATTERN = /^scrypt\$([0-9a-f]{32})\$([0-9a-f]{64})$/

/** 锁屏密码只接受 6 位数字；渲染层和主进程使用同一判定。 */
export function isLockPin(value: unknown): value is string {
  return typeof value === 'string' && PIN_PATTERN.test(value)
}

/** scrypt + 随机盐；配置里只保存哈希，不落明文。 */
export function hashLockPin(pin: string): string {
  if (!isLockPin(pin)) throw new Error('锁屏密码必须是 6 位数字')
  const salt = randomBytes(SALT_BYTES)
  const key = scryptSync(pin, salt, KEY_BYTES, SCRYPT_OPTIONS)
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`
}

export function isLockPinHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_PATTERN.test(value)
}

export function verifyLockPin(pin: unknown, stored: unknown): boolean {
  if (!isLockPin(pin) || !isLockPinHash(stored)) return false
  const match = HASH_PATTERN.exec(stored)
  if (!match) return false
  try {
    const salt = Buffer.from(match[1], 'hex')
    const expected = Buffer.from(match[2], 'hex')
    const actual = scryptSync(pin, salt, KEY_BYTES, SCRYPT_OPTIONS)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}
