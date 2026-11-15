import { describe, expect, it } from 'vitest'
import { pinInputSlots } from './lock-pin-input'

describe('PIN input slot positions', () => {
  it('uses each newly entered slot', () => {
    expect(pinInputSlots('', '1')).toEqual([0])
    expect(pinInputSlots('1', '12')).toEqual([1])
    expect(pinInputSlots('12345', '123456')).toEqual([5])
  })
  it('emits one wave at each pasted digit', () => {
    expect(pinInputSlots('12', '123456')).toEqual([2, 3, 4, 5])
  })
  it('uses the edited slot for selection replacement, including identical digits', () => {
    expect(pinInputSlots('1234', '1934', { start: 1, end: 2 })).toEqual([1])
    expect(pinInputSlots('111', '111', { start: 1, end: 2 })).toEqual([1])
    expect(pinInputSlots('1234', '12894', { start: 2, end: 3 })).toEqual([2, 3])
  })
  it('does not emit waves for deletion or rejected text', () => {
    expect(pinInputSlots('123', '12')).toEqual([])
    expect(pinInputSlots('12', '12')).toEqual([])
  })
})
