/**
 * 日期格式化工具
 *
 * 与前端 mock 数据保持一致的字符串格式 'YYYY-MM-DD HH:mm:ss'，
 * 避免前端在解析时间戳和字符串格式之间来回切换。
 */
import dayjs from 'dayjs'

/** 格式化为 'YYYY-MM-DD HH:mm:ss'，与前端 mock 数据格式保持一致 */
export function formatDateTime(date = new Date()) {
  return dayjs(date).format('YYYY-MM-DD HH:mm:ss')
}

/** 当前时间字符串 */
export function now() {
  return formatDateTime()
}
