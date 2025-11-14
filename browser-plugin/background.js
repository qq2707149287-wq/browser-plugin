/*
 * 这是插件的后台脚本，“总指挥部”。
 * V3.3更新：增强内容提取稳定性，添加超时处理和错误恢复机制
 */

// 导入配置模块
import { DEFAULT_CONFIG } from './config.js';

// ===== 配置管理 =====
// 全局配置对象，在 Service Worker 启动时加载
let CONFIG = DEFAULT_CONFIG;  // 先使用默认配置
let configInitialized = false;  // 标记配置是否已初始化

/**
 * 初始化配置
 * 从 chrome.storage 加载配置，如果不存在则使用默认值
 */
async function initializeConfig() {
  try {
    CONFIG = await new Promise((resolve) => {
      chrome.storage.sync.get(DEFAULT_CONFIG, (result) => {
        resolve(result || DEFAULT_CONFIG);
      });
    });

    configInitialized = true;
    console.log('✅ 配置已加载，API密钥:', CONFIG.OPENROUTER_API_KEY ? '已配置' : '未配置');
  } catch (error) {
    console.error('❌ 配置加载失败:', error);
    CONFIG = DEFAULT_CONFIG;
    configInitialized = true;
  }
}

// Service Worker 启动时初始化配置
initializeConfig();

// --- 状态管理 ---
let state = {
  status: 'idle', // idle, crawling, cancelled, finished
  queue: [],
  processed: new Set(),
  markdown: "",
  total: 0,
  processedCount: 0,
  currentUrl: "",
  availableLinks: [],
  // 目录 => { pages: [{ url, title, content }], order }
  groupedResults: {},
  // 是否存在历史抓取结果，用于控制“清除并重新抓取”
  hasPreviousResult: false,
  // 当前站点名（用于文件命名）
  siteName: ''
};

// 翻译任务状态管理
let translationState = {
  isTranslating: false,
  translationQueue: [],
  translationCount: 0,
  completedCount: 0,
  failedCount: 0
};

// 高效翻译状态管理
let efficientTranslationState = {
  isTranslating: false,
  batchQueue: [],
  cache: null, // 延迟初始化Map
  concurrentLimit: 50, // 并发限制到50个请求，以最大化翻译速度
  activeCount: 0
};

// 确保翻译缓存被正确初始化
function ensureTranslationCache() {
  if (!efficientTranslationState.cache) {
    efficientTranslationState.cache = new Map();
  }
  return efficientTranslationState.cache;
}

// 提取当前页面内容的函数
async function extractCurrentPageContent(tabId) {
  console.log('开始提取当前页面内容，标签页ID:', tabId);

  try {
    // 在目标标签页中执行内容提取脚本
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['turndown.js', 'content_script.js']
    });

    console.log('内容脚本执行完成，结果:', results);

    // 主动通知内容脚本开始提取，避免仅注入不触发的问题
    chrome.tabs.sendMessage(tabId, { action: 'extractCurrentPage' }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('向内容脚本发送提取指令失败（可能脚本尚未就绪）:', chrome.runtime.lastError.message);
        return;
      }
      if (response && response.success && response.content) {
        console.log('直接收到内容脚本返回的提取结果，长度:', response.content.length);
        chrome.runtime.sendMessage({
          action: 'extractionResult',
          content: response.content,
          length: response.content.length,
          ctrlClick: false
        });
      }
    });
  } catch (error) {
    console.error('提取当前页面内容时出错:', error);
    // 发送错误消息到popup
    chrome.runtime.sendMessage({
      action: 'extractionError',
      error: error.message
    });
  }
}

