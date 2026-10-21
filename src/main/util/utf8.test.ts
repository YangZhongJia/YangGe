import { expect, it } from 'vitest'
import { truncateUtf8 } from './utf8'

it.each([
  ['', 0, '', false],
  ['abc', 2, 'ab', true],
  ['茶😀话', 2, '', true],
  ['茶😀话', 6, '茶', true],
  ['茶😀话', 7, '茶😀', true],
  ['茶😀话', 10, '茶😀话', false]
] as const)('UTF-8 截断 %j 至 %i 字节', (text, limit, expected, truncated) => {
  expect(truncateUtf8(text, limit)).toEqual({ text: expected, truncated })
})
