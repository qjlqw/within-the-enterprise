import { useState, useEffect, useCallback } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import {
  Input,
  Tag,
  Typography,
  Empty,
  Spin,
  Card,
  Row,
  Col,
  Button,
  Space,
  message,
} from 'antd'
import {
  ClockCircleOutlined,
  UserOutlined,
  FireOutlined,
  StarOutlined,
  SearchOutlined,
  CloseOutlined,
} from '@ant-design/icons'
import { searchApi } from '@/services/api'
import { mockApi } from '@/services/mock'
import { USE_MOCK } from '@/config/api'
import type { Document } from '@/types'

const { Search } = Input
const { Title, Text, Paragraph } = Typography

interface SearchResultData {
  list: Document[]
  total: number
}

function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const [keyword, setKeyword] = useState<string>(searchParams.get('q') || '')
  const [loading, setLoading] = useState<boolean>(false)
  const [results, setResults] = useState<SearchResultData>({ list: [], total: 0 })
  const [hotSearches, setHotSearches] = useState<string[]>([])
  const [recommendations, setRecommendations] = useState<Document[]>([])
  const [searchHistory, setSearchHistory] = useState<string[]>([])
  const [searchTime, setSearchTime] = useState<number>(0)

  const loadHotSearches = useCallback(async () => {
    try {
      const api = USE_MOCK ? mockApi.search : searchApi
      const data = await api.getHotSearches()
      setHotSearches(data)
    } catch (error) {
      console.error('加载热门搜索失败:', error)
    }
  }, [])

  const loadRecommendations = useCallback(async () => {
    try {
      const api = USE_MOCK ? mockApi.search : searchApi
      const data = await api.recommend()
      setRecommendations(data)
    } catch (error) {
      console.error('加载推荐失败:', error)
    }
  }, [])

  const loadSearchHistory = useCallback(async () => {
    try {
      const api = USE_MOCK ? mockApi.search : searchApi
      const data = await api.getSearchHistory()
      setSearchHistory(data)
    } catch (error) {
      console.error('加载搜索历史失败:', error)
    }
  }, [])

  const handleSearch = useCallback(
    async (value: string) => {
      const v = value.trim()
      if (!v) {
        setSearchParams({})
        return
      }
      // 同步到 URL，便于分享/刷新
      setSearchParams({ q: v })
      setLoading(true)
      const startTime = Date.now()
      try {
        const api = USE_MOCK ? mockApi.search : searchApi
        const data = await api.search(v)
        setResults({ list: data.list || [], total: data.total || 0 })
        setSearchTime(Date.now() - startTime)
        loadSearchHistory()
      } catch (error) {
        console.error('搜索失败:', error)
      } finally {
        setLoading(false)
      }
    },
    [setSearchParams, loadSearchHistory]
  )

  const handleClearHistory = async () => {
    try {
      const api = USE_MOCK ? mockApi.search : searchApi
      await api.clearSearchHistory()
      setSearchHistory([])
      message.success('已清空搜索历史')
    } catch (error) {
      console.error('清空搜索历史失败:', error)
    }
  }

  // 初始加载（无 query）时拉取热门/推荐/历史
  useEffect(() => {
    const q = searchParams.get('q')
    if (q) {
      setKeyword(q)
      handleSearch(q)
    } else {
      loadHotSearches()
      loadRecommendations()
      loadSearchHistory()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.get('q')])

  const highlightText = (text: string, kw: string) => {
    if (!kw) return text
    // 转义特殊字符
    const safe = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`(${safe})`, 'gi')
    const parts = text.split(regex)
    return parts.map((part, i) =>
      regex.test(part) ? (
        <Text key={i} mark>
          {part}
        </Text>
      ) : (
        <span key={i}>{part}</span>
      )
    )
  }

  const hasQuery = !!searchParams.get('q')

  if (!hasQuery && !loading) {
    return (
      <div>
        <Search
          placeholder="搜索文档、标签、内容..."
          size="large"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onSearch={handleSearch}
          style={{ marginBottom: 24 }}
          enterButton={<SearchOutlined />}
        />

        <Row gutter={16}>
          <Col span={12}>
            <Card title="🔥 热门搜索" style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {hotSearches.map((term, index) => (
                  <Tag
                    key={term}
                    color={index < 3 ? 'red' : index < 5 ? 'orange' : 'blue'}
                    style={{ cursor: 'pointer', padding: '4px 12px' }}
                    onClick={() => handleSearch(term)}
                  >
                    {index < 3 && <FireOutlined style={{ marginRight: 4 }} />}
                    {term}
                  </Tag>
                ))}
              </div>
            </Card>

            {searchHistory.length > 0 && (
              <Card
                title="🕘 搜索历史"
                extra={
                  <Button
                    type="link"
                    size="small"
                    icon={<CloseOutlined />}
                    onClick={handleClearHistory}
                  >
                    清空
                  </Button>
                }
              >
                <Space size={[8, 8]} wrap>
                  {searchHistory.map((term) => (
                    <Tag
                      key={term}
                      style={{ cursor: 'pointer', padding: '2px 8px' }}
                      onClick={() => handleSearch(term)}
                    >
                      {term}
                    </Tag>
                  ))}
                </Space>
              </Card>
            )}
          </Col>
          <Col span={12}>
            <Card title="📌 智能推荐">
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {recommendations.map((item) => (
                  <div
                    key={item.id}
                    style={{
                      padding: '12px 0',
                      borderBottom: '1px solid #f0f0f0',
                      cursor: 'pointer',
                    }}
                    onClick={() => navigate(`/document/${item.id}`)}
                  >
                    <div style={{ fontWeight: 500, marginBottom: 4 }}>{item.title}</div>
                    <div style={{ fontSize: 12 }}>
                      <Tag color="blue">{item.category}</Tag>
                      <span style={{ marginLeft: 8 }}>
                        <StarOutlined /> {item.likes}
                      </span>
                    </div>
                  </div>
                ))}
                {recommendations.length === 0 && (
                  <div style={{ textAlign: 'center', color: '#999', padding: '20px 0' }}>
                    暂无推荐
                  </div>
                )}
              </div>
            </Card>
          </Col>
        </Row>
      </div>
    )
  }

  return (
    <div>
      <Search
        placeholder="搜索文档、标签、内容..."
        size="large"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        onSearch={handleSearch}
        style={{ marginBottom: 24 }}
        enterButton={<SearchOutlined />}
      />

      {loading ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin size="large" />
          <div style={{ marginTop: 8, color: '#999' }}>搜索中...</div>
        </div>
      ) : results.list.length > 0 ? (
        <div>
          <div style={{ marginBottom: 16, color: '#999' }}>
            找到约 {results.total} 条结果（用时 {searchTime}ms）
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {results.list.map((item) => (
              <div
                key={item.id}
                style={{
                  padding: '16px 0',
                  borderBottom: '1px solid #f0f0f0',
                  cursor: 'pointer',
                }}
                onClick={() => navigate(`/document/${item.id}`)}
              >
                <Title level={4} style={{ marginBottom: 8 }}>
                  {highlightText(item.title, keyword)}
                </Title>
                <Paragraph
                  type="secondary"
                  style={{ fontSize: 14, marginBottom: 8 }}
                  ellipsis={{ rows: 2 }}
                >
                  {highlightText(item.content?.substring(0, 200) || '', keyword)}
                </Paragraph>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 16,
                    flexWrap: 'wrap',
                  }}
                >
                  <Tag color="blue">{item.category}</Tag>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    <UserOutlined /> {item.authorName}
                  </Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    <ClockCircleOutlined /> {item.updatedAt}
                  </Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    <FireOutlined /> {item.views} 浏览
                  </Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    <StarOutlined /> {item.likes} 点赞
                  </Text>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <Empty
          description={
            <div>
              <p>未找到相关结果</p>
              <Button type="link" onClick={() => handleSearch('')}>
                清除搜索
              </Button>
            </div>
          }
        />
      )}
    </div>
  )
}

export default SearchPage