// ===== 新的抓取与选择逻辑（替代直接全站抓取） =====
// 从当前页面采集可用链接
async function gatherLinksInPage(tabId, crawlDepth = '2') {
  console.log('开始从页面采集链接用于用户选择，tabId:', tabId, 'crawlDepth:', crawlDepth);
  try {
    // 调试：记录将要在其上执行采集脚本的标签页信息
    try {
      const tabInfo = await chrome.tabs.get(tabId);
      console.log('gatherLinksInPage: 目标标签信息 => id:', tabInfo.id, 'url:', tabInfo.url, 'active:', tabInfo.active);
    } catch (e) {
      console.warn('gatherLinksInPage: 获取标签信息失败:', e?.message || e);
    }

    const [{ result: links }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (depthParam) => {
        // 在页面上下文执行：根据指定的目录深度收集同源链接
        // 示例：
        //   当前页: /oss/python/langchain/quickstart
        //   depth=2: 允许 /oss/python/integrations/providers/overview (前两级: oss/python 相同)
        //   depth=3: 允许 /oss/python/langchain/integrations/... (前三级: oss/python/langchain 相同)
        //   full: 允许相同完整路径的子页面

        // 修复：排除 crawl-progress.html 注入的内容，只从原始页面提取链接
        // 首先尝试从 document.body 获取，如果失败则从 document.documentElement 获取
        let searchRoot = document.body;
        if (!searchRoot) {
          searchRoot = document.documentElement;
        }

        // 排除 crawl-progress.html 相关的容器
        const excludeSelectors = [
          '#crawl-progress-container',
          '[data-crawl-progress]',
          'iframe[src*="crawl-progress"]'
        ];

        let anchors = Array.from(searchRoot.querySelectorAll('a[href]'));

        // 过滤掉来自 crawl-progress.html 的链接
        anchors = anchors.filter(a => {
          for (const selector of excludeSelectors) {
            if (a.closest(selector)) {
              return false;
            }
          }
          return true;
        });

        console.log(`原始找到 ${anchors.length} 个链接（已排除 crawl-progress 相关链接）`);
        const origin = location.origin;
        const currentUrl = new URL(location.href);
        const currentParts = currentUrl.pathname.split('/').filter(Boolean);
        // 输出示例链接，便于定位过滤过严的问题
        const sampleHrefs = anchors.slice(0, 10).map(a => a.getAttribute('href'));
        console.log('示例前10个原始href:', sampleHrefs);

        // 根据深度参数计算基础目录
        let baseDepth;
        let baseKey = '';

        if (depthParam === 'full') {
          // 完整路径匹配模式
          baseDepth = currentParts.length;
          baseKey = currentParts.join('/');
        } else {
          // 固定深度模式
          const depth = parseInt(depthParam) || 2;
          baseDepth = Math.min(depth, currentParts.length);
          baseKey = baseDepth > 0 ? currentParts.slice(0, baseDepth).join('/') : '';
        }
        console.log('过滤参数 => depthParam:', depthParam, 'baseDepth:', baseDepth, 'baseKey:', baseKey, 'current:', currentUrl.pathname);

        const out = new Set();

        for (const a of anchors) {
          try {
            const raw = a.getAttribute('href');
            if (!raw) continue;

            const href = new URL(raw, currentUrl).href;

            // 过滤无效协议
            if (href.startsWith('mailto:') || href.startsWith('javascript:')) continue;

            // 要求同源
            if (!href.startsWith(origin)) continue;

            const cleanHref = href.split('#')[0];

            // 解析路径并按指定深度过滤
            const linkParts = new URL(cleanHref).pathname.split('/').filter(Boolean);

            if (depthParam === 'full') {
              // 完整路径模式：要求链接路径必须包含当前完整路径
              if (currentParts.length === 0) {
                // 当前在根路径，只允许其他根路径页面
                if (linkParts.length > 0) continue;
              } else {
                // 要求链接路径以当前完整路径开头
                const linkPathPrefix = linkParts.slice(0, currentParts.length).join('/');
                if (linkPathPrefix !== baseKey) continue;
              }
            } else {
              // 固定深度模式
              if (baseKey) {
                if (linkParts.length < baseDepth) continue;
                const linkKey = linkParts.slice(0, baseDepth).join('/');
                if (linkKey !== baseKey) continue;
              }
            }

            out.add(cleanHref);
          } catch (e) {
            // 单个链接错误直接跳过，保持整体简洁稳定
          }
        }

        // 如果全部被过滤且仍然没有结果，回退为“同源 + 非 mailto/javascript”的链接集合（放宽条件）
        if (out.size === 0) {
          const fallback = [];
          for (const a of anchors) {
            const raw = a.getAttribute('href');
            if (!raw) continue;
            let href = '';
            try { href = new URL(raw, currentUrl).href; } catch (_) { continue; }
            if (href.startsWith('mailto:') || href.startsWith('javascript:')) continue;
            if (!href.startsWith(origin)) continue; // 仍然保持同源
            const clean = href.split('#')[0];
            fallback.push(clean);
          }
          const uniqueFallback = Array.from(new Set(fallback));
          console.warn('所有链接被严格条件过滤，启用回退策略。同源候选数量:', uniqueFallback.length);
          return uniqueFallback.slice(0, 200);
        }

        // 限制数量，避免过多页面导致浏览器压力过大
        return Array.from(out).slice(0, 500);
      },
      args: [crawlDepth]
    });
    console.log('采集到链接数量:', links.length);
    if (links.length === 0) {
      console.warn('⚠️ 警告：未采集到任何链接，可能原因：');
      console.warn('1. 页面中没有有效的同源链接');
      console.warn('2. 页面被 crawl-progress.html 或其他内容覆盖');
      console.warn('3. 链接过滤条件过于严格');
    } else {
      console.log('示例前5条链接:', links.slice(0, 5));
    }
    state.availableLinks = links;
    console.log('gatherLinksInPage: 将 state.availableLinks 设置为长度', links.length);
    return links;
  } catch (err) {
    console.error('采集链接失败:', err);
    console.error('错误详情:', err.message, err.stack);
    return [];
  }
}

// 向popup展示链接选择器
async function showLinkSelectorUI(message = '请选择要提取的页面') {
  try {
    chrome.runtime.sendMessage({ action: 'showLinkSelector', links: state.availableLinks || [], message });
  } catch (e) {
    console.warn('发送链接选择器消息失败:', e);
  }
}

 // 启动选中链接的抓取（顺序处理，稳定为先）
async function startCrawlingSelectedLinks(links) {
  const uniqueLinks = Array.from(new Set(links || []));
  console.log('启动选中链接抓取，数量:', uniqueLinks.length);
  console.log('选中的链接:', uniqueLinks);

  if (!uniqueLinks.length) {
    console.warn('startCrawlingSelectedLinks: 未收到选中的链接列表，直接返回');
    return;
  }

  // 重置状态
  state.status = 'crawling';
  state.queue = [...uniqueLinks];
  state.total = state.queue.length;
  state.processed = new Set();
  state.processedCount = 0;
  state.markdown = '';
  state.currentUrl = '';
  state.groupedResults = {};
  state.availableLinks = [];

  // 记录队列中的所有链接
  console.log('队列初始化完成，总数:', state.total);
  console.log('队列内容:', state.queue);

  // 获取网站名称用于导出文件名
  try {
    const url = new URL(state.queue[0]);
    state.siteName = url.hostname.replace('www.', '');
  } catch (e) {
    state.siteName = 'website';
  }

  // 添加导出文件头
  const now = new Date().toLocaleString('zh-CN');
  state.markdown = `# ${state.siteName} - 全站内容\n\n**抓取时间**: ${now}\n**页面数量**: ${state.total}\n\n---\n\n`;

  // 打开进度展示页（独立标签页）
  chrome.tabs.create({ url: chrome.runtime.getURL('crawl-progress.html') });

  // 通知所有前端（包括 popup / crawl-progress.html）当前状态
  updatePopupState('开始处理选中的页面...');

  // 延迟一点时间再开始处理，确保进度页面已加载
  setTimeout(() => {
    // 发送抓取开始的状态更新
    try {
      chrome.runtime.sendMessage({
        action: 'crawlStatusUpdate',
        type: 'info',
        message: `开始抓取 ${state.total} 个页面...`,
        processedCount: 0,
        total: state.total
      });
    } catch (e) {
      console.warn('发送初始状态更新失败:', e);
    }

    processQueue();
  }, 1000);
}

