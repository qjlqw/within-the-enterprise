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
  // A4 扣除左右 15mm 页边距后的可打印区域，便于生成前校验两页内容高度。
  await page.setViewport({ width: 680, height: 1009, deviceScaleFactor: 1 });

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
            width: 100%;
            margin: 0 auto;
            padding: 0;
        }
        .resume-page {
            width: 100%;
        }
        .page-one {
            height: 266mm;
            break-after: page;
            page-break-after: always;
        }
        .page-two {
            height: 265mm;
            break-inside: avoid;
        }
        .page-two > .section:last-child {
            margin-bottom: 0;
        }
        /* 头部信息 */
        .header {
            text-align: center;
            padding-bottom: 10px;
            border-bottom: 2px solid #333;
            margin-bottom: 10px;
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
            margin-bottom: 9px;
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
            margin-bottom: 2px;
            padding-left: 12px;
            position: relative;
            line-height: 1.6;
            text-align: left;
            word-break: break-word;
        }
        .page-two .project-desc li {
            line-height: 1.55;
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
      <div class="resume-page page-one">
        <!-- 头部信息 -->
        <div class="header">
            <div class="name">秦建林</div>
            <div class="basic-info">
                性别：男 | 年龄：25岁 | 工作经验：5年<br>
                期望岗位：前端开发 | 期望城市：深圳 | 期望薪资：面议<br>
                联系电话：15330787609 | 邮箱：3056554231@qq.com
            </div>
        </div>

        <!-- 专业技能 -->
        <div class="section">
            <div class="section-title">专业技能</div>
            <ul class="skill-list">
                <li><strong>5 年前端经验：</strong>精通 JavaScript（ES6+）、TypeScript、HTML5、CSS3，熟练使用 Vue2/Vue3、React 及其生态，具备复杂中后台、移动端应用从方案设计到上线交付的独立负责能力；</li>
                <li><strong>多端与原生能力：</strong>熟练使用 uni-app、Taro 开发小程序、App、H5，掌握 UTS 插件二次开发，以及 Android AudioTrack、HarmonyOS AudioRenderer、iOS AVFoundation 等原生音频能力；</li>
                <li><strong>企业级架构：</strong>具备 IAM 单点登录、RBAC、动态路由及菜单/按钮级权限落地经验，能够建设统一请求层、强类型 API、文件传输、长任务状态管理等通用基础设施；</li>
                <li><strong>AI 与可视化：</strong>有 AI Agent 工作台、知识库、评估报告落地经验；熟悉 ECharts、AntV G6、Canvas、PDF.js，可处理知识图谱布局、交互高亮与复杂报表预览导出；</li>
                <li><strong>实时音视频：</strong>深入掌握 WebSocket 流式传输、断线重连、消息去重与顺序保障，具备 PCM 队列、环形缓冲、播放状态机和 Android/iOS/鸿蒙跨平台音频处理经验；</li>
                <li><strong>性能与工程化：</strong>熟悉冷热区渲染、增量更新、并发隔离、对象池、零拷贝及资源回收；掌握 Vite/Webpack 分包、懒加载、Gzip、缓存优化，以及 Git、ESLint、Husky 工程规范。</li>
                <li><strong>业务与协作：</strong>具备咨询、园区、医疗、电商等行业项目经验，能够梳理复杂业务状态与接口契约，独立完成联调、自测、部署、线上排障和持续迭代。</li>
            </ul>
        </div>

        <!-- 工作经历 -->
        <div class="section work-section">
            <div class="section-title">工作经历</div>
            <div class="job-item">
                <div class="job-header">
                    <span class="company-name">青岛必然信息科技有限公司</span>
                    <span class="job-date">2026.03 - 至今</span>
                </div>
                <div class="job-position">前端开发</div>
                <ul class="job-desc">
                    <li>独立负责企业级咨询智能体平台、园区车位派位系统前端建设，并作为核心模块 Owner 交付 AIUI 同声传译系统，覆盖 Web 管理端、移动端及跨平台 App；</li>
                    <li>承担需求分析、方案设计、核心开发、联调上线全流程，沉淀权限路由、统一请求、实时通信、数据可视化及跨端原生音频等通用能力；</li>
                    <li>重点解决 AI 长任务状态、知识图谱重绘、长列表渲染、复杂并发及断网重连问题，通过增量更新、请求隔离和资源生命周期治理提升性能与稳定性。</li>
                    <li>针对多项目并行交付统一 TypeScript 类型、异常处理和构建规范，降低重复开发成本，并持续跟进线上问题定位与方案复盘。</li>
                </ul>
            </div>
            
            <div class="job-item">
                <div class="job-header">
                    <span class="company-name">河南蓝果网络技术有限公司</span>
                    <span class="job-date">2024.11 - 2026.03</span>
                </div>
                <div class="job-position">前端开发</div>
                <ul class="job-desc">
                    <li>独立完成多款小程序、App 的开发、自测、打包部署与客户交付。</li>
                    <li>负责全量前端项目迭代与稳定性维护，通过渲染逻辑、懒加载及缓存优化解决复杂动画和商品列表卡顿问题。</li>
                    <li>完成微信及主流应用市场证书配置、版本发布与审核问题处理，保障小程序和 App 多端版本稳定交付。</li>
                </ul>
            </div>

            <div class="job-item">
                <div class="job-header">
                    <span class="company-name">郑州新益华医学科技有限公司</span>
                    <span class="job-date">2023.07 - 2024.10</span>
                </div>
                <div class="job-position">Web前端</div>
                <ul class="job-desc">
                    <li>参与医疗 HIS 重构，负责结构化病历、门诊/住院医生站、医嘱与检验检查等核心模块，打通诊疗业务数据闭环；</li>
                    <li>主导 Webpack/SplitChunks 构建优化并参与现场部署，提升首屏性能，保障医院核心系统 7×24 小时稳定运行。</li>
                    <li>处理复杂医疗表单、表格联动、实时消息与报表打印场景，配合实施团队完成医院现场问题排查和版本更新。</li>
                </ul>
            </div>

            <div class="job-item">
                <div class="job-header">
                    <span class="company-name">安阳大玉软件科技有限公司</span>
                    <span class="job-date">2021.08 - 2023.05</span>
                </div>
                <div class="job-position">前端开发工程师</div>
                <ul class="job-desc">
                    <li>负责后台管理系统、小程序、公众号的需求分析、开发、自测和维护，完成从设计稿到上线的完整交付；</li>
                    <li>基于 Taro、uni-app 建设多端业务，以一套代码适配小程序、H5 与 App，降低重复开发和后续维护成本。</li>
                </ul>
            </div>
        </div>
      </div>

        <!-- 项目经历 -->
      <div class="resume-page page-two">
        <div class="section">
            <div class="section-title">项目经历</div>
            <div class="project-item">
                <div class="project-header">
                    <span class="project-name">卡奥斯启智咨询全链路智能体平台</span>
                    <span class="project-date">2026.06 - 2026.08</span>
                </div>
                <div class="project-tech">
                    技术栈：Vue3、TypeScript、Vite、Pinia、Vue Router、Element Plus、Axios、ECharts、AntV G6、Haier IAM、RBAC、Sass、动态路由、Gzip
                </div>
                <ul class="project-desc">
                    <li><strong>独立负责全量前端建设：</strong>交付智能体工作台、售前、招投标、项目交付、诊断评估、企业知识库等模块，串联客户分析、现场调研、方案生成、投标编制、交付与知识沉淀全链路；</li>
                    <li><strong>AI 业务落地：</strong>整合 6 类咨询技能，支持项目上下文、多会话、参数配置、长任务反馈、成果归档及报告预览导出；建设 CMMM/灯塔工厂双评估体系，实现动态问卷、进度恢复、完整性校验与 ECharts 报告；</li>
                    <li><strong>知识库建设：</strong>支持仓库、目录、标签多维筛选及文档、表格、PDF、图片批量上传，接入飞书云文档导入，并完成智能检索、收藏、订阅、下载和图文内容管理；</li>
                    <li><strong>复杂图谱治理：</strong>基于 AntV G6 实现语义分层、节点聚类、搜索联动、关系高亮与钻取；以增量更新、请求序号屏障、防抖去重和 Force Simulation 生命周期管理解决旧响应覆盖、频繁重绘与动画空转；</li>
                    <li><strong>权限与工程化：</strong>落地 IAM + RBAC 三级权限及后端菜单驱动的动态路由，通过 import.meta.glob 建立安全组件映射；封装强类型请求层，并实施懒加载、失败重试、依赖分包与 Gzip。</li>
                </ul>                                                                                                                                             
            </div>      
            <div class="project-item">
                <div class="project-header">
                    <span class="project-name">园区车位摇号派位管理系统（PassageCenter Allocation）</span>
                    <span class="project-date">2026.06 - 至今</span>
                </div>
                <div class="project-tech">技术栈：React、TypeScript、@haier/bwd-mobile、@haier/turbu-react、moment.js、CSS Modules、RESTful API、CSV/Excel 导入导出</div>
                <ul class="project-desc">
                    <li><strong>独立负责全链路前端：</strong>贯通管理端“计划创建 → 报名推送 → 排序生成 → 派位执行 → 交费推送”及员工端“申报 → 托管 → 缴费”，形成完整业务闭环；</li>
                    <li><strong>复杂业务状态：</strong>实现时间与配额联动、双数据源推送轮询、四阶段派位、五维统计、CSV/Excel 导入导出，以及移动端意向优先级、截止/付款倒计时、托管设置与双支付流程；</li>
                    <li>以表单状态机和“权限码 + 业务状态”双重约束保障操作合法性，并通过请求取消、bizId 回查、并发 Loading 计数解决竞态、状态覆盖和资源泄漏问题。</li>
                </ul>
            </div>
            <div class="project-item">
                <div class="project-header">
                    <span class="project-name">AIUI 同声传译系统</span>
                    <span class="project-date">2026.03 - 2026.06</span>
                </div>
                <div class="project-tech">技术栈：Vue3、uni-app、UTS、TypeScript、WebSocket、SD-AudioRecorder、Pinia、环形缓冲、冷热区渲染、跨平台适配</div>
                <ul class="project-desc">
                    <li><strong>核心模块 Owner：</strong>独立开发主端、共享端和语音播放引擎，打通“采集 → ASR/翻译 → WebSocket 推送 → 多端展示 → TTS 播放”实时同传链路；</li>
                    <li><strong>跨端原生音频：</strong>二次开发 UTS 插件，基于 AudioTrack/AudioRenderer 构建 PCM FIFO 播放队列与状态机，处理静音补帧、后台保活、耳返防回流及 Android/iOS/鸿蒙音频路由差异；</li>
                    <li><strong>实时播放引擎：</strong>统一封装 WebSocket 连接、PCM 队列与播放控制，支持播放、暂停、恢复、静音和清空；队列耗尽时自动补静音帧，避免音轨中断、爆音及重新初始化开销；</li>
                    <li><strong>大数据量渲染：</strong>设计“热区 50 条 + 冷区全量历史”及 Dirty Key 增量更新，Vue Diff 计算减少 90%+，支持 2000+ 段落流畅展示，并实现自动追底/手动翻阅双模式；</li>
                    <li><strong>性能与稳定性：</strong>落地 PCM 零拷贝、对象池、环形缓冲、消息批处理等 14 项优化，其中 CPU 消耗降低 62%、WebSocket send 次数减少 50%；实现重连、去重和顺序保障，支撑四端稳定运行。</li>
                </ul>
            </div>
            <div class="project-item other-projects">
                <div class="project-header">
                    <span class="project-name">其他代表项目</span>
                    <span class="project-date">2023.07 - 2026.03</span>
                </div>
                <div class="project-tech">技术栈：uni-app、Vue2、Taro、VxeTable、Element UI、iframe、单点登录（SSO）、WebSocket、Webpack、微服务、ERP、RuoYi框架</div>
                <ul class="project-desc">
                    <li><strong>聚潮box旗舰版：</strong>独立交付潮玩小程序与 App，上线一番赏、无限赏、擂台赏等互动玩法；通过懒加载、图片缓存和数据结构优化改善商品列表卡顿，并完成多端打包及应用市场发布；</li>
                    <li><strong>佰库MAX：</strong>独立实现无限赏、积分赏、福袋、农场等十余种玩法，设计玩家自制福袋、平台抽成、排队抽赏、折扣及商品权益配置，提升平台运营灵活性；</li>
                    <li><strong>OneHealth 临床一体化：</strong>使用RuoYi框架二次开发，根据项目需求去除或增加功能以适配项目需求。参与挂号、门诊/住院医生站、医嘱、结构化病历、检验检查及结算等诊疗业务建设；通过 iframe 将各子系统集成嵌入统一门户并接入单点登录，统一用户身份与访问入口；通过 WebSocket 实现医疗数据实时同步，并以 SplitChunks 优化公共依赖和首屏加载；</li>
                    <li><strong>ERP 仓储子项目：</strong>负责药品与医疗器械归库、数量及批次查验、验收确认、库位分配和上架等流程；对查验缺少的药品触发缺药事件埋点并生成待补清单，支持补充登记、差异核对和库存状态同步，形成从待验收到可用库存、缺药补录的业务闭环。</li>
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

  await page.emulateMediaType("print");
  const layout = await page.evaluate(() => {
    const measure = (selector) => {
      const element = document.querySelector(selector);
      const rect = element.getBoundingClientRect();
      const lastChildRect = element.lastElementChild.getBoundingClientRect();
      return {
        pageHeight: Math.round(rect.height),
        contentHeight: Math.round(lastChildRect.bottom - rect.top),
        scrollHeight: element.scrollHeight,
      };
    };
    return {
      firstPage: measure(".page-one"),
      secondPage: measure(".page-two"),
    };
  });
  console.log("版面高度（px）:", layout);

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
