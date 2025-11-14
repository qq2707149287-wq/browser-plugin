# Markdown内容提取器（Chrome 扩展）使用教程

> 一键提取网页核心内容为 Markdown，并支持页面内英文自动翻译、图片文字识别、选择性"抓取全站"。内置调试日志工具，方便问题排查。


## 1. 插件简介

- 插件名称：Markdown内容提取器
- 核心功能：
  - 网页内容提取为 Markdown（过滤导航/广告、保留结构与代码块）
  - 页面内英文文本翻译为中文（仅翻译文本，不改动链接/属性）
  - 网站抓取：从当前页收集可选页面，批量提取并汇总
  - 图片文字识别 + 翻译（实验性）
  - 调试日志：一键开启并自动下载翻译日志
- 适用场景：
  - 阅读英文技术文档/博客时，快速中文化
  - 批量保存站点知识库为 Markdown
  - 收集某一文档目录下的多页内容并统一导出


## 2. 安装指南

### 2.1 下载和安装

Chrome 加载"未打包扩展"步骤：

1. 下载/克隆本项目到本地：
   ```bash
   git clone https://github.com/your-username/browser-plugin.git
   cd browser-plugin
   ```

2. **配置 API 密钥（重要）**：
   - 复制 `.env.example` 文件为 `.env`：
     ```bash
     cp .env.example .env
     ```
   - 编辑 `.env` 文件，填写你的 OpenRouter API Key：
     ```
     OPENROUTER_API_KEY=your-actual-api-key-here
     ```
   - 如何获取 API Key：访问 [OpenRouter](https://openrouter.ai/keys) 注册并创建 API Key

3. 打开 Chrome，访问 `chrome://extensions/`

4. 开启右上角"开发者模式"

5. 点击"加载已解压的扩展程序"，选择 `browser-plugin` 目录

6. 安装完成后，工具栏会出现插件图标，点击即可打开弹窗

### 2.2 首次安装后的初始化

1. 点击插件图标 → "⚙️ 设置"
2. 确认 OpenRouter API Key 已配置（如果使用 .env 文件，会自动加载）
3. 选择翻译模型（可先用免费/快速模型，如 `google/gemini-2.5-flash-lite`）
4. 如需页面出现悬浮"翻译"入口，勾选"页面加载时显示翻译按钮"
5. 点击"保存设置"

**提示**：安装成功后，无需构建/打包，直接使用。

### 2.3 ⚠️ 安全提示

- **不要将 `.env` 文件提交到版本控制系统**（已在 `.gitignore` 中排除）
- **不要在公开场合分享你的 API Key**
- 如果 API Key 泄露，请立即在 [OpenRouter](https://openrouter.ai/keys) 删除并重新生成
- 建议定期检查 API 使用情况，避免意外费用


## 3. 配置说明

本插件支持两种配置方式（chrome.storage 与 .env 文件）；常用方式是通过"设置页"进行配置。

### 3.1 关键配置项

- **OPENROUTER_API_KEY**：OpenRouter API 密钥（必填）
- **TRANSLATION_MODEL**：翻译模型（设置中可下拉选择或动态刷新）
- **TRANSLATION_TEMPERATURE**：翻译温度（默认 0.2）
- **TRANSLATION_TOP_P / TRANSLATION_MAX_TOKENS**：采样/最大 tokens（可选）
- **并发与抓取参数**：最大并发标签页、最大抓取页面数、请求间隔、重试次数、提取超时

### 3.2 在"设置页"配置（推荐）

- 打开弹窗 → 点击"⚙️ 设置"进入设置页（或直接打开扩展详情里的"选项"）
- 在"翻译设置""抓取设置""内容提取设置""调试设置"等分组中逐项修改
- 点击"保存设置"生效

### 3.3 使用 .env 文件（可选）

在扩展目录根下创建 `.env` 文件（会被插件读取）。建议仅在本地开发调试时使用。

.env 示例（参考 `.env.example` 文件）：

```
# OpenRouter API 配置
OPENROUTER_API_KEY=your-api-key-here
OPENROUTER_API_URL=https://openrouter.ai/api/v1/chat/completions

# 翻译模型配置
TRANSLATION_MODEL=google/gemini-2.5-flash-lite
TRANSLATION_TEMPERATURE=0.2
TRANSLATION_TOP_P=0.95
TRANSLATION_MAX_TOKENS=1000

# 图片翻译模型配置
IMAGE_TRANSLATION_MODEL=google/gemini-2.5-flash-lite

# HTTP 请求头配置
HTTP_REFERER=https://github.com/your-username/browser-plugin
X_TITLE=Browser Plugin

# 翻译并发限制
TRANSLATION_CONCURRENCY_LIMIT=50
```


## 4. 功能使用教程

### 4.1 网页翻译功能

**入口 A：页面悬浮"大翻译按钮"**

1. 在"设置 → 翻译设置"勾选"页面加载时显示翻译按钮/显示大翻译按钮"
2. 打开任意网页，页面右下角出现"翻译"入口
3. 点击后开始翻译当前页英文文本为中文
4. 可在按钮菜单中"显示原文/还原"或切换"中英对照模式"

**入口 B：小型翻译按钮（段落/图片旁）**

1. 在"设置 → 翻译设置"勾选"显示小翻译按钮"
2. 鼠标移至段落或图片附近，出现"小译"按钮 → 点击仅翻译该段/该图

**翻译行为说明**：

- 仅翻译"文本内容"，不会修改链接的 `href`、图片的 `src` 等属性
- 支持"中英对照模式"：原文与译文并排显示
- 支持"显示原文"：一键还原所有翻译
- 翻译结果会缓存，避免重复翻译

**调试模式**：

1. 在"设置 → 调试设置"勾选"启用调试模式"
2. 翻译时会在控制台输出详细日志
3. 翻译完成后，页面右下角出现"下载日志"按钮
4. 点击下载日志文件，用于问题排查

### 4.2 内容提取功能

**提取当前页面**：

1. 打开插件弹窗，点击"提取当前页面"
2. 插件会提取页面核心内容为 Markdown
3. 提取完成后，弹窗显示 Markdown 内容
4. 可选择"复制到剪贴板"或"下载为文件"

**提取选项**：

- 在"设置 → 内容提取设置"中配置：
  - 最小内容长度：过滤过短的段落
  - 包含代码块：是否保留代码块
  - 包含图片链接：是否保留图片
  - 移除导航：是否过滤导航/广告
  - 标题样式：ATX（#）或 Setext（===）
  - 代码块样式：围栏（```）或缩进
  - 包含目录：是否生成 TOC

### 4.3 网站爬取功能

**爬取整个网站**：

1. 打开插件弹窗，点击"爬取网站"
2. 插件会扫描当前页面的所有链接
3. 在弹出的"选择页面"界面中，勾选要爬取的页面
4. 点击"开始爬取"
5. 爬取进度会实时显示
6. 爬取完成后，点击"下载结果"获取 ZIP 文件

**爬取选项**：

- 在"设置 → 抓取设置"中配置：
  - 最大并发标签页：同时打开的标签页数量
  - 最大抓取页面数：限制爬取的页面数量
  - 请求间隔：每次请求之间的延迟（毫秒）
  - 重试次数：失败后的重试次数
  - 提取超时：单个页面的提取超时时间（毫秒）

**导出语言设置**：

- 在"设置 → 翻译设置"中选择"导出语言"：
  - 原文：导出原始内容
  - 中文：导出翻译后的内容
  - 中英对照：导出双语内容

### 4.4 翻译按钮设置

在"设置 → 翻译设置"中可以控制翻译按钮的显示：

- **页面加载时显示翻译按钮**：控制是否自动显示大翻译按钮
- **显示小翻译按钮**：控制段落/图片旁的小翻译按钮
- **显示大翻译按钮**：控制页面右下角的悬浮翻译按钮

### 4.5 调试日志功能

**启用调试模式**：

1. 在"设置 → 调试设置"勾选"启用调试模式"
2. 点击"保存设置"

**下载日志文件**：

1. 翻译页面后，页面右下角出现"下载日志"按钮
2. 点击下载日志文件（格式：`translation-debug-YYYY-MM-DDTHH-mm-ss.log`）
3. 日志包含：检测到的段落、翻译请求、翻译结果、错误信息等


## 5. 常见问题解答（FAQ）

### 5.1 API 密钥配置错误

**问题**：提示"未配置 OpenRouter API 密钥"

**解决方法**：
1. 确认 `.env` 文件中的 `OPENROUTER_API_KEY` 已填写
2. 或在"设置页"中手动填写 API Key
3. 重新加载扩展：`chrome://extensions/` → 点击"重新加载"

### 5.2 翻译失败

**常见原因**：
- API Key 无效或已过期
- API 配额用尽
- 网络连接问题
- 翻译模型不可用

**解决方案**：
1. 检查 API Key 是否正确
2. 访问 [OpenRouter](https://openrouter.ai/) 检查账户余额
3. 尝试切换翻译模型（在设置中点击"刷新模型列表"）
4. 启用调试模式，查看详细错误信息

### 5.3 翻译质量问题

**问题**：翻译结果不准确或包含不应翻译的内容

**解决方法**：
1. 尝试切换翻译模型（推荐：`google/gemini-2.5-flash-lite`）
2. 调整翻译温度（降低温度可提高准确性）
3. 启用调试模式，下载日志文件，查看哪些内容被翻译
4. 如果 UI 元素被错误翻译，请反馈给开发者

### 5.4 插件不工作

**排查步骤**：
1. 确认扩展已启用：`chrome://extensions/` → 检查插件状态
2. 刷新页面后再试
3. 打开浏览器控制台（F12），查看是否有错误信息
4. 重新加载扩展：`chrome://extensions/` → 点击"重新加载"
5. 如果问题持续，尝试删除并重新安装扩展


## 6. 技术说明

### 6.1 支持的浏览器

- Chrome 88+（Manifest V3）
- Edge 88+（基于 Chromium）
- 其他基于 Chromium 的浏览器

### 6.2 依赖的外部服务

- **OpenRouter API**：用于 AI 翻译和图片识别
  - 官网：https://openrouter.ai/
  - 支持多种 AI 模型（OpenAI、Anthropic、Google 等）
  - 按使用量计费，部分模型免费

### 6.3 隐私和数据安全

- 本插件不会收集或存储用户数据
- 翻译内容会发送到 OpenRouter API 进行处理
- API Key 仅存储在本地（chrome.storage 或 .env 文件）
- 建议不要翻译包含敏感信息的页面


## 7. 开发者信息

### 7.1 项目结构

```
browser-plugin/
├── manifest.json          # 扩展清单文件
├── background.js          # 后台服务 Worker
├── content_script.js      # 内容脚本（注入到页面）
├── popup.html/js          # 弹窗界面
├── settings.html/js       # 设置页面
├── config.js              # 配置管理
├── turndown.js            # HTML 转 Markdown 库
├── .env.example           # 环境变量模板
├── .gitignore             # Git 忽略文件
├── LICENSE                # 开源协议
└── README.md              # 使用文档
```

### 7.2 如何构建和调试

本扩展无需构建步骤，直接加载即可使用。

**调试方法**：
1. 修改代码后，在 `chrome://extensions/` 点击"重新加载"
2. 打开浏览器控制台（F12）查看日志
3. 启用调试模式，下载日志文件进行分析

### 7.3 如何贡献代码

欢迎提交 Issue 和 Pull Request！

**贡献步骤**：
1. Fork 本项目
2. 创建特性分支：`git checkout -b feature/your-feature`
3. 提交更改：`git commit -m 'Add some feature'`
4. 推送到分支：`git push origin feature/your-feature`
5. 提交 Pull Request

**代码规范**：
- 使用中文注释
- 遵循现有代码风格
- 添加必要的错误处理
- 更新相关文档


## 8. 开源协议

本项目采用 [MIT License](LICENSE) 开源协议。

---

**项目地址**：https://github.com/qq2707149287-wq/browser-plugin

**问题反馈**：https://github.com/qq2707149287-wq/browser-plugin/issues

**更新日志**：查看 [Releases](https://github.com/qq2707149287-wq/browser-plugin/releases)