// 处理队列
async function processQueue() {
  console.log('processQueue 被调用，状态:', state.status, '队列长度:', state.queue ? state.queue.length : 0);

  if (state.status !== 'crawling') {
    console.log('状态不是 crawling，退出处理');
    return;
  }

  if (!state.queue || state.queue.length === 0) {
    console.log('队列处理完成');
    state.status = 'finished';
    state.processedCount = state.total;
    console.log('最终处理统计: 总数', state.total, '已完成', state.processedCount);

    // 将结果保存，供进度页 / popup 下载
    try {
      chrome.storage.local.set({ finalMarkdown: state.markdown });
      console.log('最终 Markdown 已保存，长度:', state.markdown.length);
    } catch (e) {
      console.warn('保存最终 Markdown 失败:', e);
    }

    // 通知所有页面抓取完成（crawl-progress.html 会展示最终结果）
    try {
      chrome.runtime.sendMessage({
        action: 'crawlFinished',
        state,
        content: state.markdown,
        groupedResults: state.groupedResults || {}
      });
      console.log('已发送 crawlFinished 消息');
    } catch (e) {
      console.warn('发送 crawlFinished 消息失败:', e);
    }

    updatePopupState('抓取完成');
    return;
  }

  const url = state.queue.shift();
  const currentCount = state.total - state.queue.length;
  state.currentUrl = url;
  state.processedCount = currentCount;

  console.log(`处理第 ${currentCount}/${state.total} 个页面: ${url}`);
  console.log('剩余队列长度:', state.queue.length);

  updatePopupState(`抓取中(${currentCount}/${state.total}): ${url}`);

  // 通知进度页面当前进度
  try {
      chrome.runtime.sendMessage({
          action: 'crawlProgress',
          state,
          currentUrl: state.currentUrl
      });
  } catch (e) {
      console.warn('发送 crawlProgress 消息失败:', e);
  }

  try {
    console.log('开始提取页面内容:', url);
    await openTabAndExtract(url);
    console.log('页面内容提取完成:', url);
  } catch (e) {
    console.error('打开并提取失败:', url, e);
  }

  // 继续处理下一条
  console.log('准备处理下一个页面...');
  await processQueue();
}

let crawlTabIds = new Set();

// 打开一个后台标签并提取内容（带有效性检查）
async function openTabAndExtract(url) {
  return new Promise((resolve) => {
    chrome.tabs.create({ url, active: false }, (tab) => {
      if (chrome.runtime.lastError || !tab || typeof tab.id !== 'number') {
        console.warn('创建抓取标签失败:', chrome.runtime.lastError);
        resolve();
        return;
      }

      const tabId = tab.id;
      crawlTabIds.add(tabId);
      let timeoutId;
      let resolved = false;

      // 监听本次提取结果，仅处理当前 tab 的完成/失败回调，避免跨页串扰
      const onExtractionMsg = (request, sender) => {
        if (!sender || !sender.tab || sender.tab.id !== tabId) return;
        if (request && (request.action === 'extractionCompleted' || request.action === 'extractionError')) {
          cleanup();
        }
      };

      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        chrome.runtime.onMessage.removeListener(onExtractionMsg);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        if (timeoutId) clearTimeout(timeoutId);
        crawlTabIds.delete(tabId);

        // 在关闭/查询前检查 service worker 是否仍然存活
        if (!chrome.runtime || !chrome.runtime.id) {
          resolve();
          return;
        }

        // 在关闭前检查标签页是否仍然存在
        chrome.tabs.get(tabId, (t) => {
          if (!chrome.runtime.lastError && t) {
            chrome.tabs.remove(tabId, () => {
              // 即使这里报错也只记录，不再抛出，避免 "No tab with id" 未捕获异常
              if (chrome.runtime.lastError) {
                console.warn('关闭抓取标签失败(可能已被关闭):', chrome.runtime.lastError.message);
              }
              resolve();
            });
          } else {
            // 如果 tab 已不存在，直接结束
            resolve();
          }
        });
      };

      const onUpdated = (updatedTabId, info) => {
        if (updatedTabId !== tabId || info.status !== 'complete') {
          return;
        }

        // service worker 已失效则直接清理
        if (!chrome.runtime || !chrome.runtime.id) {
          cleanup();
          return;
        }

        // 再次确认标签存在
        chrome.tabs.get(tabId, (t) => {
          if (chrome.runtime.lastError || !t) {
            cleanup();
            return;
          }

          // 注入提取脚本
          chrome.scripting.executeScript({
            target: { tabId },
            files: ['turndown.js', 'content_script.js']
          }, () => {
            if (chrome.runtime.lastError) {
              console.warn('注入内容脚本失败:', chrome.runtime.lastError.message);
              cleanup();
              return;
            }

            // 发送提取指令前确认 content_script 通道
            chrome.tabs.sendMessage(tabId, { action: 'extractCurrentPage' }, () => {
              if (chrome.runtime.lastError) {
                console.warn('向内容脚本发送提取指令失败:', chrome.runtime.lastError.message);
                cleanup();
                return;
              }

              // 等待 content_script 通过 extractionCompleted 回调，或超时清理
              timeoutId = setTimeout(() => {
                console.warn('抓取标签超时，执行清理:', tabId);

                // 超时也认为是提取失败，需要更新进度
                if (state.status === 'crawling') {
                  state.processedCount++;
                  updatePopupState(`页面超时，已跳过(${state.processedCount}/${state.total}): ${state.currentUrl}`);
                }
                cleanup();
              }, 15000);
            });
          });
        });
      };

      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.runtime.onMessage.addListener(onExtractionMsg);

    });
  });
}

