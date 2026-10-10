# 🦩 模型鹈鹕智商对比平台（pelican-iq）

> **给模型一辆自行车，看看它能不能画好鹈鹕。**

同一道创作挑战——生成一段可运行的「鹈鹕骑自行车」单文件 HTML 动画——定时发给多个 LLM，把每次生成的结果推送到画廊里，横向浏览、直观比较。画面之外，调用协议、思考过程、耗时与 token 用量也一并记录在案。

**自部署、单机运行、无构建步骤。**

| | |
| --- | --- |
| 技术栈 | Node.js ≥ 20.9 · Express · better-sqlite3（SQLite）· 原生前端（HTML/CSS/JS） |
| 启动方式 | `npm start`（无编译、无 Docker、无外部数据库） |
| 支持协议 | OpenAI Chat · OpenAI Responses · Anthropic Messages |
| 数据存储 | 单个 SQLite 文件（`data/pelican-iq.db`，已 gitignore） |

---

## 目录

- [功能一览](#功能一览)
- [快速开始](#快速开始)
- [使用指南](#使用指南)
- [目录结构](#目录结构)
- [环境变量](#环境变量)
- [API 参考](#api-参考)
- [调度与流式策略](#调度与流式策略)
- [安全设计](#安全设计)
- [常见问题](#常见问题)

---

## 功能一览

### 🖼️ 前台画廊（`/`）

- **按分组一行展示**（仿 jiji.cc Pelican 页布局）：左侧分组信息栏 + 模型切换标签（全部 / 各模型 ID），右侧横向滚动的紧凑样本卡片条，行尾「加载更多」
- **实时生成卡片**：模型生成时行首出现蓝色高亮「⟳ 正在生成」卡片（旋转图标 + 已输出字符数，2 秒刷新）；点击可查看本次提示词与流式输出的实时内容（含思考过程）；完成后自动被新样本卡片接替
- **倒计时徽标**：静止卡片右上角显示下次生成倒计时（⏳ N 分钟后）
- **详情弹层**：预览 / 源码 / 提示词三个 Tab，支持下载 HTML、复制源码；检测到外部资源引用时显示警告横幅
- **人工评分**：8 项检查清单（喙与喉囊、身体结构、车轮、车架、踩踏同步、循环衔接、无外部依赖、自适应），勾选即保存，卡片显示 ✓ N/8
- **视觉基准行**：画廊第一行为「视觉基准（参考实现）」——移植自 [PelicanBench](../PelicanBench) 的三套手写参考动画（海岸 / 黄昏 / 夜路），作为人工对照的标准答案，不参与调度
- 每 15 秒自动轮询刷新，新样本无感出现

### 🛠️ 后台管理（`/admin`）

- **模型管理**：按分组聚合展示（一组一行，显示模型数、启用数、下次生成时间），可展开操作子模型；支持整组「全部运行」「编辑」「删除」
- **新增模型（三步式）**：连接上游（协议 + Base URL + API Key）→ 获取模型列表（调用上游 `GET /models`，可多选）→ 逐个配置（思考强度、生成间隔、保留样本数、排序、启用）后批量创建
- **Base URL 历史**：保存后自动记录，下次可下拉选取；支持删除历史条目
- **连通性测试**：每行「测试」按钮 / 编辑弹层「测试连接」——发送一句话探测，成功显示耗时与回复，失败显示上游错误；不写库、不消耗保留额度
- **提示词管理**：自定义提示词 CRUD，可按模型指派；删除被引用的提示词时模型自动回退默认题目
- **运行概览**：模型数量、样本统计、调度状态一览
- **生成日志**：实时显示生成中的流式正文与思考内容（逐块累积、自动跟随滚动、上翻不打扰），完成后显示耗时与 token；1 秒轮询、DOM 就地更新；仅保留最新 50 条（内存环形缓冲，重启清空）

---

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
#    编辑 .env，至少设置 ADMIN_PASSWORD 与 SESSION_SECRET

# 3.（可选）写入演示数据——无 API Key 也能先看画廊效果
npm run seed

# 4. 启动
npm start
```

启动后：

| 地址 | 说明 |
| --- | --- |
| `http://localhost:3000/` | 前台画廊 |
| `http://localhost:3000/admin` | 后台管理（用 `ADMIN_PASSWORD` 登录） |
| `http://localhost:3000/api/health` | 健康检查 |

> 端口由 `.env` 中的 `PORT` 控制，默认 3000。

---

## 使用指南

### 第一次跑起来

1. 打开 `/admin` 登录
2. 「新增模型」：
   - 选择协议（openai-chat / openai-responses / anthropic）
   - 填写 Base URL（如 `https://api.example.com/v1`）与 API Key
   - 点击「获取模型列表」→ 勾选要接入的模型 ID
   - 为每个模型设置生成间隔（分钟）、保留样本数等，提交即批量创建
3. 保存后调度器自动按间隔生成；也可在模型管理中点「立即运行」手动触发
4. 打开 `/` 查看画廊——每个分组一行，模型生成时行首出现实时卡片

### 分组规则

**模型的「名称」字段即分组**：名称相同的模型在画廊与模型管理中归为一行，行内通过模型切换标签区分各模型 ID。无需单独建分组表。

### 评分怎么用

详情弹层中的 8 项检查清单是人工对照标准——点开卡片、看动画、逐项勾选。勾选即保存（无需登录），卡片上会显示 `✓ N/8`，方便快速横向比较各模型的完成度。

---

## 目录结构

```
pelican-iq/
├── src/
│   ├── server.js          # Express 入口：静态文件 + API 路由 + 启动调度器
│   ├── db.js              # SQLite 初始化、建表、数据访问（API Key 永不回传明文）
│   ├── llm-client.js      # 模型调用：三种协议、SSE 流式、思考强度、token 解析、失败重试
│   ├── scheduler.js       # 定时调度器：30s tick、串行执行、样本裁剪
│   ├── auth.js            # 管理端口令登录 + HMAC 签名 Cookie 会话
│   ├── extract.js         # HTML 提取 / 预览 CSP 注入 / 外链检测
│   ├── gen-log.js         # 内存环形缓冲的实时生成日志（50 条）
│   ├── prompt.js          # 标准创作挑战题目（默认提示词）
│   └── reference-html.js  # 手写参考动画（视觉基准行）
├── public/                # 前台画廊与后台管理（原生 HTML/CSS/JS，无构建）
│   ├── index.html / gallery.js / styles.css
│   └── admin.html / admin.js
├── scripts/seed-demo.js   # 演示数据
└── data/                  # SQLite 数据库（已 gitignore）
```

## 数据模型

| 表 | 内容 |
| --- | --- |
| `models` | 模型配置：协议、Base URL、API Key、模型 ID、思考强度、生成间隔、保留样本数（默认 10）、启用、排序、lastRunAt / nextRunAt |
| `results` | 每次生成的样本：动画 HTML、协议、思考强度、prompt、输入/输出/总 token、耗时、成功/失败、错误信息、外部引用、检查清单勾选 |
| `prompts` | 自定义提示词（`models.prompt_id` 外键引用，删除时置空回退默认） |
| `admin_logs` | 管理操作日志 |

---

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `PORT` | 否 | `3000` | 服务端口 |
| `ADMIN_PASSWORD` | **是** | — | 管理后台登录口令（≥ 4 字符，请用高强度随机值） |
| `SESSION_SECRET` | 建议 | — | 会话签名密钥（`openssl rand -hex 32` 生成；未设置时重启后所有会话失效） |
| `GENERATION_TIMEOUT_MS` | 否 | `600000` | 单次生成总超时（10 分钟）。思考型模型推理慢可调大 |

---

## API 参考

### 公开接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/gallery` | 画廊数据（按分组/模型聚合，不含 baseUrl 与 Key） |
| GET | `/api/results/:id` | 单个样本详情 |
| GET | `/api/results/:id/preview` | 注入 CSP 的沙箱预览 |
| POST | `/api/results/:id/checklist` | 保存检查清单勾选 |
| GET | `/api/live` | 实时生成状态（前台轮询） |

### 管理接口（需 Cookie 会话）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/login` / `logout` | 登录 / 登出 |
| GET | `/api/admin/session` | 会话状态 |
| GET / POST | `/api/admin/models` | 模型列表 / 新增 |
| PUT / DELETE | `/api/admin/models/:id` | 编辑 / 删除模型 |
| POST | `/api/admin/models-bulk` | 批量新增模型 |
| PUT | `/api/admin/models-group` | 整组批量编辑 |
| POST | `/api/admin/models/:id/run` | 立即生成一次 |
| POST | `/api/admin/fetch-models` | 从上游拉取模型列表 |
| POST | `/api/admin/test-model` | 连通性测试 |
| GET / DELETE | `/api/admin/base-url-history` | Base URL 历史 |
| GET / POST / PUT / DELETE | `/api/admin/prompts(/:id)` | 提示词 CRUD |
| GET | `/api/admin/gen-logs` | 实时生成日志 |
| GET | `/api/admin/overview` | 运行概览 |

---

## 调度与流式策略

- **调度**：每 30 秒 tick，扫描 `enabled=1` 且到期的模型，**串行执行**（避免并发打爆上游）；同一模型运行中加锁，手动「立即运行」与调度共用执行路径，不会重复触发
- **失败也留痕**：无论成败都写入 results，失败样本在画廊以灰色卡片呈现；每次运行后 `next_run_at = now + interval`
- **流式优先（绕过网关超时）**：
  - OpenAI Chat 协议默认直接走 SSE 流式——数据持续流动，nginx 等网关不会判空闲超时；若网关不支持流式（400）自动退回非流式并记住该网关
  - Anthropic / Responses 协议非流式优先，遇 502/503/504 自动切换流式重试，成功后记忆
  - 三种协议的流式响应均可解析，token 用量通过 `stream_options` / 事件中的 usage 获取
- **max_tokens 自适应**：默认 32000，上游报错时自动降档重试
- **样本裁剪**：每模型只保留最新 `retention` 条（默认 10，可设 1–500），生成后自动裁剪，启动时清扫历史积压
- **重启恢复**：服务重启后 3 秒内先跑一次 tick，处理停机期间积压的到期任务

---

## 安全设计

- **API Key 只存服务端**：明文存于本机 SQLite（单机自部署场景），任何接口都不回传明文，列表只显示掩码（`sk-f***3456`），错误信息中的 Key 同样脱敏
- **沙箱预览**：动画运行在 `sandbox="allow-scripts"` 的 iframe 中，注入 CSP 禁止外链（`default-src 'none'`）——模型生成的代码无法访问本站数据或外网资源
- **会话安全**：HttpOnly + SameSite=Strict 签名 Cookie，12 小时有效；口令比较使用 timing-safe
- **输入限制**：请求体长度上限，防滥用
- 生产部署请置于 HTTPS 反向代理之后

---

## 常见问题

**Q：网关 504 超时怎么办？**
平台对 OpenAI Chat 协议默认走流式，多数网关超时问题已自动规避；仍超时可调大 `GENERATION_TIMEOUT_MS`。

**Q：思考型模型输出很慢 / 被截断？**
思考内容会单独提取保存（详情页可查看）；`max_tokens` 会自动降档重试，仍不够可在模型设置中调整思考强度。

**Q：不想每次都生成，只想看效果？**
`npm run seed` 写入演示数据即可离线浏览画廊。

**Q：数据存在哪里？怎么备份？**
全部在 `data/pelican-iq.db` 一个文件里，直接复制该文件即完成备份。

---

## 特别感谢

<img src="https://cdn3.ldstatic.com/original/3X/9/7/97ed5d6d97f4c7f3dc0670d097bf457527c375f5.png" alt="linuxDoLogo" width="150" />

感谢 [Linux DO 社区](https://linux.do/)提供交流和支持。
