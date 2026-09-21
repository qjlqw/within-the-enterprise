/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * 格式化日期
 * @param date - 日期对象或字符串
 * @param format - 格式化模板
 * @returns 格式化后的日期字符串
 */
export function formatDate(
  date: Date | string | number | null | undefined,
  format = 'YYYY-MM-DD HH:mm:ss'
): string {
  if (!date) return ''
  const d = new Date(date)
  if (isNaN(d.getTime())) return ''

  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')
  const seconds = String(d.getSeconds()).padStart(2, '0')

  return format
    .replace('YYYY', String(year))
    .replace('MM', month)
    .replace('DD', day)
    .replace('HH', hours)
    .replace('mm', minutes)
    .replace('ss', seconds)
}

/**
 * 格式化数字（添加千分位）
 * @param num - 数字
 * @returns 格式化后的字符串
 */
export function formatNumber(num: number | null | undefined): string {
  if (num === null || num === undefined) return ''
  return String(num).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 防抖函数类型 */
type AnyFn = (...args: any[]) => void

/**
 * 防抖函数
 * @param fn - 需要防抖的函数
 * @param delay - 延迟时间（毫秒）
 * @returns 防抖后的函数
 */
export function debounce<T extends AnyFn>(fn: T, delay = 300): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  return function (this: unknown, ...args: Parameters<T>) {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      fn.apply(this, args)
    }, delay)
  }
}

/**
 * 节流函数
 * @param fn - 需要节流的函数
 * @param delay - 延迟时间（毫秒）
 * @returns 节流后的函数
 */
export function throttle<T extends AnyFn>(fn: T, delay = 300): (...args: Parameters<T>) => void {
  let lastTime = 0
  return function (this: unknown, ...args: Parameters<T>) {
    const now = Date.now()
    if (now - lastTime >= delay) {
      fn.apply(this, args)
      lastTime = now
    }
  }
}

/**
 * 深拷贝
 * @param obj - 需要拷贝的对象
 * @returns 拷贝后的对象
 */
export function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj
  if (obj instanceof Date) return new Date(obj.getTime()) as unknown as T
  if (Array.isArray(obj)) {
    return (obj as unknown[]).map((item) => deepClone(item)) as unknown as T
  }
  if (obj instanceof Object) {
    const copy: Record<string, unknown> = {}
    Object.keys(obj as Record<string, unknown>).forEach((key) => {
      copy[key] = deepClone((obj as Record<string, unknown>)[key])
    })
    return copy as unknown as T
  }
  return obj
}

/**
 * 生成唯一 ID
 * @returns 唯一 ID
 */
export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2)
}