// 停止抓取
function stopCrawling() {
  console.log('停止抓取');
  state.status = 'cancelled';
  state.queue = [];
  updatePopupState('已取消抓取');

  // 关闭仍在使用的抓取标签
  crawlTabIds.forEach((tabId) => {
    if (!chrome.runtime || !chrome.runtime.id) {
      return;
    }
    chrome.tabs.get(tabId, (t) => {
      if (!chrome.runtime.lastError && t) {
        chrome.tabs.remove(tabId, () => {
          if (chrome.runtime.lastError) {
            console.warn('停止抓取时关闭标签失败(可能已被关闭):', chrome.runtime.lastError.message);
          }
        });
      }
    });
  });
  crawlTabIds.clear();

  chrome.runtime.sendMessage({
    action: 'crawlFinished',
    state,
    content: state.markdown || ''
  });
}

function updatePopupState(message) {
  try {
    chrome.runtime.sendMessage({ action: 'updateState', state, message });
  } catch (e) {
    console.warn('更新状态失败:', e);
  }
}

// 验证翻译结果，过滤掉异常内容
function validateTranslation(translation, originalText) {
  // 过滤掉常见的异常内容
  const anomalies = [
    'placeholder',
    'translation:',
    'translating',
    'This is a placeholder',
    'Please provide',
    'get_user_location',
    'omplex',
    'role:',
    'content:',
    'user:',
    'system:'
  ];

  // 检查是否包含异常内容
  for (const anomaly of anomalies) {
    if (translation.toLowerCase().includes(anomaly.toLowerCase())) {
      console.warn('⚠️ 检测到异常翻译内容，可能是 API 返回错误:', translation.substring(0, 100));
      // 如果包含异常内容，返回原文作为备选
      return originalText;
    }
  }

  return translation;
}

// 检查是否为 HTML 内容
function isHtmlContent(text) {
  return /<[a-z][\s\S]*>/i.test(text);
}

// 验证 HTML 结构完整性
function validateHtmlStructure(html) {
  // 简单的 HTML 验证：检查是否有未闭合的标签
  const openTags = (html.match(/<[a-z][^>]*>/gi) || []).length;
  const closeTags = (html.match(/<\/[a-z][^>]*>/gi) || []).length;
  const selfClosing = (html.match(/<[a-z][^>]*\/>/gi) || []).length;

  // 允许一定的不匹配（因为可能是片段）
  return Math.abs(openTags - closeTags - selfClosing) <= 2;
}

// 诊断 API 配置
function diagnoseApiConfig() {
  const diagnostics = {
    hasApiKey: !!CONFIG.OPENROUTER_API_KEY,
    apiKeyLength: CONFIG.OPENROUTER_API_KEY ? CONFIG.OPENROUTER_API_KEY.length : 0,
    apiKeyPrefix: CONFIG.OPENROUTER_API_KEY ? CONFIG.OPENROUTER_API_KEY.substring(0, 10) + '...' : 'N/A',
    apiUrl: CONFIG.OPENROUTER_API_URL,
    translationModel: CONFIG.TRANSLATION_MODEL,
    temperature: CONFIG.TRANSLATION_TEMPERATURE,
    topP: CONFIG.TRANSLATION_TOP_P,
    maxTokens: CONFIG.TRANSLATION_MAX_TOKENS
  };
  console.log('🔍 API 配置诊断:', diagnostics);
  return diagnostics;
}

