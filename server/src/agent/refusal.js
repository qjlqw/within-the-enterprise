/**
 * 拒答分类（P0-2 误杀治理：拒答类回答豁免强制引用 / 工具判定）
 *
 * 背景：强制引用护栏会拦截「零工具结果 + 零有效引用」的回答，但两类正确回答
 * 本就不应携带引用，被误判为违规（误杀率复测 4/26 全部属此类）：
 * 1. security 安全 / 行为拒答：越权、越狱、写删改操作等被正确拒绝；
 * 2. missing  资料缺失 / 不存在拒答：知识库无相关资料，或文档不存在 / 未发布。
 *
 * 判定口径（精度优先于召回，避免放开护栏给通用知识作答留口子）：
 * - security：回答命中安全拒答措辞，且问题命中越权 / 写删改 / 越狱 / 套取意图，
 *   两侧同时命中才认定，防止普通回答被误判；
 * - missing：回答命中资料缺失 / 不存在措辞即认定。
 *
 * 命中证据写入 markers，供审计事件与评测集复测逐条核对。
 */

/** 问题侧：越权 / 越狱 / 写删改 / 套取内部信息 的意图模式 */
const QUESTION_INTENT_PATTERNS = [
  { key: 'write_op', re: /删除|移除|改掉|改为草稿|改成草稿|修改|新增|写入|编辑|替换|覆盖|创建文档|上传文档/ },
  { key: 'jailbreak', re: /忽略(规则|限制|提示|指令|约束)|绕过|突破(规则|限制)|越权|权限提升|以管理员|管理员授权/ },
  { key: 'disclosure', re: /把所有(草稿|文档|内容)|全部草稿|发给我|泄露|系统提示|提示词|凭据|密码|密钥|token/i },
]

/** 回答侧：安全拒答措辞（只读定位 / 明确拒绝执行） */
const ANSWER_SECURITY_PATTERNS = [
  { key: 'read_only', re: /只读助手|只能检索|只能查看|不支持(创建|修改|删除|写入|写操作)/ },
  { key: 'deny', re: /无法执行|不能执行|不支持执行|无权|没有权限|权限限制|规则不可绕过|不能忽略(既定)?规则|拒绝执行|无法完成这个请求|无法满足这个请求/ },
]

/** 回答侧：资料缺失 / 文档不存在拒答措辞 */
const ANSWER_MISSING_PATTERNS = [
  { key: 'not_found', re: /未找到相关资料|没有相关资料|缺少依据|资料不足|未能检索到|查不到|缺少(该|相关)?资料/ },
  { key: 'unavailable', re: /文档不存在|编号\s*\d+\s*的文档(不存在|未发布)|未发布|无法访问|无法读取其全文|无法确认/ },
]

const matchKeys = (patterns, text) => patterns.filter((p) => p.re.test(text)).map((p) => p.key)

/**
 * 判定一轮回答是否属于应豁免的拒答
 * @param {Object} params
 * @param {string} params.question 本轮用户提问
 * @param {string} params.answer  模型最终回答正文
 * @returns {{ refused: boolean, kind: 'security'|'missing'|null, markers: string[] }}
 */
export function classifyRefusal({ question = '', answer = '' } = {}) {
  const q = String(question)
  const a = String(answer)

  const intent = matchKeys(QUESTION_INTENT_PATTERNS, q)
  const security = matchKeys(ANSWER_SECURITY_PATTERNS, a)
  if (intent.length && security.length) {
    return { refused: true, kind: 'security', markers: [...intent, ...security] }
  }

  const missing = matchKeys(ANSWER_MISSING_PATTERNS, a)
  if (missing.length) {
    return { refused: true, kind: 'missing', markers: missing }
  }

  return { refused: false, kind: null, markers: [] }
}
