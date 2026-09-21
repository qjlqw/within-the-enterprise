import puppeteer from "puppeteer";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function createResumePDF() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  // HTML 内容 - 简洁专业风格，无背景色，压缩间距以适应两页
  const htmlContent = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>秦建林 - 前端开发简历</title>
    <style>
        @page {
            margin: 12mm;
        }
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: "Microsoft YaHei", "SimHei", "Noto Sans SC", sans-serif;
            font-size: 12px;
            line-height: 1.6;
            color: #333;
            background: #fff;
        }
        .container {
            max-width: 210mm;
            margin: 0 auto;
            padding: 0;
        }
        /* 头部信息 */
        .header {
            text-align: center;
            padding-bottom: 10px;
            border-bottom: 2px solid #333;
            margin-bottom: 12px;
        }
        .name {
            font-size: 26px;
            font-weight: bold;
            margin-bottom: 6px;
            letter-spacing: 6px;
        }
        .basic-info {
            font-size: 11px;
            color: #555;
            line-height: 1.7;
        }
        /* 区块标题 */
        .section {
            margin-bottom: 10px;
        }
        .section-title {
            font-size: 14px;
            font-weight: bold;
            border-bottom: 1px solid #333;
            padding-bottom: 3px;
            margin-bottom: 6px;
            letter-spacing: 1px;
        }
        /* 技能列表 */
        .skill-list {
            list-style: none;
            padding: 0;
        }
        .skill-list li {
            margin-bottom: 4px;
            padding-left: 12px;
            position: relative;
            line-height: 1.6;
            text-align: justify;
        }
        .skill-list li::before {
            content: "•";
            position: absolute;
            left: 0;
            color: #333;
        }
        /* 工作经历 */
        .job-item {
            margin-bottom: 8px;
        }
        .job-header {
            display: flex;
            justify-content: space-between;
            align-items: baseline;
            margin-bottom: 3px;
        }
        .company-name {
            font-weight: bold;
            font-size: 13px;
        }
        .job-date {
            font-size: 11px;
            color: #666;
        }
        .job-position {
            font-size: 12px;
            color: #555;
            margin-bottom: 3px;
        }
        .job-desc {
            list-style: none;
            padding-left: 0;
        }
        .job-desc li {
            margin-bottom: 2px;
            padding-left: 10px;
            position: relative;
            line-height: 1.6;
            text-align: justify;
        }
        .job-desc li::before {
            content: "-";
            position: absolute;
            left: 0;
            color: #666;
        }
        /* 项目经历 */
        .project-item {
            margin-bottom: 10px;
        }
        .project-header {
            display: flex;
            justify-content: space-between;
            align-items: baseline;
            gap: 8px;
            flex-wrap: wrap;
            margin-bottom: 2px;
        }
        .project-name {
            flex: 1 1 auto;
            font-weight: bold;
            font-size: 13px;
            line-height: 1.5;
            word-break: break-word;
        }
        .project-date {
            flex-shrink: 0;
            font-size: 11px;
            color: #666;
            white-space: nowrap;
        }
        .project-tech {
            font-size: 11px;
            color: #666;
            margin-bottom: 4px;
            line-height: 1.5;
            font-style: italic;
            word-break: break-word;
        }
        .project-desc {
            list-style: none;
            padding-left: 0;
            margin: 0;
        }
        .project-desc li {
            margin-bottom: 3px;
            padding-left: 12px;
            position: relative;
            line-height: 1.6;
            text-align: left;
            word-break: break-word;
        }
        .project-desc li::before {
            content: "-";
            position: absolute;
            left: 0;
            color: #666;
        }
        /* 教育经历 */
        .edu-item {
            display: flex;
            justify-content: space-between;
            align-items: baseline;
        }
        .edu-school {
            font-weight: bold;
            font-size: 13px;
        }
        .edu-major {
            color: #555;
            font-size: 12px;
        }
        .edu-date {
            color: #666;
            font-size: 11px;
        }
    </style>