// 添加处理句子翻译的函数（支持 HTML 和纯文本）
async function translateSentence(text, targetLanguage = 'Chinese', isHtml = false) {
  const contentType = isHtml ? 'HTML' : '文本';
  console.log(`开始翻译${contentType} -> ${targetLanguage}:`, text.substring(0, 50) + '...');

  try {
    // 从配置中获取 API 密钥
    const apiKey = CONFIG.OPENROUTER_API_KEY;
    if (!apiKey) {
      const diag = diagnoseApiConfig();
      throw new Error('未配置 OpenRouter API 密钥');
    }

    // 根据内容类型选择不同的 system prompt
    let systemPrompt;
    if (isHtml) {
      systemPrompt = `You are a professional HTML-aware translator. Your task is to translate HTML content to ${targetLanguage}.

CRITICAL RULES - FOLLOW STRICTLY:
1. Input will be HTML code with text content
2. Translate ONLY the text content inside HTML tags to ${targetLanguage}
3. Preserve ALL HTML tags, attributes, classes, IDs, href links, and styles EXACTLY as they are
4. Do NOT translate: URLs, email addresses, code snippets, class names, IDs, data attributes
5. Do NOT add, remove, or modify any HTML tags or attributes
6. Maintain the exact same HTML structure and formatting
7. Output ONLY the translated HTML - no explanations, no additional text
8. For mixed-language content, translate only the non-${targetLanguage} parts

Example:
Input: <a href="/link" class="btn">Click here</a> to continue.
Output: <a href="/link" class="btn">点击这里</a> 继续。

OUTPUT FORMAT: Pure HTML with translated text, preserving all original tags and attributes.`;
    } else {
      systemPrompt = `You are a professional translator specializing in accurate, natural translations. Your task is to translate text to ${targetLanguage}.

CRITICAL RULES - FOLLOW STRICTLY:
1. Output ONLY the translated text in ${targetLanguage} - nothing else
2. Do NOT include explanations, notes, metadata, or any commentary
3. Do NOT include the original text or any reference to it
4. Do NOT include phrases like "translation:", "translating", "placeholder", "here is", "the translation is"
5. Preserve ALL formatting: parentheses (), brackets [], braces {}, punctuation marks, line breaks
6. Preserve code blocks, URLs, email addresses, and technical terms exactly as they appear
7. For mixed-language content (e.g., "English text (中文)"), translate only the non-${targetLanguage} parts
8. Keep numbers, special characters, and symbols unchanged
9. Maintain proper spacing and punctuation in the target language
10. If text contains code or technical content, preserve it exactly and only translate comments/strings

OUTPUT FORMAT: Pure translated text only, no additional content whatsoever.`;
    }

    const requestBody = {
      model: CONFIG.TRANSLATION_MODEL,
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: isHtml
            ? `Translate this HTML to ${targetLanguage}: ${text}`
            : `Translate this text to ${targetLanguage}: ${text}`
        }
      ],
      temperature: CONFIG.TRANSLATION_TEMPERATURE,
      top_p: CONFIG.TRANSLATION_TOP_P,
      max_tokens: CONFIG.TRANSLATION_MAX_TOKENS
    };

    let response;
    try {
      response = await fetch(CONFIG.OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': CONFIG.HTTP_REFERER,
          'X-Title': CONFIG.X_TITLE
        },
        body: JSON.stringify(requestBody)
      });
    } catch (fetchError) {
      console.error(`❌ ${contentType}翻译网络错误:`, {
        message: fetchError.message,
        stack: fetchError.stack,
        apiUrl: CONFIG.OPENROUTER_API_URL,
        textPreview: text.substring(0, 100)
      });
      throw new Error(`网络请求失败: ${fetchError.message}`);
    }

    if (!response.ok) {
      let errorText = '';
      try {
        errorText = await response.text();
      } catch (e) {
        errorText = '无法读取错误响应';
      }

      console.error(`❌ ${contentType}翻译 API 错误:`, {
        status: response.status,
        statusText: response.statusText,
        errorResponse: errorText,
        textPreview: text.substring(0, 100),
        apiUrl: CONFIG.OPENROUTER_API_URL
      });

      throw new Error(`API请求失败 (${response.status}): ${errorText.substring(0, 200)}`);
    }

    let data;
    try {
      data = await response.json();
    } catch (parseError) {
      console.error(`❌ ${contentType}翻译 JSON 解析错误:`, {
        message: parseError.message,
        responseText: await response.text(),
        textPreview: text.substring(0, 100)
      });
      throw new Error(`响应解析失败: ${parseError.message}`);
    }

    let translation = data.choices?.[0]?.message?.content?.trim();

    if (!translation) {
      console.error(`❌ ${contentType}翻译结果为空:`, {
        fullResponse: JSON.stringify(data).substring(0, 500),
        textPreview: text.substring(0, 100)
      });
      throw new Error('翻译结果为空');
    }

    // 验证翻译结果
    if (isHtml) {
      // HTML 翻译需要验证结构完整性
      if (!validateHtmlStructure(translation)) {
        console.warn('⚠️ 翻译后的 HTML 结构可能不完整，回退到原文', {
          translation: translation.substring(0, 100),
          textPreview: text.substring(0, 100)
        });
        return text;
      }
    } else {
      // 纯文本翻译需要验证内容
      translation = validateTranslation(translation, text);
    }

    console.log(`✅ ${contentType}翻译成功:`, translation.substring(0, 50) + '...');
    return translation;
  } catch (error) {
    console.error(`❌ ${contentType}翻译失败 - 完整错误信息:`, {
      message: error.message,
      stack: error.stack,
      textPreview: text.substring(0, 100),
      targetLanguage: targetLanguage,
      isHtml: isHtml
    });
    throw error;
  }
}

// 添加并发控制的翻译函数（按目标语言区分缓存）
async function translateSentenceWithConcurrency(text, targetLanguage = 'Chinese', isHtml = false) {
  const cache = ensureTranslationCache();
  const key = `${targetLanguage}::${isHtml ? 'HTML' : 'TEXT'}::${text}`;  // 缓存键包含 HTML 标志
  if (cache.has(key)) {
    console.log(`💾 从缓存获取翻译 (${isHtml ? 'HTML' : '文本'})`);
    return cache.get(key);
  }

  while (efficientTranslationState.activeCount >= efficientTranslationState.concurrentLimit) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  efficientTranslationState.activeCount++;
  try {
    const result = await translateSentence(text, targetLanguage, isHtml);  // 传递 isHtml 参数
    cache.set(key, result);
    return result;
  } finally {
    efficientTranslationState.activeCount--;
  }
}

