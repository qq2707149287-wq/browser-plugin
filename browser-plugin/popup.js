document.addEventListener('DOMContentLoaded', () => {

  const extractButton = document.getElementById('extractButton');
  const crawlButton = document.getElementById('crawlButton');
  const downloadButton = document.getElementById('downloadButton');
  const previewButton = document.getElementById('previewButton');
  const formatButton = document.getElementById('formatButton');
  const settingsButton = document.getElementById('settingsButton');
  const statusArea = document.getElementById('statusArea');
  const markdownOutput = document.getElementById('markdownOutput');
  const tabsArea = document.getElementById('tabsArea');
  const tabsScroll = document.getElementById('tabsScroll');

  const ctrlClickPreviewButton = document.getElementById('ctrlClickPreviewButton');

  const settingsPanel = document.getElementById('settingsPanel');
  const closeSettingsBtn = document.getElementById('closeSettingsBtn');
  const bilingualModeCheckbox = document.getElementById('bilingual-mode');
  const exportLanguageRadios = document.querySelectorAll('input[name="export-language"]');
  const crawlDepthSelect = document.getElementById('crawlDepth');

  // 多页面结果缓存与标签页状态
  let currentTabId;
  let extractionTimeout;
  let crawledPages = [];      // { id, title, url, content, timestamp }
  let activePageId = null;

  // 初始化设置
  function initializeSettings() {
    console.log('初始化设置...');
    console.log('bilingualModeCheckbox:', bilingualModeCheckbox);
    console.log('exportLanguageRadios:', exportLanguageRadios);

    chrome.storage.sync.get({
      bilingualMode: false,
      exportLanguage: 'original'
    }, (items) => {
      console.log('从存储获取设置:', items);
      if (bilingualModeCheckbox) {
        bilingualModeCheckbox.checked = items.bilingualMode;
      }
      const radioBtn = document.getElementById(`export-lang-${items.exportLanguage}`);
      if (radioBtn) {
        radioBtn.checked = true;
      }
    });
  }

  // 保存设置
  function saveSettings() {
    console.log('保存设置...');
    const bilingualMode = bilingualModeCheckbox.checked;
    const exportLanguage = document.querySelector('input[name="export-language"]:checked').value;
    console.log('保存: bilingualMode=', bilingualMode, ', exportLanguage=', exportLanguage);

    chrome.storage.sync.set({
      bilingualMode: bilingualMode,
      exportLanguage: exportLanguage
    });
  }

  // 设置面板事件处理
  if (settingsButton) {
    settingsButton.addEventListener('click', () => {
      console.log('点击设置按钮');
      settingsPanel.classList.toggle('show');
      console.log('设置面板显示状态:', settingsPanel.classList.contains('show'));
    });
  }

  if (closeSettingsBtn) {
    closeSettingsBtn.addEventListener('click', () => {
      console.log('点击关闭设置按钮');
      settingsPanel.classList.remove('show');
    });
  }

  if (bilingualModeCheckbox) {
    bilingualModeCheckbox.addEventListener('change', saveSettings);
  }

  exportLanguageRadios.forEach(radio => {
    radio.addEventListener('change', saveSettings);
  });

  // 初始化设置
  initializeSettings();

  // ========== 标签页渲染与管理 ==========

  function ensureTabsAreaVisible(hasContent) {
    if (hasContent) {
      if (tabsArea) tabsArea.style.display = 'block';
      markdownOutput.style.display = 'block';
      document.body.classList.add('expanded');
    } else {
      if (tabsArea) tabsArea.style.display = 'none';
      markdownOutput.style.display = 'none';
    }
  }

  function renderTabs() {
    if (!tabsScroll) return;
    tabsScroll.innerHTML = '';

    crawledPages.forEach((page) => {
      const tab = document.createElement('div');
      tab.className = 'tab' + (page.id === activePageId ? ' active' : '');
      tab.dataset.id = page.id;

      const titleSpan = document.createElement('span');
      titleSpan.className = 'tab-title';
      const maxLen = 18;
      const baseTitle = page.title || page.url || '未命名页面';
      titleSpan.textContent =
        baseTitle.length > maxLen ? baseTitle.slice(0, maxLen - 1) + '…' : baseTitle;

      const closeSpan = document.createElement('span');
      closeSpan.className = 'tab-close';
      closeSpan.textContent = '✕';

      tab.appendChild(titleSpan);
      tab.appendChild(closeSpan);
      tabsScroll.appendChild(tab);

      tab.addEventListener('click', (e) => {
        if (e.target === closeSpan) {
          e.stopPropagation();
          closeTab(page.id);
        } else {
          activateTab(page.id);
        }
      });
    });

    ensureTabsAreaVisible(crawledPages.length > 0);
  }

  function activateTab(id) {
    const page = crawledPages.find(p => p.id === id);
    if (!page) {
      if (crawledPages.length > 0) {
        activePageId = crawledPages[0].id;
        return activateTab(activePageId);
      }
      activePageId = null;
      ensureTabsAreaVisible(false);
      return;
    }

    activePageId = id;
    if (markdownOutput) {
      markdownOutput.value = page.content || '';
      markdownOutput.style.display = 'block';
    }
    renderTabs();
  }

  function closeTab(id) {
    const idx = crawledPages.findIndex(p => p.id === id);
    if (idx === -1) return;
    crawledPages.splice(idx, 1);

    if (activePageId === id) {
      if (crawledPages.length > 0) {
        activePageId = crawledPages[Math.max(0, idx - 1)].id;
      } else {
        activePageId = null;
      }
    }
    renderTabs();
  }

  function upsertPage({ id, title, url, content }) {
    const ts = new Date().toLocaleString('zh-CN');
    const existing = crawledPages.find(p => p.id === id || p.url === url);
    if (existing) {
      existing.title = title || existing.title;
      existing.url = url || existing.url;
      existing.content = content != null ? content : existing.content;
      existing.timestamp = ts;
      activePageId = existing.id;
    } else {
      const pageId = id || ('page-' + (crawledPages.length + 1));
      crawledPages.push({
        id: pageId,
        title: title || url || '未命名页面',
        url: url || '',
        content: content || '',
        timestamp: ts
      });
      activePageId = pageId;
    }
    renderTabs();
  }

  function syncFromGroupedResults(groupedResults, fallbackContent) {
    crawledPages = [];
    if (groupedResults && typeof groupedResults === 'object') {
      Object.keys(groupedResults).forEach((key) => {
        const group = groupedResults[key];
        if (!group || !Array.isArray(group.pages)) return;
        group.pages.forEach((p, index) => {
          if (!p || !p.content) return;
          const id = `${key || 'group'}-${index}-${Math.random().toString(36).slice(2, 6)}`;
          crawledPages.push({
            id,
            title: p.title || p.url || '未命名页面',
            url: p.url || '',
            content: p.content,
            timestamp: new Date().toLocaleString('zh-CN')
          });
        });
      });
    }

    if (!crawledPages.length && fallbackContent) {
      crawledPages.push({
        id: 'merged-all',
        title: '全部内容',
        url: '',
        content: fallbackContent,
        timestamp: new Date().toLocaleString('zh-CN')
      });
    }

    if (crawledPages.length) {
      activePageId = crawledPages[0].id;
      ensureTabsAreaVisible(true);
      activateTab(activePageId);
    } else {
      activePageId = null;
      ensureTabsAreaVisible(false);
    }
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  function buildSafeName(base) {
    return (base || 'page')
      .toString()
      .replace(/[\\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, '-')
      .slice(0, 80) || 'page';
  }

  function updateUI(state, message, request) {
    if (!state) return;

    // 保存设置面板的显示状态
    const settingsPanelWasVisible = settingsPanel.classList.contains('show');

    switch (state.status) {
      case 'finished':
        extractButton.disabled = false;
        crawlButton.disabled = false;
        crawlButton.textContent = '🌐 抓取全站';
        crawlButton.classList.remove('stop-button');
        downloadButton.disabled = false;
        previewButton.disabled = false;
        formatButton.disabled = false;
        if (request && request.content && request.content.length > 0) {
          markdownOutput.value = request.content;
          markdownOutput.style.display = 'block';
          const charCount = request.content.length;
          const lineCount = request.content.split('\n').length;
          statusArea.textContent = message || `抓取完成！共 ${charCount} 字符，${lineCount} 行内容。`;
          chrome.storage.local.set({ finalMarkdown: request.content });
        } else {
          chrome.storage.local.get('finalMarkdown', ({ finalMarkdown }) => {
            if (finalMarkdown && finalMarkdown.length > 0) {
              markdownOutput.value = finalMarkdown;
              markdownOutput.style.display = 'block';
              const charCount = finalMarkdown.length;
              const lineCount = finalMarkdown.split('\n').length;
              statusArea.textContent = `抓取完成！共 ${charCount} 字符，${lineCount} 行内容。`;
            } else {
              statusArea.textContent = message || `抓取完成，但内容为空。`;
            }
          });
        }
        // 抓取完成后保持放大状态
        document.body.classList.add('expanded');
        break;
      case 'idle':
      case 'cancelled':
      default:
        extractButton.disabled = false;
        crawlButton.disabled = false;
        crawlButton.textContent = '🌐 抓取全站';
        crawlButton.classList.remove('stop-button');
        statusArea.textContent = message || '请选择操作...';
        chrome.storage.local.get('finalMarkdown', ({ finalMarkdown }) => {
            downloadButton.disabled = !(finalMarkdown && finalMarkdown.length > 0);
            previewButton.disabled = !(finalMarkdown && finalMarkdown.length > 0);
            formatButton.disabled = !(finalMarkdown && finalMarkdown.length > 0);
        });
        // 空闲状态时检查是否需要收缩
        if (markdownOutput.style.display === 'none') {
          document.body.classList.remove('expanded');
        }
        break;
    }

    // 恢复设置面板的显示状态
    if (settingsPanelWasVisible) {
      settingsPanel.classList.add('show');
    }
  }


  




  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'extractionResult') {
      console.log('popup收到提取结果:', request.length, '字符');

      const content = request.content || '';
      const url = request.url || '';
      const title = request.pageTitle || document.title || '当前页面';
      upsertPage({
        id: 'single-page',
        title,
        url,
        content
      });
      // 立即激活并显示新增的标签内容
      activateTab(activePageId);

      const lines = content.split('\n').length;
      if (request.ctrlClick) {
        statusArea.textContent = `Ctrl+左键点击提取完成 (${content.length}字符, ${lines}行)!`;
        if (ctrlClickPreviewButton) {
          ctrlClickPreviewButton.style.display = 'inline-block';
        }
      } else {
        statusArea.textContent = `当前页面提取完成 (${content.length}字符, ${lines}行)!`;
        if (ctrlClickPreviewButton) {
          ctrlClickPreviewButton.style.display = 'none';
        }
      }

      if (extractionTimeout) {
        clearTimeout(extractionTimeout);
        extractionTimeout = null;
      }

      extractButton.disabled = false;
      crawlButton.disabled = false;
      downloadButton.disabled = false;
      previewButton.disabled = false;
      formatButton.disabled = false;
    } else if (request.action === 'extractionError') {
      console.log('popup收到提取错误:', request.error);
      statusArea.textContent = `错误：${request.error}`;
      extractButton.disabled = false;
      crawlButton.disabled = false;
      previewButton.disabled = true;
      formatButton.disabled = true;
      if (extractionTimeout) {
        clearTimeout(extractionTimeout);
        extractionTimeout = null;
      }
      if (ctrlClickPreviewButton) {
        ctrlClickPreviewButton.style.display = 'none';
      }

    } else if (request.action === 'updateState') {
      updateUI(request.state, request.message, request);
    } else if (request.action === 'crawlFinished') {
      // 当 background 主动推送 crawlFinished 给 popup 时，同步多页面结构
      const grouped = request.groupedResults || request.state?.groupedResults;
      const merged = request.content || '';
      syncFromGroupedResults(grouped, merged);
    }
    sendResponse({ status: 'received' });
    return true;
  });

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length > 0) currentTabId = tabs[0].id;
    chrome.runtime.sendMessage({ action: "getStatus" }, (state) => {
      if (chrome.runtime.lastError) {
        console.warn('获取状态失败:', chrome.runtime.lastError.message);
        return;
      }
      updateUI(state);
    });
  });

  // 修改提取当前页的点击事件
  extractButton.addEventListener('click', () => {
    statusArea.textContent = '正在提取当前页...';
    extractButton.disabled = true;
    crawlButton.disabled = true;
    previewButton.disabled = true;
    formatButton.disabled = true;
    downloadButton.disabled = true;

    // 设置超时保护
    extractionTimeout = setTimeout(() => {
      statusArea.textContent = '提取超时，请重试';
      extractButton.disabled = false;
      crawlButton.disabled = false;
      previewButton.disabled = false;
      formatButton.disabled = false;
      downloadButton.disabled = false;
    }, 30000);

    console.log('popup: 向 background 发送 extractCurrentPage，请求tabId:', currentTabId);
    chrome.runtime.sendMessage({
        action: 'extractCurrentPage',
        tabId: currentTabId
    }, (response) => {
        clearTimeout(extractionTimeout);
        if (chrome.runtime.lastError) {
            console.error('发送消息错误:', chrome.runtime.lastError);
            statusArea.textContent = '提取失败：' + chrome.runtime.lastError.message;
            extractButton.disabled = false;
            crawlButton.disabled = false;
            previewButton.disabled = false;
            formatButton.disabled = false;
            downloadButton.disabled = false;
        } else {
            console.log('提取请求已发送，等待结果...');
        }
    });
  });

  // 修改提取全站的点击事件（支持“清除并重新抓取”）
  crawlButton.addEventListener('click', async () => {
    if (!crawlButton.textContent.includes('抓取全站')) {
      // 当前为“停止抓取”状态
      chrome.runtime.sendMessage({ action: 'stopCrawling' }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('停止抓取失败:', chrome.runtime.lastError.message);
        }
      });
      crawlButton.textContent = '🌐 抓取全站';
      crawlButton.classList.remove('stop-button');
      statusArea.textContent = '正在停止抓取...';
      return;
    }

    statusArea.textContent = '正在检查抓取状态...';
    crawlButton.disabled = true;

    // 先询问 background 是否已有历史结果
    chrome.runtime.sendMessage({ action: 'startCrawling', tabId: currentTabId }, (resp) => {
      if (chrome.runtime.lastError) {
        console.error('启动全站抓取失败:', chrome.runtime.lastError);
        statusArea.textContent = '启动全站抓取失败: ' + chrome.runtime.lastError.message;
        crawlButton.disabled = false;
        return;
      }

      // 若有历史记录，提示用户“清除并重新抓取”
      if (resp && resp.status === 'has_previous') {
        const confirmReset = confirm('已存在历史全站抓取结果，是否清除并重新抓取？');
        if (!confirmReset) {
          statusArea.textContent = '已取消重新抓取';
          crawlButton.disabled = false;
          return;
        }
        // 用户确认后再次发送 startCrawling，这次 background 会按覆盖模式继续
        chrome.runtime.sendMessage({ action: 'startCrawling', tabId: currentTabId }, () => {
          if (chrome.runtime.lastError) {
            console.error('重新启动全站抓取失败:', chrome.runtime.lastError);
            statusArea.textContent = '重新启动全站抓取失败: ' + chrome.runtime.lastError.message;
            crawlButton.disabled = false;
            return;
          }
          // 然后正常执行链接采集流程
          requestAndShowPageSelection();
        });
      } else {
        // 无历史结果，直接进入链接采集流程
        requestAndShowPageSelection();
      }
    });

    function requestAndShowPageSelection() {
      statusArea.textContent = '正在获取页面列表...';

      // 获取目录深度设置
      const crawlDepth = crawlDepthSelect ? crawlDepthSelect.value : '2';
      
      // 若当前活动标签是扩展页（如 crawl-progress.html），改为选取当前窗口中的网页标签进行采集
      chrome.tabs.get(currentTabId, (tab) => {
        const isExtensionPage = !!(tab && tab.url && tab.url.startsWith('chrome-extension://'));
        if (isExtensionPage) {
          console.warn('当前活动标签为扩展页，尝试定位网页标签进行链接采集');
          chrome.tabs.query({ currentWindow: true, url: ['http://*/*', 'https://*/*'] }, (tabs) => {
            if (chrome.runtime.lastError) {
              console.error('查询网页标签失败:', chrome.runtime.lastError);
              statusArea.textContent = '获取页面列表失败: ' + chrome.runtime.lastError.message;
              crawlButton.disabled = false;
              return;
            }
            const target = (tabs && tabs.length) ? (tabs.find(t => t.active) || tabs[0]) : null;
            if (!target) {
              statusArea.textContent = '请在要抓取的网站标签页中点击“抓取全站”';
              crawlButton.disabled = false;
              return;
            }
            doGather(target.id);
          });
        } else {
          doGather(currentTabId);
        }
      });

      function doGather(targetTabId) {
        console.log('使用 tabId 进行链接采集:', targetTabId, 'crawlDepth:', crawlDepth);
        chrome.runtime.sendMessage({
          action: 'gatherLinks',
          tabId: targetTabId,
          crawlDepth: crawlDepth
        }, (response) => {
          crawlButton.disabled = false;

          if (chrome.runtime.lastError) {
            console.error('获取页面列表失败:', chrome.runtime.lastError);
            statusArea.textContent = '获取页面列表失败: ' + chrome.runtime.lastError.message;
            return;
          }

          if (!response || !response.links || response.links.length === 0) {
            console.warn('未找到可抓取的页面，gatherLinks返回:', response);
            statusArea.textContent = '未找到可抓取的页面';
            return;
          }

          console.log('准备在页面内显示选择界面，链接数量:', response.links.length, 'tabId:', targetTabId);
          // 通知目标网页标签，由 content_script 在页面内渲染选择模态框
          chrome.tabs.sendMessage(targetTabId, {
            action: 'showPageSelection',
            links: response.links
          }, () => {
            if (chrome.runtime.lastError) {
              console.warn('发送 showPageSelection 到内容脚本失败:', chrome.runtime.lastError.message);
              statusArea.textContent = '无法在页面中显示选择窗口，请确认已注入内容脚本';
            } else {
              statusArea.textContent = '请在页面中选择要抓取的页面...';
              // 关闭 popup，交由页面内模态 + crawl-progress 显示流程
              window.close();
            }
          });
        });
      }
    }
  });



  // 下载按钮：当前标签/全部
  downloadButton.addEventListener('click', () => {
    if (!crawledPages.length) {
      statusArea.textContent = '没有内容可下载';
      return;
    }

    if (!activePageId || crawledPages.length === 1) {
      const page = crawledPages[0];
      const nameBase = buildSafeName(page.title || page.url || 'page');
      downloadText(`${nameBase}.md`, page.content || '');
      statusArea.textContent = '已下载当前页面内容';
      return;
    }

    // 多页面时，优先下载当前标签页
    const active = crawledPages.find(p => p.id === activePageId) || crawledPages[0];
    const base = buildSafeName(active.title || active.url || 'page');
    downloadText(`${base}.md`, active.content || '');
    statusArea.textContent = '已下载当前标签页内容';
  });

  // 预览按钮：使用当前激活标签页内容

  previewButton.addEventListener('click', () => {
    const page = crawledPages.find(p => p.id === activePageId) || crawledPages[0];
    if (page && page.content) {
      const markdownText = encodeURIComponent(page.content);
      const previewUrl = `data:text/html;charset=utf-8,<!DOCTYPE html><html><head><meta charset="utf-8"><title>Markdown预览</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;max-width:800px;margin:0 auto;padding:20px;line-height:1.6;color:#333;background-color:#fff}h1,h2,h3,h4,h5,h6{margin-top:24px;margin-bottom:16px;font-weight:600;line-height:1.25}h1{padding-bottom:.3em;font-size:2em;border-bottom:1px solid #eaecef}h2{padding-bottom:.3em;font-size:1.5em;border-bottom:1px solid #eaecef}pre{background-color:#f6f8fa;padding:16px;border-radius:6px;overflow-x:auto;font-size:85%;line-height:1.45}code{background-color:rgba(27,31,35,.05);padding:.2em .4em;border-radius:3px;font-size:85%}pre code{background:0 0;padding:0}blockquote{margin:0;padding:0 1em;color:#6a737d;border-left:.25em solid #dfe2e5}ul,ol{padding-left:2em}li{margin-bottom:.25em}p{margin-top:0;margin-bottom:16px}hr{height:.25em;padding:0;margin:24px 0;background-color:#e1e4e8;border:0}a{color:#0366d6;text-decoration:none}a:hover{text-decoration:underline}img{max-width:100%;box-sizing:content-box}table{width:100%;overflow:auto;margin-bottom:16px}table th{font-weight:600}table td,table th{padding:6px 13px;border:1px solid #dfe2e5}table tr{background-color:#fff;border-top:1px solid #c6cbd1}table tr:nth-child(2n){background-color:#f6f8fa}</style></head><body><div id="content"></div><script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"><\/script><script>document.getElementById('content').innerHTML=marked.parse(decodeURIComponent('${markdownText}'));<\/script></body></html>`;
      chrome.tabs.create({ url: previewUrl });
    } else {
      statusArea.textContent = '没有内容可预览';
    }
  });

  if (ctrlClickPreviewButton) {
    ctrlClickPreviewButton.addEventListener('click', () => {
      chrome.storage.local.get('ctrlClickResult', (data) => {
        if (data.ctrlClickResult) {
          const markdownText = encodeURIComponent(data.ctrlClickResult);
          const previewUrl = `data:text/html;charset=utf-8,<!DOCTYPE html><html><head><meta charset="utf-8"><title>Ctrl+左键点击内容预览</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;max-width:800px;margin:0 auto;padding:20px;line-height:1.6;color:#333;background-color:#fff}h1,h2,h3,h4,h5,h6{margin-top:24px;margin-bottom:16px;font-weight:600;line-height:1.25}h1{padding-bottom:.3em;font-size:2em;border-bottom:1px solid #eaecef}h2{padding-bottom:.3em;font-size:1.5em;border-bottom:1px solid #eaecef}pre{background-color:#f6f8fa;padding:16px;border-radius:6px;overflow-x:auto;font-size:85%;line-height:1.45}code{background-color:rgba(27,31,35,.05);padding:.2em .4em;border-radius:3px;font-size:85%}pre code{background:0 0;padding:0}blockquote{margin:0;padding:0 1em;color:#6a737d;border-left:.25em solid #dfe2e5}ul,ol{padding-left:2em}li{margin-bottom:.25em}p{margin-top:0;margin-bottom:16px}hr{height:.25em;padding:0;margin:24px 0;background-color:#e1e4e8;border:0}a{color:#0366d6;text-decoration:none}a:hover{text-decoration:underline}img{max-width:100%;box-sizing:content-box}table{width:100%;overflow:auto;margin-bottom:16px}table th{font-weight:600}table td,table th{padding:6px 13px;border:1px solid #dfe2e5}table tr{background-color:#fff;border-top:1px solid #c6cbd1}table tr:nth-child(2n){background-color:#f6f8fa}</style></head><body><div id="content"></div><script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"><\/script><script>document.getElementById('content').innerHTML=marked.parse(decodeURIComponent('${markdownText}'));<\/script></body></html>`;
          chrome.tabs.create({ url: previewUrl });
        } else {
          statusArea.textContent = '没有Ctrl+左键点击的内容可预览';
        }
      });
    });
  }

  formatButton.addEventListener('click', () => {
    const page = crawledPages.find(p => p.id === activePageId) || crawledPages[0];
    if (page && page.content) {
      let formatted = page.content;
      formatted = formatted.replace(/\n{3,}/g, '\n\n');
      formatted = formatted.replace(/^#+(.*)$/gm, (match, p1) => { return match + '\n'; });
      formatted = formatted.replace(/^(\s*[-*+]\s*.*)\n(?!\n*(\s*[-*+]\s*|\s*\d+\.\s*|$))/gm, '$1\n\n');
      formatted = formatted.replace(/(\n```[a-z]*\n[\s\S]*?\n```)(?!\n)/g, '$1\n');
      formatted = formatted.replace(/[ \t]+$/gm, '');
      formatted = formatted.replace(/```(\w*)\n?([\s\S]*?)```/g, (match, lang, code) => { return '```' + lang + '\n' + code.trim() + '\n```'; });
      formatted = formatted.replace(/\n\n---\n\n/g, '\n\n---\n');
      markdownOutput.value = formatted.trim();
      statusArea.textContent = '内容已格式化';
    } else {
      statusArea.textContent = '没有内容可格式化';
    }
  });

  settingsButton.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
  });

  /*
  // 返回主页按钮事件处理
  backToMainBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: "stopCrawling" });
    // 完全重置UI到初始状态
    updateUI({ status: 'idle' }, '已返回主页');
    // 隐藏链接选择器
    hideLinkSelector();
    // 清空输出区域
    markdownOutput.value = '';
    markdownOutput.style.display = 'none';
    // 收缩popup窗口
    document.body.classList.remove('expanded');
    // 隐藏返回按钮
    backToMainBtn.classList.remove('show');
  });
  */

  // 监听来自background的爬虫进度更新
  /*
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'crawlProgress') {
      updateUI(request.state, `抓取中(${request.state.processedCount}/${request.state.total}): ${request.state.currentUrl.substring(0,50)}...`);
    } else if (request.action === 'crawlFinished') {
      // 显示完成状态
      statusArea.textContent = `✅ 抓取完成！共 ${request.content.length} 字符`;
      // 显示结果
      markdownOutput.value = request.content;
      markdownOutput.style.display = 'block';
      // 启用下载和预览按钮
      downloadButton.disabled = false;
      previewButton.disabled = false;
      formatButton.disabled = false;
      // 更新爬虫按钮状态
      crawlButton.textContent = '🌐 抓取全站';
      crawlButton.classList.remove('stop-button');
      crawlButton.disabled = false;
      // 保持 popup 打开，不自动关闭
      // 显示返回按钮
      backToMainBtn.classList.add('show');
      document.body.classList.add('expanded');
    }
  });
  */

});