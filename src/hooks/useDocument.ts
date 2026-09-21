import { useState, useEffect, useCallback } from 'react'
import { documentApi } from '@/services/api'
import { mockApi } from '@/services/mock'
import { USE_MOCK } from '@/config/api'
import type { Document, DocumentQuery } from '@/types'

interface UseDocumentListResult {
  documents: Document[]
  loading: boolean
  total: number
  page: number
  pageSize: number
  setPage: (page: number) => void
  setPageSize: (size: number) => void
  refresh: () => void
}

/**
 * 文档列表 Hook
 * @param params - 查询参数（keyword/category/sortBy 等）
 */
export function useDocumentList(params: DocumentQuery = {}): UseDocumentListResult {
  const [documents, setDocuments] = useState<Document[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [total, setTotal] = useState<number>(0)
  const [page, setPage] = useState<number>(1)
  const [pageSize, setPageSize] = useState<number>(10)

  const fetchDocuments = useCallback(async () => {
    setLoading(true)
    try {
      const api = USE_MOCK ? mockApi.documents : documentApi
      const { list, total: t } = await api.getList({
        page,
        pageSize,
        ...params,
      })
      setDocuments(list)
      setTotal(t)
    } catch (error) {
      console.error('获取文档列表失败:', error)
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, JSON.stringify(params)])

  useEffect(() => {
    fetchDocuments()
  }, [fetchDocuments])

  const refresh = useCallback(() => {
    setPage(1)
    fetchDocuments()
  }, [fetchDocuments])

  return {
    documents,
    loading,
    total,
    page,
    pageSize,
    setPage,
    setPageSize,
    refresh,
  }
}