// 图片翻译函数 - 识别图片中的文字并翻译
async function translateImage(imageUrl) {
  console.log('开始翻译图片:', imageUrl);

  try {
    // 获取图片数据
    let imageData;
    try {
      const response = await fetch(imageUrl);
      if (!response.ok) throw new Error(`获取图片失败: ${response.status}`);
      const blob = await response.blob();
      imageData = await blobToBase64(blob);
    } catch (error) {
      console.error('获取图片数据失败:', error);
      throw new Error('无法获取图片数据');
    }

    // 从配置中获取 API 密钥
    const apiKey = CONFIG.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('未配置 OpenRouter API 密钥');

    // 调用 Gemini 识别图片中的文字
    const recognitionRequest = {
      model: CONFIG.IMAGE_RECOGNITION_MODEL,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "请识别这张图片中的所有文字内容，并按照原始位置和格式列出。如果有多行文字，请按行列出。"
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: imageData.split(',')[1]
              }
            }
          ]
        }
      ],
      temperature: CONFIG.TRANSLATION_TEMPERATURE,
      max_tokens: CONFIG.IMAGE_RECOGNITION_MAX_TOKENS
    };

    const recognitionResponse = await fetch(CONFIG.OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': CONFIG.HTTP_REFERER,
        'X-Title': CONFIG.X_TITLE
      },
      body: JSON.stringify(recognitionRequest)
    });

    if (!recognitionResponse.ok) {
      const errorText = await recognitionResponse.text();
      throw new Error(`文字识别失败: ${recognitionResponse.status} ${errorText}`);
    }

    const recognitionData = await recognitionResponse.json();
    const recognizedText = recognitionData.choices?.[0]?.message?.content?.trim();

    if (!recognizedText) {
      throw new Error('未识别到文字内容');
    }

    console.log('识别到的文字:', recognizedText.substring(0, 100) + '...');

    // 翻译识别到的文字
    const translationRequest = {
      model: CONFIG.TRANSLATION_MODEL,
      messages: [
        {
          role: "system",
          content: "You are a professional translator. Translate the user's text to Chinese. Only output the translated text, no explanations."
        },
        {
          role: "user",
          content: recognizedText
        }
      ],
      temperature: CONFIG.TRANSLATION_TEMPERATURE,
      top_p: CONFIG.TRANSLATION_TOP_P,
      max_tokens: CONFIG.IMAGE_RECOGNITION_MAX_TOKENS
    };

    const translationResponse = await fetch(CONFIG.OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': CONFIG.HTTP_REFERER,
        'X-Title': CONFIG.X_TITLE
      },
      body: JSON.stringify(translationRequest)
    });

    if (!translationResponse.ok) {
      const errorText = await translationResponse.text();
      throw new Error(`翻译失败: ${translationResponse.status} ${errorText}`);
    }

    const translationData = await translationResponse.json();
    const translatedText = translationData.choices?.[0]?.message?.content?.trim();

    if (!translatedText) {
      throw new Error('翻译结果为空');
    }

    console.log('翻译完成:', translatedText.substring(0, 100) + '...');

    // 在图片上绘制翻译文字
    const translatedImageUrl = await drawTranslatedTextOnImage(imageUrl, translatedText);

    return {
      success: true,
      translatedImageUrl: translatedImageUrl,
      recognizedText: recognizedText,
      translatedText: translatedText
    };
  } catch (error) {
    console.error('图片翻译失败:', error);
    throw error;
  }
}

// 将Blob转换为Base64
async function blobToBase64(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return 'data:' + blob.type + ';base64,' + btoa(binary);
}

// 在图片上绘制翻译文字（由content_script处理，这里只返回翻译数据）
async function drawTranslatedTextOnImage(imageUrl, translatedText) {
  // 返回包含翻译信息的数据URL，由content_script负责在Canvas上绘制
  // 这里使用一个特殊的格式标记，content_script会识别并处理
  return `data:application/json;base64,${btoa(JSON.stringify({
    type: 'translatedImage',
    imageUrl: imageUrl,
    translatedText: translatedText,
    timestamp: Date.now()
  }))}`;
}

