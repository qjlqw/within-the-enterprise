/**
 * 语音输入 Hook
 *
 * 基于浏览器原生 Web Speech API（SpeechRecognition）
 * 零依赖、零后端改动，Chrome/Edge 完全支持
 *
 * 用法：
 *   const { supported, listening, start, stop, toggle } = useSpeechInput({
 *     onResult: (text, isFinal) => setInput(prev => isFinal ? `${prev} ${text}`.trim() : prev)
 *   })
 */
import { useState, useRef, useEffect, useCallback } from 'react'

// Web Speech API 类型声明（浏览器原生，非 TS 内置）
interface SpeechRecognitionResultLike {
  0: { transcript: string; confidence: number }
  length: number
  isFinal: boolean
}
interface SpeechRecognitionEventLike {
  resultIndex: number
  results: { length: number;[index: number]: SpeechRecognitionResultLike }
}
interface SpeechRecognitionErrorLike {
  error: string
  message: string
}
interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: SpeechRecognitionErrorLike) => void) | null
  onend: (() => void) | null
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

interface UseSpeechInputOptions {
  /** 识别到文本时的回调，isFinal=true 表示一句话结束 */
  onResult?: (text: string, isFinal: boolean) => void
  /** 开始录音时回调（用于保存当前输入框文本作为基础） */
  onStart?: () => void
  /** 语言，默认中文 */
  lang?: string
}

interface UseSpeechInputReturn {
  /** 浏览器是否支持语音识别 */
  supported: boolean
  /** 是否正在录音 */
  listening: boolean
  /** 开始录音 */
  start: () => void
  /** 停止录音 */
  stop: () => void
  /** 切换录音状态 */
  toggle: () => void
}

export function useSpeechInput(options: UseSpeechInputOptions = {}): UseSpeechInputReturn {
  const { onResult, onStart, lang = 'zh-CN' } = options

  const [supported] = useState(() => {
    if (typeof window === 'undefined') return false
    return Boolean(
      (window as unknown as { SpeechRecognition?: SpeechRecognitionConstructor }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionConstructor }).webkitSpeechRecognition
    )
  })
  const [listening, setListening] = useState(false)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  // 保存最新的回调，避免闭包过期
  const callbackRef = useRef(onResult)
  callbackRef.current = onResult
  const startCallbackRef = useRef(onStart)
  startCallbackRef.current = onStart

  const createRecognition = (): SpeechRecognitionLike | null => {
    const Ctor =
      (window as unknown as { SpeechRecognition?: SpeechRecognitionConstructor }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionConstructor }).webkitSpeechRecognition
    if (!Ctor) return null
    const rec = new Ctor()
    rec.lang = lang
    rec.continuous = true       // 持续识别，直到手动停止
    rec.interimResults = true   // 返回中间结果，实时显示
    rec.onresult = (event) => {
      let finalText = ''
      let interimText = ''
      console.log('event', event);

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        const transcript = result[0].transcript
        if (result.isFinal) finalText += transcript
        else interimText += transcript
      }
      if (finalText && callbackRef.current) callbackRef.current(finalText, true)
      if (interimText && callbackRef.current) callbackRef.current(interimText, false)
    }
    rec.onerror = (event) => {
      console.warn('[SpeechInput] 错误:', event.error, event.message)
      // 'not-allowed' / 'service-not-allowed' 表示麦克风权限被拒
      // 'no-speech' 表示没检测到语音，不需要停止
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        setListening(false)
      }
    }
    rec.onend = () => {
      setListening(false)
    }
    return rec
  }

  const start = useCallback(() => {
    if (!supported || listening) return
    const rec = createRecognition()
    if (!rec) return
    recognitionRef.current = rec
    // 通知组件保存当前输入框文本
    if (startCallbackRef.current) startCallbackRef.current()
    try {
      rec.start()
      setListening(true)
      console.log('[SpeechInput] 已开始录音')
    } catch (e) {
      console.error('[SpeechInput] 启动失败:', e)
      setListening(false)
    }
  }, [supported, listening])

  const stop = useCallback(() => {
    const rec = recognitionRef.current
    if (!rec) return
    try { rec.stop() } catch { /* 忽略 */ }
    setListening(false)
  }, [])

  const toggle = useCallback(() => {
    if (listening) stop()
    else start()
  }, [listening, start, stop])

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      const rec = recognitionRef.current
      if (rec) { try { rec.abort() } catch { /* 忽略 */ } }
    }
  }, [])

  return { supported, listening, start, stop, toggle }
}