</head>
<body>
    <div class="container">
        <!-- 头部信息 -->
        <div class="header">
            <div class="name">秦建林</div>
            <div class="basic-info">
                性别：男 | 年龄：25岁 | 工作经验：5年<br>
                期望岗位：前端开发 | 期望城市：南京 | 期望薪资：面议<br>
                联系电话：15330787609 | 邮箱：3056554231@qq.com
            </div>
        </div>

        <!-- 专业技能 -->
        <div class="section">
            <div class="section-title">专业技能</div>
            <ul class="skill-list">
                <li>具备 5 年前端开发经验，精通 HTML5、CSS3、JavaScript（ES6+）与 TypeScript，能够独立完成需求分析、技术方案设计、开发自测、性能优化及上线交付；</li>
                <li>精通 Vue2/Vue3 技术栈，熟练使用 Vite、Vue Router、Pinia/Vuex、Element Plus/Element UI；熟练掌握 React、React Router、CSS Modules 及主流组件库，具备复杂中后台与移动端应用开发能力；</li>
                <li>精通 uni-app、Taro 跨端开发，掌握 UTS 原生插件开发及 Android AudioTrack、HarmonyOS AudioRenderer、iOS AVFoundation 音频能力，具备小程序、App、H5 多端适配、打包与发布经验；</li>
                <li>熟悉企业级前端架构，具备 IAM 单点登录、RBAC 权限模型、动态路由、菜单与按钮级权限设计经验，能够封装 Axios 请求层、强类型 API、文件上传下载及长任务状态管理；</li>
                <li>具备 AI Agent 业务落地经验，能够围绕上下文、多会话、技能参数、任务状态、成果归档与报告导出建设智能体工作台，并熟练使用 AI 辅助工具提升开发与排障效率；</li>
                <li>熟悉 ECharts、AntV G6、Canvas 与 PDF.js，具备复杂报表、知识图谱、节点聚类、交互高亮及文档预览开发经验；</li>
                <li>深入掌握 WebSocket 实时通信、流式数据传输、断线重连、消息去重与顺序保障，具备 PCM 队列、环形缓冲、播放状态机及跨平台实时音频处理经验；</li>
                <li>具备大型前端性能与稳定性治理经验，熟悉虚拟化/冷热区渲染、增量更新、防抖、并发请求隔离、对象池、零拷贝及组件生命周期资源回收；</li>
                <li>熟悉 Vite、Webpack 工程化配置，掌握路由懒加载、异步组件重试、依赖分包、Gzip、缓存与生产日志清理；了解 Node.js、Express、Nginx、Linux，熟练使用 Git、ESLint、Husky 等工具保障代码质量。</li>
            </ul>
        </div>

        <!-- 工作经历 -->
        <div class="section">
            <div class="section-title">工作经历</div>
            <div class="job-item">
                <div class="job-header">
                    <span class="company-name">青岛必然信息科技有限公司</span>
                    <span class="job-date">2026.03 - 至今</span>
                </div>
                <div class="job-position">前端开发</div>
                <ul class="job-desc">
                    <li>独立负责企业级咨询智能体平台与园区车位派位系统前端建设，并作为核心模块 Owner 交付 AIUI 同声传译系统，覆盖 Web 管理端、移动端及跨平台 App；</li>
                    <li>负责需求分析、技术方案设计、核心模块开发、接口联调、自测上线及持续迭代，推动 AI 咨询、园区管理和实时同传等复杂业务从需求到交付落地；</li>
                    <li>建设企业权限、动态路由、统一请求、实时通信、数据可视化及跨端原生音频等通用能力，解决复杂异步状态、长列表渲染、知识图谱重绘和断网重连等关键技术问题；</li>
                    <li>持续推进性能与稳定性治理，通过增量渲染、请求并发隔离、资源生命周期管理、构建分包与压缩等手段提升系统响应效率及多端运行可靠性。</li>
                </ul>
            </div>
            
            <div class="job-item">
                <div class="job-header">
                    <span class="company-name">河南蓝果网络技术有限公司</span>
                    <span class="job-date">2024.11 - 2026.3</span>
                </div>
                <div class="job-position">前端开发</div>
                <ul class="job-desc">
                    <li>负责小程序、APP双端开发、打包及全流程部署，独立完成项目开发、自测、客户交付全流程工作，月均为公司创造10万业绩；</li>
                    <li>运用CSS3/JS开发各类动画效果，优化页面渲染逻辑，解决页面卡顿问题，保障页面流畅运行，显著提升用户视觉体验；</li>
                    <li>负责公司所有前端项目的日常迭代、bug修复与问题维护，保障业务系统稳定运行。</li>
                </ul>
            </div>

            <div class="job-item">
                <div class="job-header">
                    <span class="company-name">郑州新益华医学科技有限公司</span>
                    <span class="job-date">2023.07 - 2024.10</span>
                </div>
                <div class="job-position">Web前端</div>
                <ul class="job-desc">
                    <li>参与医疗行业HIS系统重构，负责结构化病历、门诊/住院医生站等核心模块开发，实现医疗业务多模块数据流转与信息化展示，遵循国标规范完成医院信息化建设；</li>
                    <li>主导项目Webpack配置优化，通过SplitChunks提取公共代码等手段，有效提升项目首屏加载速度，优化前端整体性能；</li>
                    <li>参与项目现场实施部署与公司内部服务器前端代码更新，保障医疗HIS系统7*24小时稳定运行，支撑医院日常诊疗业务。</li>
                </ul>
            </div>

            <div class="job-item">
                <div class="job-header">
                    <span class="company-name">安阳大玉软件科技有限公司</span>
                    <span class="job-date">2021.08 - 2023.05</span>
                </div>
                <div class="job-position">前端开发工程师</div>
                <ul class="job-desc">
                    <li>负责公司后台管理系统、小程序、公众号的全流程开发与维护，深度参与项目需求分析、UI还原、编码、自测全环节；</li>
                    <li>基于Taro框架开发并迭代京小红小程序，使用uni-app开发多端公众号与APP应用，通过跨端技术实现一套代码适配多端，提升开发效率；</li>
                    <li>与后端、UI团队紧密协作，严格还原UI设计稿，保障项目从设计到上线的视觉与功能一致性，负责项目后期迭代升级与持续维护。</li>
                </ul>
            </div>
        </div>

        <!-- 项目经历 -->
        <div class="section">
            <div class="section-title">项目经历</div>
            <div class="project-item">
                <div class="project-header">
                    <span class="project-name">卡奥斯启智咨询全链路智能体平台</span>
                    <span class="project-date">2026.6 - 2026.8</span>
                </div>
                <div class="project-tech">
                    技术栈：Vue3、TypeScript、Vite、Pinia、Vue Router、Element Plus、Axios、ECharts、AntV G6、Haier IAM、RBAC、Sass、动态路由、Gzip
                </div>
                <ul class="project-desc">
                    <li>独立负责企业级咨询智能体平台前端所有的模块建设，落地工作台、售前管理、招投标、项目交付、诊断评估、企业知识库、团队协作及系统设置业务，构建从客户分析、现场调研、方案生成、投标编制到项目交付和知识沉淀的一体化咨询业务链路；</li>
                    <li>建设售前诊断评估智能体工作台，整合分析报告、访谈提纲、结果映射、客户画像、风险评估、方案构建 6 类 AI 技能，实现项目上下文关联、多会话创建与管理、技能参数配置、任务状态反馈、历史成果归档以及结果预览与导出，提升咨询材料生产和复用效率；</li>
                    <li>开发 CMMM 与灯塔工厂双评估体系，实现后端问卷数据标准化、能力域动态分组、答题进度统计、答案保存恢复、完整性校验及评估提交；打通 AI 评估报告生成链路，结合 ECharts 结构化展示成熟度、核心优势、能力短板、分域评估和改进路线图，并支持 HTML 预览与报告下载；</li>
                    <li>建设企业知识库管理与智能检索模块，支持知识仓库、目录、标签等多维筛选，以及文档、表格、PDF、图片等多格式资料批量上传；接入飞书云文档选择与导入，实现知识检索、收藏、订阅、下载和图文内容管理，形成咨询资料统一沉淀与复用体系；</li>
                    <li>基于 AntV G6 实现交互式知识图谱，完成知识、标签、关键词及关联数量节点的语义分层布局、节点聚类、搜索联动、关系高亮、节点钻取和详情分页；通过复用 Canvas 与事件监听、changeData 增量更新、请求序号屏障、查询防抖、节点边去重、ResizeObserver 及 Force Simulation 生命周期管理，解决过期响应覆盖、频繁重绘、动画空转和组件切换后布局异常问题；</li>
                    <li>设计并落地 IAM 单点登录与 RBAC 权限体系，实现授权码换取 Token、登录态恢复、401 自动续登及后端菜单驱动的动态路由，完成路由、菜单、按钮三级权限控制；通过 import.meta.glob 建立安全组件映射，支持菜单在线配置并避免后端组件路径直接注入；</li>
                    <li>完善前端工程化体系，封装统一 Axios 请求层及强类型 API，集中处理 Token 注入、响应拆包、业务状态码、HTTP 异常、文件上传、网络超时和 AI 长任务；实施路由懒加载、异步组件缓存与失败重试、空闲预加载、依赖分包、Gzip 压缩及生产日志清理，并结合 TypeScript、ESLint、Husky 提升代码质量与部署性能。</li>
                </ul>                                                                                                                                             
            </div>      
            <div class="project-item">
                <div class="project-header">
                    <span class="project-name">园区车位摇号派位管理系统（PassageCenter Allocation）</span>
                    <span class="project-date">2026.6 - 至今</span>
                </div>
                <div class="project-tech">技术栈：React、TypeScript、@haier/bwd-mobile、@haier/turbu-react、moment.js、CSS Modules、RESTful API、CSV/Excel 导入导出</div>
                <ul class="project-desc">
                    <li>独立负责园区车位摇号派位全链路前端，覆盖管理端「计划创建 → 报名推送 → 排序生成 → 派位执行 → 交费推送」与员工端「用户申报 → 托管设置 → 在线缴费」，实现摇号到付款完整业务闭环；</li>
                    <li>管理端：派位计划/任务 CRUD、多维度时间校验与配额联动、报名双数据源切换与推送轮询、排序生成与 CSV/Excel 导入导出、四阶段派位流程及五维统计明细面板；</li>
                    <li>员工端：移动端申报页（幸运数字 + 意向区域优先级 + 截止倒计时状态机）、托管设置（有效期/启用开关）、车位缴费页（双支付方式 + 付款倒计时 + 订单/发票）；</li>
                    <li>设计表单状态机（编辑/只读/取消/超时）与权限码 + 业务状态双重约束，保障各阶段操作合法性；</li>
                    <li>封装编号生成、Blob 下载、并发 Loading 控制等公共工具，攻克 bizId 回查、cancelled 防泄漏等异步场景难题。</li>
                </ul>
            </div>
            <div class="project-item">
                <div class="project-header">
                    <span class="project-name">AIUI 同声传译系统</span>
                    <span class="project-date">2026.3 - 2026.6</span>
                </div>
                <div class="project-tech">技术栈：Vue3、uni-app、UTS、TypeScript、WebSocket、SD-AudioRecorder、Pinia、环形缓冲、冷热区渲染、跨平台适配</div>
                <ul class="project-desc">
                    <li>作为同传系统的核心模块 Owner，独立开发主端、共享端、语音播放引擎三大核心组件，实现完整的"采集-推送-展示-播放"同传主链路闭环；</li>
                    <li>主端：开发语音采集+ASR+翻译组件，通过 WebSocket 双通道架构将识别/翻译结果实时推送至共享端，将 TTS 流推至语音播放引擎；从插件市场引入 SD-AudioRecorder UTS 原生音频插件并二次开发，实现 Android AudioTrack + HarmonyOS AudioRenderer 的 PCM 队列式播放（FIFO 生产-消费模型），支持耳听播放防回流、后台长时任务保活、AVSession 播控卡等能力；</li>
                    <li>共享端：开发共享端组件，通过 WebSocket 实时接收主端推送的 ASR 识别与翻译结果，实现多人会议场景下多端同步展示；设计智能滚动同步算法，实现自动追底（最新消息）与手动翻阅（历史查看）的双模式切换，滚动位置精确到像素级；</li>
                    <li>语音播放引擎：设计并实现企业级语音播放引擎，为主端和共享端提供统一的 TTS 流式播放能力，封装 WebSocket 连接、PCM 队列管理、播放状态机等核心模块；实现 PCM 阆列式播放架构（FIFO 生产-消费模型），支持播放/暂停/恢复/静音/清空队列等操作，队列空时自动输出静音不中断，保障播放流畅无爆音；</li>
                    <li>设计冷热区分离渲染架构，将文本数据分为热区（50条最新）和冷区（全量历史），热区传 Vue 渲染、冷区存普通 JS 数组，配合 Dirty Key 增量更新，将 Vue Diff 计算减少 90%+，支持 2000+ 段落流畅渲染；</li>
                    <li>实现 14 项核心性能优化：PCM 零拷贝视图（消除 GC）、峰值检测替代 RMS+dB（CPU 降低 62%）、WebSocket 消息批处理（send 减少 50%）、智能心跳（Data-as-Heartbeat）、对象池+版本号驱动声纹动画、环形缓冲动态扩容等；</li>
                    <li>攻克鸿蒙平台息屏/后台保活难题（DATA_TRANSFER + audioRecording + audioPlayback 长时任务）、Android/iOS 音频路由切换等跨平台技术难题，实现 WebSocket 断网自动重连、消息去重与顺序保障机制，解决 Android/iOS/鸿蒙/H5 四端断线重连差异，保障系统 7×24 小时稳定运行。</li>
                </ul>
            </div>
            <div class="project-item">
                <div class="project-header">
                    <span class="project-name">聚潮box旗舰版</span>
                    <span class="project-date">2025.06 - 至今</span>
                </div>
                <div class="project-tech">技术栈：uni-app、Vue2、CSS3、多端编译</div>
                <ul class="project-desc">
                    <li>独立开发潮玩手办、盲盒购物类小程序+APP双端产品，完成证书配置并辅助上线至微信、应用宝等各大平台，可线上搜索体验；</li>
                    <li>开发一番赏、无限赏、擂台赏等多样化互动玩法，支持福利分享功能，有效提升用户粘性与平台活跃度；</li>
                    <li>运用Promise、Map、懒加载、图片缓存等技术优化前端性能，解决页面加载卡顿问题，大幅提升用户浏览体验。</li>
                </ul>
            </div>

            <div class="project-item">
                <div class="project-header">
                    <span class="project-name">佰库MAX</span>
                    <span class="project-date">2025.02 - 至今</span>
                </div>
                <div class="project-tech">技术栈：uni-app、Vue2、多端编译</div>
                <ul class="project-desc">
                    <li>独立负责抽赏平台小程序+APP双端开发，实现无限赏、积分赏、福袋、农场等十余种核心玩法，满足平台多元化业务需求；</li>
                    <li>设计并开发玩家自制福袋功能，支持平台抽成、排队抽赏、折扣设置等个性化配置，提升用户参与度与平台收益；</li>
                    <li>实现商品分级管理与权益配置，保障各类抽赏玩法业务逻辑顺畅运行，提升平台运营灵活性。</li>
                </ul>
            </div>

            <div class="project-item">
                <div class="project-header">
                    <span class="project-name">OneHealth-临床一体化</span>
                    <span class="project-date">2023.07 - 2024.10</span>
                </div>
                <div class="project-tech">技术栈：Vue、VxeTable、Element-UI、WebSocket、Node.js、锐浪报表、微服务架构</div>
                <ul class="project-desc">
                    <li>参与医疗HIS系统临床一体化平台开发，基于微服务架构完成挂号、分诊、医生站、医嘱、检验检查、结算、结束就诊等全流程业务模块的前端对接与实现；</li>
                    <li>负责结构化电子病历、门诊/住院医生站、医嘱开立、检验检查申请等核心功能开发，实现从患者挂号→就诊→开医嘱→检验检查执行→结果回传→诊疗结束的全流程闭环；</li>
                    <li>实现病历全结构化采集、质控规则配置、归档管理等功能，支持电子社保卡识别、处方开具、发药等医疗核心业务；</li>
                    <li>通过WebSocket实现医疗数据实时同步，保障门诊、住院业务高效流转，运用锐浪报表完成医疗数据统计分析，为医院决策提供数据支撑。</li>
                </ul>
            </div>
        </div>

        <!-- 教育经历 -->
        <div class="section">
            <div class="section-title">教育经历</div>
            <div class="edu-item">
                <div>
                    <span class="edu-school">白城师范学院</span>
                    <span class="edu-major"> | 计算机应用技术（大专）</span>
                </div>
                <span class="edu-date">2018.09 - 2021.06</span>
            </div>
        </div>

        <!-- 备注 -->
        <!-- <div style="margin-top: 20px; text-align: center; font-style: italic; color: #666;">
            更多项目经历可以在面试时候介绍
        </div> -->
    </div>
</body>
</html>`;

  // 设置页面内容
  await page.setContent(htmlContent, {
    waitUntil: "networkidle0",
  });

  // 生成 PDF
  const outputPath = path.join(__dirname, "秦建林-前端开发简历-v4.pdf");
  await page.pdf({
    path: outputPath,
    format: "A4",
    printBackground: false,
    margin: {
      top: "15mm",
      right: "15mm",
      bottom: "15mm",
      left: "15mm",
    },
  });

  await browser.close();

  console.log("简历 PDF 文件已生成！");
  console.log("文件路径:", outputPath);
}

createResumePDF().catch((err) => {
  console.error("生成 PDF 时出错:", err);
  process.exit(1);
});