// --- 消息监听器 ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('收到消息:', request.action, '来自:', sender.url);

  if (request.action === 'translateSentence') {
    const target = request.targetLanguage || 'Chinese';
    const isHtml = request.isHtml || false;  // 获取 isHtml 标志

    console.log(`📝 处理翻译请求 (${isHtml ? 'HTML' : '文本'}):`, {
      textPreview: (request.text || '').substring(0, 100),
      textLength: request.text ? request.text.length : 0,
      targetLanguage: target,
      isHtml: isHtml
    });

    translateSentenceWithConcurrency(request.text, target, isHtml)
      .then(translation => {
        console.log(`✅ 翻译成功，返回结果:`, {
          translationPreview: translation.substring(0, 100),
          translationLength: translation.length
        });
        sendResponse({ success: true, translation });
      })
      .catch(error => {
        console.error('❌ 翻译失败 - 完整错误:', {
          message: error.message,
          stack: error.stack,
          textPreview: (request.text || '').substring(0, 100),
          targetLanguage: target,
          isHtml: isHtml
        });
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (request.action === 'translateImage') {
    translateImage(request.imageUrl)
      .then(result => {
        sendResponse({ success: true, translatedImageUrl: result.translatedImageUrl });
      })
      .catch(error => {
        console.error('图片翻译失败:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (request.action === 'diagnoseTranslation') {
    // 诊断翻译问题
    const diagnostics = diagnoseApiConfig();
    console.log('📋 诊断翻译问题:', diagnostics);
    sendResponse({ success: true, diagnostics });
    return true;
  }

  if (request.action === 'getConfig') {
    console.log('获取配置请求');
    // 等待配置初始化完成
    const waitForConfig = async () => {
      let attempts = 0;
      while (!configInitialized && attempts < 50) {
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
      }
      console.log('配置已返回，API密钥:', CONFIG.OPENROUTER_API_KEY ? '已配置' : '未配置');
      sendResponse(CONFIG);
    };
    waitForConfig();
    return true;
  }

  try {
    switch (request.action) {
    case 'extractionCompleted':
      // 收到content_script的提取结果
      console.log('处理extractionCompleted消息，长度:', request.result ? request.result.length : 0);

      if (request.result && request.result.length > 0) {
        const url = request.url || state.currentUrl || '';
        const rawContent = request.result;

        if (state.status === 'crawling') {
          // 批量抓取模式：按"目录维度"分组记录结果 + 累积总 Markdown
          let groupKey = 'root';
          try {
            const pageUrl = new URL(url);
            const pathParts = pageUrl.pathname.split('/').filter(Boolean);

            if (pathParts.length === 0) {
              groupKey = 'root';
            } else if (pathParts.length === 1) {
              // 单段路径：按该段作为目录
              groupKey = pathParts[0];
            } else {
              // 多段路径：使用前两段作为目录，如 /docs/guide/... => docs-guide
              groupKey = `${pathParts[0]}-${pathParts[1]}`;
            }
          } catch (e) {
            groupKey = 'other';
          }

          if (!state.groupedResults[groupKey]) {
            state.groupedResults[groupKey] = {
              pages: [],
              order: Object.keys(state.groupedResults).length
            };
          }

          const pageTitle = request.pageTitle ||
            (() => {
              try {
                const u = new URL(url);
                const segs = u.pathname.split('/').filter(Boolean);
                return segs[segs.length - 1] || u.hostname || '未命名页面';
              } catch {
                return '未命名页面';
              }
            })();

          state.groupedResults[groupKey].pages.push({
            url,
            title: pageTitle,
            content: rawContent
          });

          // 保持整合文件，方便"导出全部"
          state.markdown += `## ${pageTitle}\n\n**来源**: ${url}\n\n${rawContent}\n\n---\n\n`;
          state.processedCount++;
          updatePopupState(`已处理(${state.processedCount}/${state.total}): ${url}`);
          state.hasPreviousResult = true;

          // 发送详细状态更新到进度页面
          try {
            chrome.runtime.sendMessage({
              action: 'crawlStatusUpdate',
              type: 'success',
              url: url,
              title: pageTitle,
              processedCount: state.processedCount,
              total: state.total
            });
          } catch (e) {
            console.warn('发送成功状态更新失败:', e);
          }

        } else {
          // 单页模式：根据导出语言设置处理
          chrome.storage.sync.get({ exportLanguage: 'original' }, async (settings) => {
            let content = rawContent;

            if (settings.exportLanguage === 'english') {
              content = content
                .split('\n')
                .filter(line => /[A-Za-z]/.test(line) && !/[\u4e00-\u9fff]/.test(line))
                .join('\n');
            } else if (settings.exportLanguage === 'chinese') {
              // 将包含英文的行翻译为中文后与已有中文行一起输出
              const lines = rawContent.split('\n');
              const chineseLines = [];
              const toTranslate = [];

              for (const line of lines) {
                const hasZh = /[\u4e00-\u9fff]/.test(line);
                const hasEn = /[A-Za-z]/.test(line);
                if (hasZh && !hasEn) {
                  chineseLines.push(line);
                } else if (hasEn) {
                  toTranslate.push(line);
                }
              }

              if (toTranslate.length) {
                const translated = [];
                for (const segment of toTranslate) {
                  try {
                    const t = await translateSentence(segment);
                    translated.push(t);
                  } catch {
                    // 失败则跳过该行，避免中断整体流程
                  }
                }
                content = [...chineseLines, ...translated].join('\n');
              } else {
                content = chineseLines.join('\n');
              }
            }

            chrome.runtime.sendMessage({
              action: 'extractionResult',
              content,
              length: content.length,
              ctrlClick: request.ctrlClick || false
            }, (response) => {
              if (chrome.runtime.lastError) {
                console.warn('发送提取结果消息失败:', chrome.runtime.lastError.message);
              }
            });
          });
        }
      } else {
        console.log('提取结果为空');
        chrome.runtime.sendMessage({
          action: 'extractionError',
          error: request.error || '未提取到内容'
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn('发送提取错误消息失败:', chrome.runtime.lastError.message);
          }
        });
      }
      sendResponse({ status: 'received' });
      break;

    case 'extractionError':
      console.log('处理extractionError消息:', request.error);
      console.error('内容提取错误:', request.error, 'URL:', request.url);

      // 如果是批量抓取流程的一部分
      if (state.status === 'crawling') {
        console.log('处理批量抓取错误');
        state.errors = state.errors || [];
        state.errors.push({ url: request.url || state.currentUrl, error: request.error });

        // 即使失败也要更新进度
        state.processedCount++;
        updatePopupState(`页面提取失败，已跳过(${state.processedCount}/${state.total}): ${request.url || state.currentUrl}`);

        // 发送详细状态更新到进度页面
        try {
          chrome.runtime.sendMessage({
            action: 'crawlStatusUpdate',
            type: 'error',
            url: request.url || state.currentUrl,
            error: request.error,
            processedCount: state.processedCount,
            total: state.total
          });
        } catch (e) {
          console.warn('发送错误状态更新失败:', e);
        }

      }

      // 直达popup
      chrome.runtime.sendMessage({ action: 'extractionError', error: request.error || '提取失败' });
      sendResponse({ status: 'received' });
      break;

    case 'getConfig':
      // 返回当前配置给 content_script
      sendResponse(CONFIG);
      break;

    case 'gatherLinks':
      console.log('收集页面链接:', request.tabId, 'crawlDepth:', request.crawlDepth);

      // 每次链接收集前清理与上次选择相关的缓存，确保可以重复抓取（问题3修复的一部分）
      state.availableLinks = [];

      // 使用请求中的crawlDepth参数，默认为'2'
      const crawlDepth = request.crawlDepth || '2';
      gatherLinksInPage(request.tabId, crawlDepth).then(links => {
        // 无论是否重复抓取，都基于当前页面实时扫描
        console.log('gatherLinks: 即将返回给popup的链接数量:', (links || []).length);
        sendResponse({ success: true, links: links });
      }).catch(error => {
        console.error('gatherLinks: 采集发生错误:', error);
        sendResponse({ success: false, error: error.message });
      });
      return true;

    case 'startCrawling':
      console.log('开始网站抓取（改为链接选择模式）:', request.tabId);

      // 如果已有历史结果且当前不在抓取中，提示前端可选择清除并重新抓取
      if (state.hasPreviousResult && state.status !== 'crawling') {
        sendResponse({
          status: 'has_previous',
          message: '已存在历史抓取结果，如继续将覆盖之前的数据。'
        });
        return true;
      }

      // 每次新的抓取流程都重置抓取状态，保证重复抓取不受上次影响（问题3修复）
      state.status = 'idle';
      state.queue = [];
      state.processed = new Set();
      state.total = 0;
      state.processedCount = 0;
      state.markdown = '';
      state.groupedResults = {};
      state.availableLinks = [];

      gatherLinksInPage(request.tabId).then(() => {
        showLinkSelectorUI('开始抓取...请选择要提取的页面');
      });
      sendResponse({ status: 'ok' });
      break;
    case 'stopCrawling':
      stopCrawling();
      sendResponse({ status: 'ok' });
      break;
    case 'startCrawlingSelected':
      console.log('开始抓取选定链接:', request.selectedLinks);

      // 每次从用户确认的选择开始抓取时，清理中间状态，允许覆盖旧抓取结果
      state.status = 'idle';
      state.queue = [];
      state.processed = new Set();
      state.total = 0;
      state.processedCount = 0;
      state.markdown = '';
      state.groupedResults = {};
      state.availableLinks = [];

      startCrawlingSelectedLinks(request.selectedLinks);
      sendResponse({ status: 'ok' });
      return true;
    case 'crawlProgressPageReady':
      // 进度页发来就绪通知，记录并回复，避免页面端报错
      console.log('收到 crawl-progress 就绪通知，tabId:', sender?.tab?.id || 'N/A');
      sendResponse({ status: 'ok' });
      return true;
    // 以下旧指令在当前代码中未实现具体函数，直接返回错误，避免产生
    // "Receiving end does not exist" / "No tab with id" 等异常日志干扰
    case 'downloadAllMarkdown':
      console.warn('downloadAllMarkdown 动作已废弃或未实现');
      sendResponse({ status: 'error', error: 'downloadAllMarkdown 未实现' });
      return true;
    case 'getStatus': // Popup打开时会请求当前状态
      console.log('获取抓取状态');
      sendResponse(state);
      break;
    case 'extractCurrentPage':
      console.log('提取当前页面:', request.tabId);
      if (typeof request.tabId === 'number') {
        extractCurrentPageContent(request.tabId);
        sendResponse({ status: 'ok' });
      } else {
        // 未显式传入 tabId 时，自动获取当前活动标签，避免无效 ID
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (chrome.runtime.lastError || !tabs || !tabs.length) {
            console.error('获取当前活动标签失败:', chrome.runtime.lastError);
            sendResponse({ status: 'error', error: '无法获取当前页面标签' });
          } else {
            extractCurrentPageContent(tabs[0].id);
            sendResponse({ status: 'ok', tabId: tabs[0].id });
          }
        });
      }
      return true;
    case 'ctrlClickLink':
      // 处理Ctrl+左键点击链接（当前未提供实现，返回明确错误而非静默失败）
      console.warn('ctrlClickLink 动作未实现');
      sendResponse({ status: 'error', error: 'ctrlClickLink 未实现' });
      return true;
    case 'startTranslation':
      console.warn('startBackgroundTranslation 未实现，忽略请求');
      sendResponse({ status: 'error', error: 'startBackgroundTranslation 未实现' });
      return true;
    case 'startBatchTranslation':
      console.warn('startBatchTranslation 未实现，忽略请求');
      sendResponse({ status: 'error', error: 'startBatchTranslation 未实现' });
      return true;
    case 'stopTranslation':
      console.warn('stopBackgroundTranslation 未实现，忽略请求');
      sendResponse({ status: 'error', error: 'stopBackgroundTranslation 未实现' });
      return true;
    case 'getTranslationStatus':
      console.log('获取翻译状态');
      sendResponse(translationState);
      break;
    case 'getEfficientTranslationStatus':
      console.log('获取高效翻译状态');
      sendResponse(efficientTranslationState);
      return true;
    case 'clearTranslationCache':
      console.log('清理翻译缓存');
      const cache = ensureTranslationCache();
      cache.clear();
      sendResponse({ status: 'ok', message: '缓存已清理' });
      return true;
    case 'exportCrawlingReport':
      console.warn('exportCrawlingReport 未实现，忽略请求');
      sendResponse({ status: 'error', error: 'exportCrawlingReport 未实现' });
      return true;
    default:
      console.warn('未知的消息类型:', request.action);
      sendResponse({ status: 'unknown_action' });
      break;
    }
  } catch (error) {
    console.error('消息处理错误:', error);
    sendResponse({ status: 'error', error: error.message });
  }

  // 默认同步结束监听，表示无异步响应
  return false;
});
