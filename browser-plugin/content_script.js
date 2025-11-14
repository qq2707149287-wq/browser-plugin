/**
 * content_script.js - 专业文档提取 V12.3
 * 添加页面翻译功能：智能检测非中文内容并使用Gemini 2.5 Flash进行翻译
 * 通过OpenRouter API调用，使用您提供的配置
 * 保持所有原有提取功能不变
 */

(function() {
  'use strict';

  // ===== 全局翻译缓存和状态管理 =====
  // 用于存储翻译结果，支持大小按钮之间的状态同步
  const translationCache = new Map();  // key: 段落索引, value: { originalText, translatedText, isShowingTranslation }

  // 记录当前页面 URL，用于检测页面切换
  let currentPageUrl = window.location.href;

  // 全局配置缓存，避免每次翻译都重新获取
  let cachedConfig = null;
  let configFetchPromise = null;  // 用于避免并发获取配置

  // ===== 调试模式和日志收集 =====
  let debugMode = false;
  let debugLogs = [];  // 收集所有日志
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;
  const originalConsoleError = console.error;

  // 初始化调试模式
  async function initDebugMode() {
    const settings = await new Promise((resolve) => {
      chrome.storage.sync.get({ debugMode: false }, resolve);
    });
    debugMode = settings.debugMode;

    if (debugMode) {
      // 拦截 console.log 并收集日志
      console.log = function(...args) {
        const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
        debugLogs.push(`[${timestamp}] ${message}`);
        originalConsoleLog.apply(console, args);
      };

      console.warn = function(...args) {
        const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
        debugLogs.push(`[${timestamp}] ⚠️ ${message}`);
        originalConsoleWarn.apply(console, args);
      };

      console.error = function(...args) {
        const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
        debugLogs.push(`[${timestamp}] ❌ ${message}`);
        originalConsoleError.apply(console, args);
      };
    }
  }

  // 获取配置（带缓存）
  async function getConfigCached() {
    // 如果已有缓存，直接返回
    if (cachedConfig) {
      return cachedConfig;
    }

    // 如果正在获取，等待现有的请求完成
    if (configFetchPromise) {
      return configFetchPromise;
    }

    // 发起新的配置获取请求
    configFetchPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        configFetchPromise = null;
        reject(new Error('获取配置超时'));
      }, 5000);

      chrome.runtime.sendMessage({ action: 'getConfig' }, (response) => {
        clearTimeout(timeout);
        configFetchPromise = null;

        if (chrome.runtime.lastError) {
          reject(new Error('消息传递失败: ' + chrome.runtime.lastError.message));
          return;
        }

        cachedConfig = response || {};
        resolve(cachedConfig);
      });
    });

    return configFetchPromise;
  }

  // 监听页面 URL 变化（处理 SPA 应用）
  function setupPageChangeListener() {
    // 监听 popstate 事件（浏览器前进/后退）
    window.addEventListener('popstate', () => {
      if (window.location.href !== currentPageUrl) {
        console.log('🔄 检测到页面切换（popstate），清除翻译状态');
        resetTranslationState();
      }
    });

    // 监听 hashchange 事件（URL hash 变化）
    window.addEventListener('hashchange', () => {
      if (window.location.href !== currentPageUrl) {
        console.log('🔄 检测到页面切换（hashchange），清除翻译状态');
        resetTranslationState();
      }
    });

    // 使用 MutationObserver 监听 history 变化（某些 SPA 框架）
    const originalPushState = window.history.pushState;
    const originalReplaceState = window.history.replaceState;

    window.history.pushState = function(...args) {
      const result = originalPushState.apply(this, args);
      if (window.location.href !== currentPageUrl) {
        console.log('🔄 检测到页面切换（pushState），清除翻译状态');
        resetTranslationState();
      }
      return result;
    };

    window.history.replaceState = function(...args) {
      const result = originalReplaceState.apply(this, args);
      if (window.location.href !== currentPageUrl) {
        console.log('🔄 检测到页面切换（replaceState），清除翻译状态');
        resetTranslationState();
      }
      return result;
    };
  }

  // 重置翻译状态
  function resetTranslationState() {
    console.log('🧹 重置翻译状态...');

    // 清除翻译缓存
    translationCache.clear();

    // 重置页面翻译标记
    isPageTranslated = false;

    // 更新当前 URL
    currentPageUrl = window.location.href;

    // 隐藏翻译按钮（如果存在）
    const translateBtn = document.getElementById('page-translation-button');
    if (translateBtn) {
      translateBtn.style.display = 'none';
    }

    // 清除所有小翻译按钮的翻译状态
    const smallButtons = document.querySelectorAll('[data-translation-button-injected]');
    smallButtons.forEach(btn => {
      btn.textContent = '译';
      btn.title = '翻译';
      btn.dataset.isTranslated = 'false';
    });

    console.log('✅ 翻译状态已重置');
  }

  // 监听设置变化，清除配置缓存
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync' && (changes.translationModel || changes.OPENROUTER_API_KEY)) {
      console.log('⚙️ 检测到设置变化，清除配置缓存');
      cachedConfig = null;
      configFetchPromise = null;
    }
  });

  // 设置 DOM 变化监听器（用于动态内容翻译）
  let mutationObserver = null;

  function setupDomChangeListener() {
    // 如果已有观察器，先停止
    if (mutationObserver) {
      mutationObserver.disconnect();
    }

    // 创建 MutationObserver 来监听 DOM 变化
    mutationObserver = new MutationObserver((mutations) => {
      // 收集所有新增的文本节点
      const newTextNodes = [];

      mutations.forEach((mutation) => {
        if (mutation.type === 'childList') {
          // 检查新增的节点
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === Node.TEXT_NODE) {
              const text = node.textContent.trim();
              if (text.length > 5 && containsTranslatableText(text)) {
                newTextNodes.push({
                  node: node,
                  text: text,
                  parentElement: node.parentElement
                });
              }
            } else if (node.nodeType === Node.ELEMENT_NODE) {
              // 递归查找元素内的文本节点
              const walker = document.createTreeWalker(
                node,
                NodeFilter.SHOW_TEXT,
                null,
                false
              );
              let textNode;
              while ((textNode = walker.nextNode())) {
                const text = textNode.textContent.trim();
                if (text.length > 5 && containsTranslatableText(text)) {
                  newTextNodes.push({
                    node: textNode,
                    text: text,
                    parentElement: textNode.parentElement
                  });
                }
              }
            }
          });
        }
      });

      // 如果检测到新增的可翻译内容
      if (newTextNodes.length > 0) {
        console.log(`🆕 检测到 ${newTextNodes.length} 个新增可翻译内容`);

        // 为新增内容注入小翻译按钮（如果启用）
        chrome.storage.sync.get({ showSmallTranslateButton: true }, (settings) => {
          if (settings.showSmallTranslateButton) {
            newTextNodes.forEach(nodeInfo => {
              injectSmallTranslationButton(nodeInfo.parentElement, nodeInfo.text);
            });
          }

          // 如果页面已翻译，自动翻译新增内容
          if (isPageTranslated) {
            console.log('📝 页面已翻译，自动翻译新增内容...');
            translateNewContent(newTextNodes);
          }
        });
      }
    });

    // 配置观察选项
    const observerConfig = {
      childList: true,      // 监听子节点变化
      subtree: true,        // 监听所有后代节点
      characterData: false  // 不监听文本内容变化（只监听节点添加/删除）
    };

    // 开始观察
    mutationObserver.observe(document.body, observerConfig);
    console.log('✅ DOM 变化监听器已启动');
  }

  // 翻译新增内容
  async function translateNewContent(newTextNodes) {
    for (const nodeInfo of newTextNodes) {
      try {
        // 检查是否已翻译过
        const cacheKey = nodeInfo.text;
        if (translationCache.has(cacheKey)) {
          const cached = translationCache.get(cacheKey);
          nodeInfo.node.textContent = cached.translatedText;
          continue;
        }

        // 翻译新内容
        const translation = await translateSentence(nodeInfo.text);

        // 更新缓存
        translationCache.set(cacheKey, {
          originalText: nodeInfo.text,
          translatedText: translation,
          isShowingTranslation: true
        });

        // 替换文本
        nodeInfo.node.textContent = translation;
      } catch (error) {
        console.error('翻译新增内容失败:', error);
      }
    }
  }

  // 在页面加载时设置监听器
  setupPageChangeListener();
  setupDomChangeListener();

  // ===== 页面选择窗口模块 =====
  let pageSelectionModal = null;
  let selectedPagesSet = new Set();

  function createPageSelectionModal(links) {
    if (pageSelectionModal) pageSelectionModal.remove();

    const modal = document.createElement('div');
    modal.id = 'page-selection-modal';
    modal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 999999;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;

    const container = document.createElement('div');
    container.style.cssText = `
      background: white;
      border-radius: 8px;
      width: 90%;
      max-width: 500px;
      max-height: 70vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    `;

    const header = document.createElement('div');
    header.style.cssText = `
      padding: 20px;
      border-bottom: 1px solid #e0e0e0;
      font-size: 16px;
      font-weight: 600;
      color: #333;
    `;
    header.textContent = `选择要抓取的页面 (共 ${links.length} 个)`;

    const listContainer = document.createElement('div');
    listContainer.style.cssText = `
      flex: 1;
      overflow-y: auto;
      padding: 15px;
      font-size: 13px;
      color: #444;
    `;

    // 将链接按“第三级目录”分组，生成可折叠树结构
    const groups = {};

    links.forEach((link) => {
      try {
        const url = new URL(link);
        const pathParts = url.pathname.split('/').filter(Boolean);

        // 去掉协议和域名，只基于路径分组
        // 分组策略：
        // - >=3 段: 使用 pathParts[0]/pathParts[1]/pathParts[2]
        // - 1~2 段: 使用完整路径
        // - 0 段: 归为 root
        let groupKey = 'root';
        if (pathParts.length >= 3) {
          groupKey = `${pathParts[0]}/${pathParts[1]}/${pathParts[2]}`;
        } else if (pathParts.length > 0) {
          groupKey = pathParts.join('/');
        }

        if (!groups[groupKey]) {
          groups[groupKey] = [];
        }
        groups[groupKey].push({ link, pathParts });
      } catch (e) {
        if (!groups['other']) {
          groups['other'] = [];
        }
        groups['other'].push({ link, pathParts: [] });
      }
    });

    // 默认选中全部
    selectedPagesSet = new Set(links);

    const sortedGroupKeys = Object.keys(groups).sort((a, b) => {
      if (a === 'root') return -1;
      if (b === 'root') return 1;
      if (a === 'other') return 1;
      if (b === 'other') return -1;
      return a.localeCompare(b);
    });

    sortedGroupKeys.forEach((groupKey) => {
      const pages = groups[groupKey];

      const groupWrapper = document.createElement('div');
      groupWrapper.style.cssText = `
        margin-bottom: 8px;
        border-radius: 4px;
      `;

      const header = document.createElement('div');
      header.style.cssText = `
        display: flex;
        align-items: center;
        padding: 6px 8px;
        cursor: pointer;
        user-select: none;
        border-radius: 4px;
      `;

      const toggleIcon = document.createElement('span');
      toggleIcon.textContent = '▼';
      toggleIcon.style.cssText = `
        display: inline-block;
        width: 14px;
        margin-right: 4px;
        font-size: 10px;
        color: #666;
      `;

      const groupCheckbox = document.createElement('input');
      groupCheckbox.type = 'checkbox';
      groupCheckbox.checked = true;
      groupCheckbox.style.cssText = `
        margin-right: 6px;
        cursor: pointer;
      `;

      const title = document.createElement('span');
      title.style.cssText = `
        font-weight: 600;
        color: #333;
      `;
      if (groupKey === 'root') {
        title.textContent = '根目录 /';
      } else if (groupKey === 'other') {
        title.textContent = '其他';
      } else {
        title.textContent = groupKey + '/';
      }

      header.appendChild(toggleIcon);
      header.appendChild(groupCheckbox);
      header.appendChild(title);
      groupWrapper.appendChild(header);

      const childrenContainer = document.createElement('div');
      childrenContainer.style.cssText = `
        padding-left: 22px;
      `;

      pages.forEach(({ link, pathParts }) => {
        const item = document.createElement('div');
        item.style.cssText = `
          display: flex;
          align-items: center;
          padding: 4px 4px;
          border-radius: 3px;
          cursor: pointer;
          transition: background 0.15s;
        `;
        item.onmouseover = () => item.style.background = '#f5f5f5';
        item.onmouseout = () => item.style.background = 'transparent';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = true;
        checkbox.dataset.link = link;
        checkbox.style.cssText = 'margin-right: 6px; cursor: pointer;';

        // 直接点击复选框时，同步更新 selectedPagesSet，避免仅UI变化导致状态丢失
        checkbox.addEventListener('change', () => {
          const url = checkbox.dataset.link;
          if (!url) return;
          if (checkbox.checked) {
            selectedPagesSet.add(url);
          } else {
            selectedPagesSet.delete(url);
          }
          // 联动组头部半选/全选状态
          syncGroupCheckboxState();
        });


        const label = document.createElement('span');
        label.style.cssText = `
          flex: 1;
          cursor: pointer;
          color: #555;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        `;

        // 展示相对路径：使用完整层级，便于区分同一前缀下的不同路径（问题5优化）
        let displayPath = '';
        if (pathParts.length === 0) {
          displayPath = '/';
        } else {
          displayPath = '/' + pathParts.join('/');
        }
        label.textContent = displayPath || '/';
        label.title = link;

        // 问题1修复：点击文字或整行切换勾选状态
        const toggleSelect = () => {
          checkbox.checked = !checkbox.checked;
          const url = checkbox.dataset.link;
          if (!url) return;
          if (checkbox.checked) {
            selectedPagesSet.add(url);
          } else {
            selectedPagesSet.delete(url);
          }
          syncGroupCheckboxState();
        };

        label.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleSelect();
        });

        item.addEventListener('click', (e) => {
          // 避免直接点复选框时触发两次
          if (e.target === checkbox) return;
          toggleSelect();
        });

        item.appendChild(checkbox);
        item.appendChild(label);
        childrenContainer.appendChild(item);
      });

      groupWrapper.appendChild(childrenContainer);
      listContainer.appendChild(groupWrapper);

      // 点击箭头折叠/展开
      let expanded = true;
      const setExpanded = (v) => {
        expanded = v;
        childrenContainer.style.display = expanded ? 'block' : 'none';
        toggleIcon.textContent = expanded ? '▼' : '▶';
      };
      setExpanded(true);

      toggleIcon.addEventListener('click', (e) => {
        e.stopPropagation();
        setExpanded(!expanded);
      });

      // 组勾选联动
      groupCheckbox.addEventListener('change', (e) => {
        const checked = e.target.checked;
        const childCheckboxes = childrenContainer.querySelectorAll('input[type="checkbox"]');
        childCheckboxes.forEach((cb) => {
          cb.checked = checked;
          const url = cb.dataset.link;
          if (!url) return;
          if (checked) {
            selectedPagesSet.add(url);
          } else {
            selectedPagesSet.delete(url);
          }
        });
        syncGroupCheckboxState();
      });

      // 根据子项更新组的半选/全选状态
      function syncGroupCheckboxState() {
        const all = childrenContainer.querySelectorAll('input[type="checkbox"]');
        const checked = childrenContainer.querySelectorAll('input[type="checkbox"]:checked');
        if (checked.length === 0) {
          groupCheckbox.checked = false;
          groupCheckbox.indeterminate = false;
        } else if (checked.length === all.length) {
          groupCheckbox.checked = true;
          groupCheckbox.indeterminate = false;
        } else {
          groupCheckbox.checked = false;
          groupCheckbox.indeterminate = true;
        }
      }

      // 初始同步一次
      syncGroupCheckboxState();
    });

    const footer = document.createElement('div');
    footer.style.cssText = `
      padding: 15px;
      border-top: 1px solid #e0e0e0;
      display: flex;
      gap: 10px;
      justify-content: flex-end;
    `;

    const selectAllBtn = document.createElement('button');
    selectAllBtn.textContent = '全选';
    selectAllBtn.style.cssText = `
      padding: 8px 16px;
      border: 1px solid #ddd;
      background: #f5f5f5;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      transition: background 0.2s;
    `;
    selectAllBtn.onmouseover = () => selectAllBtn.style.background = '#e8e8e8';
    selectAllBtn.onmouseout = () => selectAllBtn.style.background = '#f5f5f5';
    selectAllBtn.onclick = () => {
      listContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = true;
        // 使用原始链接作为唯一标识，避免使用 label 文本
        const link = cb.dataset.link;
        if (link) {
          selectedPagesSet.add(link);
        }
      });
    };

    const clearBtn = document.createElement('button');
    clearBtn.textContent = '清空';
    clearBtn.style.cssText = `
      padding: 8px 16px;
      border: 1px solid #ddd;
      background: #f5f5f5;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      transition: background 0.2s;
    `;
    clearBtn.onmouseover = () => clearBtn.style.background = '#e8e8e8';
    clearBtn.onmouseout = () => clearBtn.style.background = '#f5f5f5';
    clearBtn.onclick = () => {
      listContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = false;
        const link = cb.dataset.link;
        if (link) {
          selectedPagesSet.delete(link);
        }
      });
    };

    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = '确认选择';
    confirmBtn.style.cssText = `
      padding: 8px 16px;
      background: #4285f4;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      transition: background 0.2s;
    `;
    confirmBtn.onmouseover = () => confirmBtn.style.background = '#3367d6';
    confirmBtn.onmouseout = () => confirmBtn.style.background = '#4285f4';
    confirmBtn.onclick = () => {
      const selected = Array.from(selectedPagesSet);
      if (selected.length === 0) {
        alert('请至少选择一个页面');
        return;
      }
      chrome.runtime.sendMessage({
        action: 'startCrawlingSelected',
        selectedLinks: selected
      });
      modal.remove();
      pageSelectionModal = null;
    };

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '取消';
    cancelBtn.style.cssText = `
      padding: 8px 16px;
      border: 1px solid #ddd;
      background: white;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      transition: background 0.2s;
    `;
    cancelBtn.onmouseover = () => cancelBtn.style.background = '#f5f5f5';
    cancelBtn.onmouseout = () => cancelBtn.style.background = 'white';
    cancelBtn.onclick = () => {
      modal.remove();
      pageSelectionModal = null;
    };

    footer.appendChild(selectAllBtn);
    footer.appendChild(clearBtn);
    footer.appendChild(confirmBtn);
    footer.appendChild(cancelBtn);

    container.appendChild(header);
    container.appendChild(listContainer);
    container.appendChild(footer);
    modal.appendChild(container);
    document.body.appendChild(modal);
    pageSelectionModal = modal;
  }

  // ===== 页面翻译功能模块 =====
  let translationButton = null;
  let translationModal = null;
  let detectedSegments = [];
  let isTranslationCancelled = false; // 翻译取消标志
  let isPageTranslated = false; // 页面翻译状态
  let pageTranslationState = new Map(); // 保存页面翻译前的原始内容

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

  // 全局调试状态
  window.translationDebug = {
    showTranslationButtonCalls: 0,
    createTranslationButtonCalls: 0,
    detectedSegmentsCount: 0,
    lastStatus: '未初始化',
    logCall: function(funcName) {
      this[funcName + 'Calls']++;
      this.lastStatus = new Date().toLocaleTimeString() + ': ' + funcName + ' 调用';
      console.log('🔍 Debug状态:', {
        showTranslationButtonCalls: this.showTranslationButtonCalls,
        createTranslationButtonCalls: this.createTranslationButtonCalls,
        detectedSegmentsCount: this.detectedSegmentsCount,
        lastStatus: this.lastStatus
      });
    },
    updateDetectedSegments: function(count) {
      this.detectedSegmentsCount = count;
      console.log('🔍 可翻译段落数量更新:', count);
    }
  };

  // ===== 非中文内容检测器 =====
  async function detectTranslatableContent() {
    console.log('🚀 开始检测可翻译内容...');

    // 查找所有文本节点
    const textNodes = [];
    const excludedCount = { total: 0, byArea: 0, tooShort: 0, notTranslatable: 0 };
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );

    let node;
    let totalScanned = 0;
    while ((node = walker.nextNode())) {
      totalScanned++;

      // 排除特定区域
      if (isInExcludedArea(node)) {
        excludedCount.byArea++;
        continue;
      }

      const text = node.textContent.trim();
      if (text.length < 5) {
        excludedCount.tooShort++;
        continue; // 太短的内容不处理
      }

      // 检测是否包含非中文完整单词或句子
      if (containsTranslatableText(text)) {
        textNodes.push({
          node: node,
          text: text,
          parentElement: node.parentElement,
          originalText: text // 保存原始文本用于后续比对
        });
      } else {
        excludedCount.notTranslatable++;
      }
    }

    // 计算总排除数
    excludedCount.total = excludedCount.byArea + excludedCount.tooShort + excludedCount.notTranslatable;
    console.log(`📊 原始检测到 ${textNodes.length} 个英文文本段 (扫描: ${totalScanned}, 排除: ${excludedCount.total} 个 - 区域: ${excludedCount.byArea}, 太短: ${excludedCount.tooShort}, 非可翻译: ${excludedCount.notTranslatable})`);

    // 按父元素分组，提取纯文本内容用于翻译（不翻译 HTML 标签和属性）
    const htmlSegments = [];
    const processedParents = new Set();
    const parentToChildrenMap = new Map(); // 记录每个父元素的子文本节点

    // 找到最近的"段落级"父元素（p, div, span[data-as="p"], li 等）
    // 避免选择过大的容器（如包含多个段落的 DIV）
    const getParagraphParent = (node) => {
      let current = node.parentElement;
      const paragraphTags = ['P', 'DIV', 'LI', 'ARTICLE', 'SECTION', 'BLOCKQUOTE'];
      const maxParagraphLength = 240;  // 单个段落的最大字符数（收紧以避免合并 UI 容器）

      while (current && current !== document.body) {
        // 如果是段落级标签，检查其大小
        if (paragraphTags.includes(current.tagName)) {
          const textLength = current.textContent.length;

          // 如果文本长度合理（不超过 500 字符），返回这个元素
          // 这避免了选择包含多个段落的大容器
          if (textLength <= maxParagraphLength) {
            return current;
          }

          // 如果文本太长，继续向上查找更小的段落
          // 这样可以避免把多个段落合并成一个
        }

        // 如果有 data-as="p" 属性，说明这是一个段落
        if (current.getAttribute('data-as') === 'p') {
          return current;
        }

        current = current.parentElement;
      }

      // 如果没找到段落级父元素，返回直接父元素
      return node.parentElement;
    };

    for (const nodeInfo of textNodes) {
      // 使用段落级父元素进行分组，而不是直接父元素
      const paragraphParent = getParagraphParent(nodeInfo.node);
      if (!paragraphParent) continue;

      // 记录段落级父元素的子文本节点
      if (!parentToChildrenMap.has(paragraphParent)) {
        parentToChildrenMap.set(paragraphParent, []);
      }
      parentToChildrenMap.get(paragraphParent).push(nodeInfo);
    }

    console.log(`🔍 父元素分组: 检测到 ${parentToChildrenMap.size} 个不同的父元素`);

    // 对于每个父元素，只创建一个段落（不要分别处理其子文本节点）
    for (const [parent, children] of parentToChildrenMap) {
      if (processedParents.has(parent)) {
        continue;
      }

      // 检查父元素是否包含可翻译内容
      const parentText = parent.textContent.trim();
      const isTranslatable = parentText.length > 0 && containsTranslatableText(parentText);

      // 检查父元素大小 - 避免翻译过大的容器（可能包含多个段落）
      // 如果一个元素包含超过 500 个字符，可能是选择了过大的容器
      const maxParagraphLength = 240;  // 收紧阈值，避免选择包含多个按钮/链接的 UI 容器
      if (parentText.length > maxParagraphLength) {
        // 这个容器太大了，可能包含多个段落，跳过它
        // 让子元素各自被翻译
        continue;
      }

      if (isTranslatable) {
        // 生成父元素路径用于调试
        let pathStr = parent.tagName;
        let current = parent.parentElement;
        let depth = 0;
        while (current && depth < 3) {
          pathStr = current.tagName + ' > ' + pathStr;
          current = current.parentElement;
          depth++;
        }

        // 获取文本预览
        const textPreview = parentText.substring(0, 50).replace(/\n/g, ' ');
        console.log(`✅ 添加父元素段落: ${pathStr} - "${textPreview}${parentText.length > 50 ? '...' : ''}"`);

        // 生成唯一的节点标识符（用于后续查找节点）
        // 不直接保存节点引用，因为 React 会重新渲染导致节点失效
        const nodeId = 'translate-' + Math.random().toString(36).substr(2, 9);
        parent.setAttribute('data-translate-id', nodeId);

        htmlSegments.push({
          nodeId: nodeId,  // 保存节点 ID 而不是节点引用
          node: parent,  // 暂时保存节点引用用于初始化
          text: parentText,  // 只保存纯文本，不保存 HTML
          parentElement: parent.parentElement,
          originalText: parentText,
          isHtml: false,  // 标记为纯文本翻译（不是 HTML 翻译）
          childrenCount: children.length  // 记录这个父元素有多少个子文本节点
        });
        processedParents.add(parent);

        // 标记所有子文本节点的父元素为已处理，防止重复翻译
        // 这包括：直接子元素、孙元素等所有后代元素
        for (const child of children) {
          // 标记该文本节点的所有祖先元素（直到 parent）为已处理
          let ancestor = child.parentElement;
          while (ancestor && ancestor !== parent.parentElement) {
            processedParents.add(ancestor);
            ancestor = ancestor.parentElement;
          }
        }
      }
    }

    console.log(`📊 分组后得到 ${htmlSegments.length} 个 HTML 段落（原始 ${textNodes.length} 个文本节点）`);
    console.log(`✅ 检测完成: ${htmlSegments.length} 个段落`);

    // 返回 HTML 段落，如果没有则返回原始文本节点
    return htmlSegments.length > 0 ? htmlSegments : textNodes;
  }

  // ===== 智能段落合并函数 =====
  async function mergeSegmentsByClass(textNodes) {
    if (textNodes.length <= 1) {
      return textNodes;
    }

    console.log('🔄 开始段落处理，原始数量:', textNodes.length);

    // 直接返回所有段落，不进行复杂的合并
    // 这样确保所有段落都能被翻译
    const processedSegments = textNodes.map((segment, index) => ({
      ...segment,
      originalIndex: index
    }));

    console.log(`✅ 处理完成: ${processedSegments.length} 个段落`);
    return processedSegments;
  }

  // ===== 真正智能的段落合并函数 =====
  async function smartMergeSegments(textNodes) {
    if (textNodes.length <= 1) {
      return textNodes;
    }

    console.log('🔄 开始智能段落合并（原始段落数: ' + textNodes.length + '）...');

    // 第一步：按父元素class进行粗合并
    const classGroups = new Map();

    for (const segment of textNodes) {
      const parent = segment.parentElement;
      if (!parent) continue;

      // 提取父元素的className - 确保是字符串
      let className = 'no-class';
      if (parent.className) {
        className = typeof parent.className === 'string'
          ? parent.className.trim()
          : String(parent.className).trim();
      }
      const key = `class:${className}`;

      if (!classGroups.has(key)) {
        classGroups.set(key, []);
      }
      classGroups.get(key).push(segment);
    }

    console.log(`📊 按class分组: ${classGroups.size} 组`);

    // 第二步：在每个class组内进行更细粒度的合并
    const finalSegments = [];

    for (const [classKey, segments] of classGroups) {
      if (segments.length === 1) {
        // 单独的段落
        const segment = segments[0];
        finalSegments.push({
          ...segment,
          category: 'content',
          subCategory: 'single',
          tagInfo: getElementTagInfo(segment.parentElement),
          isMerged: false,
          originalCount: 1,
          mergeKey: classKey
        });
      } else {
        // 多个段落的合并 - 真正合并相同class的内容
        console.log(`🔄 合并class组 "${classKey}" 中的 ${segments.length} 个段落`);

        // 按内容长度和类型进行智能分组
        const lengthGroups = new Map();

        for (const segment of segments) {
          const textLength = segment.text.length;
          let lengthGroup;

          if (textLength < 50) {
            lengthGroup = 'short';
          } else if (textLength < 200) {
            lengthGroup = 'medium';
          } else {
            lengthGroup = 'long';
          }

          const key = `${classKey}:${lengthGroup}`;
          if (!lengthGroups.has(key)) {
            lengthGroups.set(key, []);
          }
          lengthGroups.get(key).push(segment);
        }

        // 合并每个长度组
        for (const [lengthKey, lengthGroupSegments] of lengthGroups) {
          if (lengthGroupSegments.length === 1) {
            const segment = lengthGroupSegments[0];
            finalSegments.push({
              ...segment,
              category: 'content',
              subCategory: 'single',
              tagInfo: getElementTagInfo(lengthGroupSegments[0].parentElement),
              isMerged: false,
              originalCount: 1,
              mergeKey: lengthKey
            });
          } else {
            // 真正合并多个段落
            const mergedText = lengthGroupSegments.map(seg => seg.text).join('\n\n');
            const mergedNode = createMergedNode(lengthGroupSegments.map(seg => seg.node));

            const mergedSegment = {
              node: mergedNode,
              text: mergedText,
              parentElement: lengthGroupSegments[0].parentElement,
              category: 'content',
              subCategory: 'merged',
              tagInfo: getElementTagInfo(lengthGroupSegments[0].parentElement),
              isMerged: true,
              originalCount: lengthGroupSegments.length,
              originalSegments: lengthGroupSegments,
              mergeKey: lengthKey
            };

            finalSegments.push(mergedSegment);
          }
        }
      }
    }

    console.log(`✅ 智能合并完成: ${textNodes.length} → ${finalSegments.length} 个段落`);
    return finalSegments;
  }

  // 保持旧的函数名以兼容
  async function categorizeSegmentsByTags(textNodes) {
    return await smartMergeSegments(textNodes);
  }

  // 获取元素的标签名和类名信息
  function getElementTagInfo(element) {
    if (!element) {
      return { tagName: '', classes: [] };
    }

    return {
      tagName: element.tagName.toLowerCase(),
      classes: Array.from(element.classList || [])
    };
  }

  // 计算文本相似度
  function calculateTextSimilarity(text1, text2) {
    const words1 = text1.split(/\s+/).filter(word => word.length > 2);
    const words2 = text2.split(/\s+/).filter(word => word.length > 2);

    if (words1.length === 0 || words2.length === 0) return 0;

    const set1 = new Set(words1);
    const set2 = new Set(words2);
    const intersection = new Set([...set1].filter(x => set2.has(x)));

    return intersection.size / Math.max(set1.size, set2.size);
  }

  // 提取关键词
  function extractKeywords(text) {
    const words = text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length >= 3 && !isStopWord(word));
    return [...new Set(words)].slice(0, 5); // 最多5个关键词
  }

  // 检查是否为停用词
  function isStopWord(word) {
    const stopWords = ['the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'this', 'that', 'these', 'those', 'here', 'there', 'where', 'when', 'why', 'how'];
    return stopWords.includes(word);
  }

  // 创建合并节点
  function createMergedNode(nodes) {
    // 创建一个虚拟的合并节点
    const mergedNode = document.createElement('div');
    mergedNode.className = 'merged-translation-node';
    mergedNode.style.display = 'none';

    // 存储原始节点信息
    mergedNode.setAttribute('data-original-nodes', nodes.length);
    mergedNode.setAttribute('data-merged', 'true');

    return mergedNode;
  }

  // 判断是否在排除区域（代码块、脚本、UI 元素等）
  // 注意：排除工具栏、按钮组、导航等 UI 容器，只翻译主要内容
  function isInExcludedArea(node) {
    // 排除不应该翻译的标签：代码块、脚本、样式等
    const excludedTags = ['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR'];

    // 排除 UI 相关的 class（工具栏、按钮组、导航等）
    const excludedClasses = [
      'math', 'latex', 'code', 'highlight', 'language-', 'hljs', 'prism',
      // UI/操作相关
      'toolbar', 'toolbars', 'action', 'actions', 'action-', 'buttons', 'btn', 'btn-', 'button-group',
      'command', 'commandbar', 'command-bar', 'utility', 'utilities',
      'header-actions', 'page-actions', 'toc-actions', 'toc',
      // 导航/结构相关（保留 nav 内容，但用于识别 UI 容器）
      'nav-', 'navigation', 'menu', 'menubar', 'sidebar', 'header-', 'footer-',
      'breadcrumb', 'pagination', 'tabs', 'tab-', 'modal', 'dialog',
      'dropdown', 'popover', 'tooltip', 'badge', 'tag', 'label'
    ];

    // 结构化判断：检测“像工具栏”的容器
    const isLikelyToolbarContainer = (el) => {
      try {
        if (!el || !el.querySelectorAll) return false;
        const insideHeader = !!el.closest('HEADER');
        const insideNav = !!el.closest('NAV');
        if (!insideHeader || insideNav) {
          // 只在页眉区域生效，避免误伤导航菜单
          return false;
        }
        const clickableSelector = 'a,button,[role="button"],[role="menuitem"],[role="tab"],[role="link"]';
        const clickables = el.querySelectorAll(clickableSelector);
        if (clickables.length >= 3) {
          const texts = Array.from(clickables).map(n => (n.textContent || '').trim()).filter(t => t.length > 0);
          if (texts.length === 0) return false;
          const avgLen = texts.join(' ').length / texts.length;
          // 平均长度较短，基本可以判定为一排操作按钮
          if (avgLen <= 30) return true;
        }
        return false;
      } catch (e) {
        return false;
      }
    };

    let parent = node.parentElement;
    while (parent && parent !== document.body) {
      // 检查标签名 - 排除代码/脚本相关标签
      if (excludedTags.includes(parent.tagName)) {
        return true;
      }

      // 检查是否是 SVG 标签本身（SVG 图标不翻译）
      if (parent.tagName === 'SVG') {
        return true;
      }

      // 检查 role 属性 - 排除 UI 相关的 role
      const role = parent.getAttribute('role');
      if (role && ['toolbar', 'navigation', 'menubar', 'tablist', 'dialog', 'alertdialog'].includes(role)) {
        return true;
      }

      // 检查类名 - 确保是字符串
      let className = '';
      if (parent.className) {
        className = typeof parent.className === 'string'
          ? parent.className
          : String(parent.className);
      }

      // 检查是否包含排除的 class
      for (const excludedClass of excludedClasses) {
        if (className.includes(excludedClass)) {
          return true;
        }
      }

      // 结构化检测：HEADER 区域内的多按钮容器（工具栏）
      if (isLikelyToolbarContainer(parent)) {
        return true;
      }

      parent = parent.parentElement;
    }

    return false;
  }

  // 检测是否包含可翻译的非中文文本
  function containsTranslatableText(text) {
    // 如果文本主要是中文，不需要翻译
    const chineseChars = text.match(/[\u4e00-\u9fff]/g);
    const chineseRatio = chineseChars ? chineseChars.length / text.length : 0;

    if (chineseRatio > 0.5) {
      return false;
    }

    // 检查是否包含足够的英文单词（降低要求到1个单词）
    const englishWords = text.match(/[a-zA-Z]{3,}/g);
    return englishWords && englishWords.length >= 1;
  }

   // ===== 翻译按钮管理 =====
  function createTranslationButton() {
    if (translationButton) {
      // 如果按钮已存在，确保其显示
      const existingButton = document.getElementById('page-translation-button');
      if (existingButton) {
        existingButton.style.display = 'flex';
        console.log('翻译按钮已存在，确保显示');
        return;
      } else {
        // 如果DOM元素不存在，重新创建
        translationButton.remove();
        translationButton = null;
      }
    }

    try {
      translationButton = document.createElement('div');
      translationButton.setAttribute('data-translation-container', 'true');
      translationButton.setAttribute('data-react-safe', 'true');

      translationButton.innerHTML = `
        <div id="page-translation-button" style="
          position: fixed;
          top: 150px;
          right: 30px;
          z-index: 99999;
          width: 50px;
          height: 50px;
          background: linear-gradient(135deg, #007BFF, #28a745);
          border-radius: 50%;
          cursor: pointer;
          box-shadow: 0 4px 8px rgba(0,0,0,0.3);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 18px;
          color: white;
          transition: all 0.3s ease;
          border: 2px solid white;
          user-select: none;
          opacity: 0.9;
        "
        title="页面翻译 - 使用您的Gemini 2.5 Flash配置，点击翻译">译</div>
      `;

      const button = translationButton.firstElementChild;

      // 添加拖动功能
      let isDragging = false;
      let isMoved = false;
      let offsetX, offsetY;
      let originalX, originalY;

      button.addEventListener('mousedown', (e) => {
        isDragging = false;
        isMoved = false;
        offsetX = e.clientX - button.getBoundingClientRect().left;
        offsetY = e.clientY - button.getBoundingClientRect().top;
        originalX = button.style.right;
        originalY = button.style.top;
        e.preventDefault();
      });

      document.addEventListener('mousemove', (e) => {
        if (e.buttons === 1 && offsetX && offsetY) { // 鼠标左键按下
          isDragging = true;
          isMoved = true;
          const x = e.clientX - offsetX;
          const y = e.clientY - offsetY;
          button.style.right = 'auto';
          button.style.top = y + 'px';
          button.style.left = x + 'px';
        }
      });

      document.addEventListener('mouseup', () => {
        offsetX = 0;
        offsetY = 0;
      });

      button.addEventListener('click', (e) => {
        if (!isMoved) {
          if (isPageTranslated) {
            showTranslationMenu();
          } else {
            showTranslationModal();
          }
        }
        isMoved = false;
      });

      button.addEventListener('mouseenter', () => {
        if (!isDragging) {
          button.style.transform = 'scale(1.1)';
          button.style.boxShadow = '0 6px 12px rgba(0,0,0,0.4)';
          button.style.opacity = '1';
        }
      });

      button.addEventListener('mouseleave', () => {
        button.style.transform = 'scale(1)';
        button.style.boxShadow = '0 4px 8px rgba(0,0,0,0.3)';
        button.style.opacity = '0.9';
      });

      // 使用MutationObserver确保按钮不会被意外移除
      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (mutation.type === 'childList') {
            if (!document.contains(translationButton)) {
              console.log('翻译按钮被意外移除，重新添加');
              document.body.appendChild(translationButton);
            }
          }
        });
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });

      // 安全地添加到body
      if (document.body) {
        document.body.appendChild(translationButton);
        console.log('翻译按钮已成功添加');
      } else {
        // 如果body不存在，等待DOMReady
        document.addEventListener('DOMContentLoaded', () => {
          if (document.body) {
            document.body.appendChild(translationButton);
            console.log('翻译按钮已成功添加（DOMReady后）');
          }
        });
      }
    } catch (error) {
      console.error('创建翻译按钮时出错:', error);
    }
  }

  // 显示翻译按钮
  async function showTranslationButton() {
    window.translationDebug.logCall('showTranslationButton');

    // 检测可翻译内容
    try {
      const segments = await detectTranslatableContent();
      detectedSegments = segments;

      window.translationDebug.updateDetectedSegments(segments.length);

      // 只有当有足够的可翻译内容时才创建按钮
      if (segments.length > 0) {
        createTranslationButton();

        // 更新按钮的显示状态
        const pageTranslationButton = document.getElementById('page-translation-button');
        if (pageTranslationButton) {
          pageTranslationButton.style.display = 'flex';
          pageTranslationButton.setAttribute('data-detected-segments', segments.length.toString());

          // 更新title显示检测到的段落数
          pageTranslationButton.title = `页面翻译 - 使用您的Gemini 2.5 Flash配置，检测到 ${segments.length} 段可翻译内容，点击翻译`;
        }

        // 在页面上显示检测结果提示
        showDetectionResult(segments.length);
      } else {
        // 如果没有可翻译内容，显示提示
        showNoTranslationContentMessage();
      }
    } catch (error) {
      console.error('检测可翻译内容时出错:', error);
      showErrorMessage('检测翻译内容时出错：' + error.message);
    }
  }

  // 显示检测结果提示
  function showDetectionResult(segmentsCount) {
    const existingTip = document.getElementById('translation-detection-tip');
    if (existingTip) {
      existingTip.remove();
    }

    const tip = document.createElement('div');
    tip.id = 'translation-detection-tip';
    tip.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 99998;
      background: linear-gradient(135deg, #007BFF, #28a745);
      color: white;
      padding: 12px 16px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      font-size: 14px;
      max-width: 280px;
      animation: slideInRight 0.3s ease;
    `;

    tip.innerHTML = `
      <div style="display: flex; align-items: center;">
        <span style="font-size: 16px; margin-right: 8px;">🌐</span>
        <div>
          <div style="font-weight: 600;">检测到 ${segmentsCount} 段可翻译内容</div>
          <div style="font-size: 12px; opacity: 0.9; margin-top: 2px;">点击右上角翻译按钮开始翻译</div>
        </div>
      </div>
      <button id="close-detection-tip" style="
        position: absolute;
        top: 4px;
        right: 6px;
        background: none;
        border: none;
        color: white;
        font-size: 16px;
        cursor: pointer;
        opacity: 0.7;
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
      ">×</button>
    `;

    document.body.appendChild(tip);

    // 添加关闭事件
    const closeBtn = tip.querySelector('#close-detection-tip');
    closeBtn.addEventListener('click', () => {
      tip.remove();
    });

    // 3秒后自动关闭
    setTimeout(() => {
      if (tip.parentNode) {
        tip.remove();
      }
    }, 4000);
  }

  // 显示没有翻译内容的提示
  function showNoTranslationContentMessage() {
    const tip = document.createElement('div');
    tip.id = 'no-translation-tip';
    tip.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 99998;
      background: #6c757d;
      color: white;
      padding: 12px 16px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      font-size: 14px;
      max-width: 280px;
      animation: slideInRight 0.3s ease;
    `;

    tip.innerHTML = `
      <div style="display: flex; align-items: center;">
        <span style="font-size: 16px; margin-right: 8px;">ℹ️</span>
        <div>
          <div style="font-weight: 600;">未检测到可翻译内容</div>
          <div style="font-size: 12px; opacity: 0.9; margin-top: 2px;">页面主要为中文内容</div>
        </div>
      </div>
    `;

    document.body.appendChild(tip);

    setTimeout(() => {
      if (tip.parentNode) {
        tip.remove();
      }
    }, 3000);
  }

  // 显示错误信息
  function showErrorMessage(message) {
    const tip = document.createElement('div');
    tip.id = 'translation-error-tip';
    tip.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 99998;
      background: #dc3545;
      color: white;
      padding: 12px 16px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      font-size: 14px;
      max-width: 280px;
      animation: slideInRight 0.3s ease;
    `;

    tip.innerHTML = `
      <div style="display: flex; align-items: center;">
        <span style="font-size: 16px; margin-right: 8px;">❌</span>
        <div>
          <div style="font-weight: 600;">翻译功能错误</div>
          <div style="font-size: 12px; opacity: 0.9; margin-top: 2px;">${message}</div>
        </div>
      </div>
    `;

    document.body.appendChild(tip);

    setTimeout(() => {
      if (tip.parentNode) {
        tip.remove();
      }
    }, 5000);
  }

  // 下载调试日志文件
  function downloadDebugLogs() {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const filename = `translation-debug-${timestamp}.log`;
      const content = debugLogs.join('\n');

      // 使用 Blob 和 URL.createObjectURL 创建下载链接
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);

      // 创建临时下载链接
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      // 释放 URL
      URL.revokeObjectURL(url);

      console.log(`✅ 调试日志已下载: ${filename}`);
    } catch (error) {
      console.error('❌ 下载调试日志失败:', error);
    }
  }

  // 添加CSS动画
  if (!document.getElementById('translation-animations')) {
    const style = document.createElement('style');
    style.id = 'translation-animations';
    style.textContent = `
      @keyframes slideInRight {
        from {
          transform: translateX(100%);
          opacity: 0;
        }
        to {
          transform: translateX(0);
          opacity: 1;
        }
      }
      @keyframes pulse {
        0% { transform: scale(1); }
        50% { transform: scale(1.05); }
        100% { transform: scale(1); }
      }
    `;
    document.head.appendChild(style);
  }

  // 处理翻译请求
  async function handleTranslationRequest() {
    const translateBtn = document.getElementById('translate-btn');
    if (translateBtn) {
      translateBtn.disabled = true;
      translateBtn.textContent = '⏳ 正在翻译...';
    }

    // 初始化调试模式
    await initDebugMode();
    debugLogs = [];  // 清空之前的日志

    try {
      // 检查是否已经翻译过，如果是则先还原
      if (isPageTranslated && pageTranslationState.size > 0) {
        console.log('🔄 重新翻译：还原旧的翻译状态...');
        restoreOriginalPage();
        // 等待 DOM 更新
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      // 获取用户设置
      const settings = await new Promise((resolve) => {
        chrome.storage.sync.get({
          bilingualMode: false
        }, resolve);
      });
      const bilingualMode = settings.bilingualMode;

      // 重新检测可翻译内容，确保获取最新的内容
      const segments = await detectTranslatableContent();

      if (!segments || segments.length === 0) {
        console.error('❌ 检测到 0 个段落');
        throw new Error('没有可翻译的内容');
      }

      // 过滤出有效的段落（必须有node和text）
      const validSegments = segments.filter(seg => seg && seg.node && seg.text && seg.text.length > 0);
      console.log(`📝 检测到 ${validSegments.length} 个可翻译段落`);

      if (validSegments.length === 0) {
        console.error('❌ 检测到 0 个有效段落，段落总数:', segments.length);
        if (segments.length > 0) {
          console.error('❌ 无效段落示例:', segments.slice(0, 3).map(s => ({
            hasNode: !!s.node,
            hasText: !!s.text,
            textLength: s.text ? s.text.length : 0,
            text: s.text ? s.text.substring(0, 50) : 'N/A'
          })));
        }
        throw new Error('没有有效的可翻译内容');
      }

      // 使用并发翻译（最多20个并发请求以加快速度）
      const concurrencyLimit = 20;
      let successCount = 0;
      let failureCount = 0;
      let processedCount = 0;

      // 应用单个翻译结果到 DOM
      const applyTranslationResult = (result, bilingualMode) => {
        if (!result || !result.success) {
          failureCount++;
          if (result && result.error) {
            console.error(`❌ 翻译失败: "${(result.text || '').substring(0, 50)}..." - 错误: ${result.error}`);
          } else if (!result) {
            console.error(`❌ 翻译结果为空`);
          } else {
            console.error(`❌ 翻译失败: 未知原因`);
          }
          return false;
        }

        // 更新翻译缓存和小按钮状态
        if (result.segmentIndex !== undefined) {
          const index = result.segmentIndex;
          translationCache.set(index, {
            originalText: result.text,
            translatedText: result.translatedText,
            isShowingTranslation: true
          });

          // 更新对应小按钮的状态
          const smallButton = document.querySelector(`button[data-block-index="${index}"]`);
          if (smallButton) {
            smallButton.dataset.isTranslated = 'true';
            smallButton.textContent = '✓';
            smallButton.title = '已翻译 - 点击切换原文';
            smallButton.style.background = 'linear-gradient(135deg, #28a745, #20c997)';
          }
        }

        // 验证节点有效性
        if (!result.node) {
          console.warn(`⚠️ 节点无效，跳过翻译: "${(result.text || '').substring(0, 50)}..."`);
          return false;
        }

        // 检查节点是否已经被作为其父元素的一部分翻译过了（防止重复翻译）
        if (result.node.nodeType === Node.TEXT_NODE && result.node.parentNode) {
          // 检查该文本节点的所有祖先元素是否已被翻译
          let ancestor = result.node.parentElement;
          while (ancestor && ancestor !== document.body) {
            if (ancestor.hasAttribute('data-translation-element')) {
              // 该文本节点的祖先已被翻译，跳过该文本节点
              console.log(`⏭️ 跳过已翻译的祖先元素内的文本: "${(result.text || '').substring(0, 50)}..."`);
              return false;
            }
            ancestor = ancestor.parentElement;
          }
        }

        // 检查节点是否仍在 DOM 中
        // 如果节点有 data-translate-id，尝试通过 ID 重新查找节点（处理 React 重新渲染的情况）
        let nodeToTranslate = result.node;
        if (result.nodeId) {
          const foundNode = document.querySelector(`[data-translate-id="${result.nodeId}"]`);
          if (foundNode) {
            nodeToTranslate = foundNode;
            console.log(`🔄 通过 ID 重新查找节点成功: ${result.nodeId}`);
          } else {
            // 节点已被移除，跳过但不计为失败（可能是动态内容）
            console.warn(`⚠️ 节点已从 DOM 中移除，跳过翻译: "${(result.text || '').substring(0, 50)}..."`);
            return false;
          }
        } else {
          // 没有 nodeId，使用原始的节点验证方式
          const isNodeValid = () => {
            if (nodeToTranslate.nodeType === Node.TEXT_NODE) {
              return nodeToTranslate.parentNode &&
                     nodeToTranslate.parentNode.isConnected &&
                     document.contains(nodeToTranslate.parentNode);
            }
            return nodeToTranslate.isConnected && document.contains(nodeToTranslate);
          };

          if (!isNodeValid()) {
            // 节点已被移除，跳过但不计为失败（可能是动态内容）
            console.warn(`⚠️ 节点已从 DOM 中移除，跳过翻译: "${(result.text || '').substring(0, 50)}..."`);
            return false;
          }
        }

        // 更新 result.node 为重新查找到的节点
        result.node = nodeToTranslate;

        try {
          // 节点已验证有效，继续处理

          // 保存原始内容用于还原
          const nodeId = Math.random().toString(36).substr(2, 9);
          if (result.node.nodeType === Node.TEXT_NODE) {
            const originalText = result.node.textContent;

            if (bilingualMode) {
              // 中英对照模式：使用安全的DOM操作避免React冲突
              try {
                // 检查原文和译文是否相同，如果相同则跳过对照显示
                if (originalText.trim() === result.translatedText.trim()) {
                  // 直接替换为译文，不生成双语对照
                  const newNode = document.createTextNode(result.translatedText);
                  if (result.node.parentNode &&
                      result.node.parentNode.isConnected &&
                      document.contains(result.node.parentNode) &&
                      document.contains(result.node)) {
                    const parentNode = result.node.parentNode;
                    parentNode.replaceChild(newNode, result.node);

                    pageTranslationState.set(nodeId, {
                      type: 'text',
                      originalText: originalText,
                      originalNode: result.node,
                      newNode: newNode,
                      parent: parentNode
                    });
                  }
                } else {
                  // 原文和译文不同，生成双语对照
                  const wrapper = document.createElement('div');
                  wrapper.style.cssText = 'display: inline;';
                  wrapper.setAttribute('data-translation-wrapper', nodeId);
                  wrapper.setAttribute('data-translation-type', 'bilingual');
                  wrapper.setAttribute('data-react-safe', 'true');
                  wrapper.setAttribute('data-translation-id', nodeId);

                  const originalNode = document.createTextNode(originalText);
                  const lineBreak = document.createElement('br');
                  const translatedNode = document.createTextNode(result.translatedText);

                  wrapper.appendChild(originalNode);
                  wrapper.appendChild(lineBreak);
                  wrapper.appendChild(translatedNode);

                  // 安全的节点替换，增加更多检查
                  if (result.node.parentNode &&
                      result.node.parentNode.isConnected &&
                      document.contains(result.node.parentNode) &&
                      document.contains(result.node)) {
                    const parentNode = result.node.parentNode;
                    const nextSibling = result.node.nextSibling;
                    parentNode.replaceChild(wrapper, result.node);

                    // 保存完整的翻译状态
                    pageTranslationState.set(nodeId, {
                      type: 'text-bilingual',
                      originalText: originalText,
                      originalNode: result.node,
                      wrapper: wrapper,
                      parent: parentNode,
                      nextSibling: nextSibling
                    });

                    // 清理翻译结果中的 HTML 标签用于日志显示
                    const cleanedTranslation = result.translatedText.replace(/<[^>]*>/g, '');
                    console.log(`✅ "${originalText.substring(0, 50)}" → "${cleanedTranslation.substring(0, 50)}"`);
                  } else {
                    throw new Error('原节点父元素不可用或已断开连接');
                  }
                }
              } catch (domError) {
                console.error('DOM操作失败:', domError);
                throw domError;
              }
            } else {
              // 覆盖模式：安全的文本替换避免React冲突
              try {
                const newNode = document.createTextNode(result.translatedText);

                if (result.node.parentNode &&
                    result.node.parentNode.isConnected &&
                    document.contains(result.node.parentNode) &&
                    document.contains(result.node)) {
                  const parentNode = result.node.parentNode;
                  parentNode.replaceChild(newNode, result.node);

                  // 保存完整的翻译状态
                  pageTranslationState.set(nodeId, {
                    type: 'text',
                    originalText: originalText,
                    originalNode: result.node,
                    newNode: newNode,
                    parent: parentNode
                  });

                  // 清理翻译结果中的 HTML 标签用于日志显示
                  const cleanedTranslation = result.translatedText.replace(/<[^>]*>/g, '');
                  console.log(`✅ "${originalText.substring(0, 50)}" → "${cleanedTranslation.substring(0, 50)}"`);
                } else {
                  throw new Error('原节点父元素不可用或已断开连接');
                }
              } catch (domError) {
                console.error('DOM操作失败:', domError);
                throw domError;
              }
            }
          } else {
            // 对于元素节点，替换其文本内容或 HTML 内容
            const originalText = result.node.textContent;
            const isHtmlTranslation = result.isHtml;  // 检查是否为 HTML 翻译

            if (bilingualMode) {
              // 中英对照模式：安全的元素操作避免React冲突
              try {
                // 检查节点是否安全可用
                if (!result.node.isConnected || !document.contains(result.node)) {
                  throw new Error('元素节点已断开连接');
                }

                const originalHTML = result.node.innerHTML;
                result.node.setAttribute('data-translation-element', nodeId);
                result.node.setAttribute('data-translation-type', 'element-bilingual');
                result.node.setAttribute('data-react-safe', 'true');
                result.node.setAttribute('data-translation-id', nodeId);

                // 检查原文和译文是否相同，如果相同则跳过对照显示
                if (originalText.trim() === result.translatedText.trim()) {
                  // 直接替换为译文，不生成双语对照
                  if (isHtmlTranslation) {
                    result.node.innerHTML = result.translatedText;
                  } else {
                    result.node.textContent = result.translatedText;
                  }

                  pageTranslationState.set(nodeId, {
                    type: 'element',
                    originalText: originalText,
                    originalHTML: originalHTML,
                    node: result.node,
                    parent: result.node.parentNode,
                    isHtml: isHtmlTranslation
                  });
                } else {
                  // 原文和译文不同，生成双语对照
                  if (isHtmlTranslation) {
                    // HTML 翻译：原文 HTML + 换行 + 翻译后的 HTML
                    result.node.innerHTML = originalHTML + '<br>' + result.translatedText;
                  } else {
                    // 纯文本翻译：原文 HTML + 换行 + 翻译文本（需要转义）
                    const translatedTextEscaped = result.translatedText
                      .replace(/&/g, '&amp;')
                      .replace(/</g, '&lt;')
                      .replace(/>/g, '&gt;')
                      .replace(/"/g, '&quot;')
                      .replace(/'/g, '&#39;');
                    result.node.innerHTML = originalHTML + '<br>' + translatedTextEscaped;
                  }

                  // 保存完整的翻译状态
                  pageTranslationState.set(nodeId, {
                    type: 'element-bilingual',
                    originalText: originalText,
                    originalHTML: originalHTML,
                    translatedText: result.translatedText,
                    node: result.node,
                    parent: result.node.parentNode,
                    isHtml: isHtmlTranslation
                  });

                  // 清理翻译结果中的 HTML 标签用于日志显示
                  const cleanedTranslation = result.translatedText.replace(/<[^>]*>/g, '');
                  console.log(`✅ "${originalText.substring(0, 50)}" → "${cleanedTranslation.substring(0, 50)}"`);
                }
              } catch (domError) {
                console.error('DOM操作失败:', domError);
                throw domError;
              }
            } else {
              // 覆盖模式：安全的元素文本替换避免React冲突
              try {
                // 检查节点是否安全可用
                if (!result.node.isConnected || !document.contains(result.node)) {
                  throw new Error('元素节点已断开连接');
                }

                result.node.setAttribute('data-translation-element', nodeId);
                result.node.setAttribute('data-translation-type', 'element');
                result.node.setAttribute('data-react-safe', 'true');
                result.node.setAttribute('data-translation-id', nodeId);

                // 如果是 HTML 翻译，使用 innerHTML；否则使用 textContent
                const originalContent = result.node.textContent;
                if (isHtmlTranslation) {
                  result.node.innerHTML = result.translatedText;
                } else {
                  result.node.textContent = result.translatedText;
                }

                // 保存完整的翻译状态
                pageTranslationState.set(nodeId, {
                  type: 'element',
                  originalText: originalText,
                  originalContent: originalContent,
                  node: result.node,
                  parent: result.node.parentNode
                });

                // 清理翻译结果中的 HTML 标签用于日志显示
                const cleanedTranslation = result.translatedText.replace(/<[^>]*>/g, '');
                console.log(`✅ "${originalText.substring(0, 50)}" → "${cleanedTranslation.substring(0, 50)}"`);
              } catch (domError) {
                console.error('DOM操作失败:', domError);
                throw domError;
              }
            }
          }
          successCount++;
          return true;
        } catch (error) {
          console.error('替换文本节点时出错:', error);
          failureCount++;
          return false;
        }
      };

      // 创建翻译任务队列
      const translateSegment = async (segment) => {
        try {
          // 验证 segment 参数
          if (!segment || !segment.text) {
            throw new Error('翻译参数无效');
          }

          if (!chrome.runtime || !chrome.runtime.id) {
            throw new Error('扩展上下文已失效，请刷新页面');
          }

          const response = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              reject(new Error('翻译超时'));
            }, 30000);

            try {
              // 总是发送纯文本进行翻译（不翻译 HTML）
              const messagePayload = {
                action: 'translateSentence',
                text: segment.text,  // 只发送纯文本，不发送 HTML
                isHtml: false,  // 总是标记为纯文本翻译
                nodeId: segment.nodeId  // 传递节点 ID，用于后续查找节点
              };

              chrome.runtime.sendMessage(
                messagePayload,
                (resp) => {
                  clearTimeout(timeout);

                  if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message || '扩展错误'));
                    return;
                  }

                  if (!resp || !resp.success) {
                    reject(new Error(resp?.error || '翻译失败'));
                    return;
                  }

                  if (!resp.translation) {
                    reject(new Error('翻译结果缺失'));
                    return;
                  }

                  resolve(resp);
                }
              );
            } catch (err) {
              clearTimeout(timeout);
              reject(err);
            }
          });

          // 响应成功且有翻译
          return {
            ...segment,
            translatedText: response.translation,
            success: true
          };
        } catch (error) {
          // 上下文失效错误直接向上抛，终止批次，其他错误仅标记为失败
          if (error.message && error.message.includes('扩展上下文已失效')) {
            console.error('❌ 扩展上下文已失效，终止翻译流程');
            throw error;
          }

          console.error('❌ 单段翻译失败 - 完整错误信息:', {
            message: error.message,
            stack: error.stack,
            segmentPreview: (segment.text || '').slice(0, 80),
            segmentLength: segment.text ? segment.text.length : 0,
            isHtml: segment.isHtml,
            segmentIndex: segment.segmentIndex
          });
          return {
            ...segment,
            error: error.message,
            success: false
          };
        }
      };

      // 并发处理翻译，实时显示结果
      try {
        for (let i = 0; i < validSegments.length; i += concurrencyLimit) {
          const batch = validSegments.slice(i, i + concurrencyLimit);
          const batchResults = await Promise.all(batch.map(translateSegment));

          // 立即应用每个翻译结果，实现实时显示
          for (const result of batchResults) {
            applyTranslationResult(result, bilingualMode);
            processedCount++;

            // 实时更新UI进度
            if (translateBtn) {
              translateBtn.textContent = `⏳ 翻译中... (${processedCount}/${validSegments.length})`;
            }
          }
        }

        const successRate = validSegments.length > 0 ? ((successCount / validSegments.length) * 100).toFixed(1) : 0;
        console.log(`\n✅ 翻译完成统计:`);
        console.log(`   - 总段落数: ${validSegments.length}`);
        console.log(`   - 成功: ${successCount} (${successRate}%)`);
        console.log(`   - 失败: ${failureCount}`);
        console.log(`   - 跳过: ${validSegments.length - successCount - failureCount}\n`);

        // 如果启用了调试模式，下载日志文件
        if (debugMode && debugLogs.length > 0) {
          downloadDebugLogs();
        }

        // 设置页面翻译状态
        isPageTranslated = true;

        // 隐藏翻译按钮
        if (translateBtn) {
          translateBtn.style.display = 'none';
        }

        // 显示结果通知
        showNotification(`翻译完成! 成功: ${successCount}, 失败: ${failureCount}`, 'success');
      } catch (batchError) {
        // 处理批处理中的错误
        if (batchError.message && batchError.message.includes('扩展上下文已失效')) {
          console.error('❌ 扩展上下文已失效，翻译中断');
          showNotification('扩展上下文已失效，请刷新页面后重试', 'error');
        } else {
          throw batchError;
        }
      }

    } catch (error) {
      console.error('❌ 翻译失败:', error.message);

      // 区分不同类型的错误
      let errorMsg = error.message;
      if (error.message && error.message.includes('Extension context invalidated')) {
        errorMsg = '扩展上下文已失效，请刷新页面后重试';
      } else if (error.message && error.message.includes('没有可翻译的内容')) {
        errorMsg = '未检测到可翻译内容 页面主要为中文内容';
      } else if (error.message && error.message.includes('没有有效的可翻译内容')) {
        errorMsg = '未检测到可翻译内容 页面主要为中文内容';
      }

      showNotification('翻译失败: ' + errorMsg, 'error');

      if (translateBtn) {
        translateBtn.disabled = false;
        translateBtn.textContent = '🌐 翻译页面内容';
      }
    }
  }

  // 显示通知
  function showNotification(message, type) {
    // 创建通知元素
    const notification = document.createElement('div');
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 10001;
      padding: 15px 20px;
      border-radius: 4px;
      color: white;
      font-size: 14px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.3);
      max-width: 300px;
      word-wrap: break-word;
      ${type === 'success' ? 'background-color: #34a853;' : 'background-color: #ea4335;'}
    `;
    notification.textContent = message;

    document.body.appendChild(notification);

    // 3秒后自动移除
    setTimeout(() => {
      if (notification.parentNode) {
        notification.parentNode.removeChild(notification);
      }
    }, 3000);
  }

  // 还原原文
  function restoreOriginalPage() {
    console.log('🔄 还原页面原文...');

    let restoredCount = 0;
    let failedCount = 0;

    // 遍历所有保存的翻译状态
    for (const [nodeId, state] of pageTranslationState) {
      try {

        if (state.type === 'text') {
          // 对于文本节点，还原原始文本
          try {
            if (state.originalNode && state.newNode) {
              if (state.originalNode.parentNode && state.originalNode.parentNode.isConnected) {
                state.originalNode.parentNode.replaceChild(state.originalNode, state.newNode);
                restoredCount++;
              } else {
                const originalNode = document.createTextNode(state.originalText);
                if (state.newNode.parentNode && state.newNode.parentNode.isConnected) {
                  state.newNode.parentNode.replaceChild(originalNode, state.newNode);
                  restoredCount++;
                } else {
                  throw new Error('新节点父元素不可用');
                }
              }
            } else {
              throw new Error('缺少节点信息');
            }
          } catch (domError) {
            failedCount++;
          }
        } else if (state.type === 'text-bilingual') {
          // 对于中英对照文本节点，还原为原始文本
          try {
            if (state.wrapper && state.originalNode && state.parent) {
              if (state.parent.isConnected && state.parent.contains(state.wrapper)) {
                const insertBefore = state.nextSibling && state.nextSibling.parentNode === state.parent
                  ? state.nextSibling
                  : null;
                state.parent.insertBefore(state.originalNode, insertBefore);
                state.parent.removeChild(state.wrapper);
                restoredCount++;
              } else {
                throw new Error('父节点不可用');
              }
            } else if (state.node) {
              const originalNode = document.createTextNode(state.originalText);
              if (state.node.parentNode && state.node.parentNode.isConnected) {
                state.node.parentNode.replaceChild(originalNode, state.node);
                restoredCount++;
              } else {
                throw new Error('节点父元素不可用');
              }
            } else {
              throw new Error('缺少节点信息');
            }
          } catch (domError) {
            failedCount++;
          }
        } else if (state.type === 'element') {
          // 对于元素节点，还原原始内容
          try {
            if (state.node) {
              if (state.originalContent !== undefined) {
                state.node.textContent = state.originalContent;
              } else {
                state.node.textContent = state.originalText;
              }
              restoredCount++;
            } else {
              throw new Error('缺少节点信息');
            }
          } catch (domError) {
            failedCount++;
          }
        } else if (state.type === 'element-bilingual') {
          // 对于中英对照元素节点，还原为原始 HTML
          try {
            if (state.node && state.originalHTML !== undefined) {
              if (!state.node.isConnected || !document.contains(state.node)) {
                // 如果节点已移除，尝试通过 parent 查找并还原
                if (state.parent && state.parent.isConnected) {
                  const allElements = state.parent.querySelectorAll('*');
                  let found = false;
                  for (const el of allElements) {
                    if (el.textContent.includes(state.originalText.substring(0, 20))) {
                      el.innerHTML = state.originalHTML;
                      restoredCount++;
                      found = true;
                      break;
                    }
                  }
                  if (!found) {
                    failedCount++;
                  }
                } else {
                  failedCount++;
                }
              } else {
                state.node.innerHTML = state.originalHTML;
                restoredCount++;
              }
            } else {
              throw new Error('缺少节点信息');
            }
          } catch (domError) {
            failedCount++;
          }
        }
      } catch (error) {
        failedCount++;
      }
    }

    // 清空翻译状态
    pageTranslationState.clear();
    isPageTranslated = false;

    console.log(`✅ 还原完成: ${restoredCount} 个节点\n`);
    showNotification(`已还原原文 (${restoredCount} 个节点)`, 'success');
  }

  // 显示句子翻译结果
  function showSentenceTranslation(originalText, translation, buttonElement) {
    try {
      // 直接替换原文为翻译结果
      const textSpan = buttonElement.parentElement.querySelector('.sentence-text');
      if (textSpan) {
        // 保存原始文本作为data属性
        textSpan.setAttribute('data-original-text', textSpan.textContent);
        // 替换为翻译文本
        textSpan.textContent = translation;
        // 更新按钮文本为"还原"
        buttonElement.textContent = '_undo';
        buttonElement.title = '还原原文';

        // 为按钮添加还原功能
        buttonElement.onclick = function(e) {
          e.stopPropagation();
          const original = textSpan.getAttribute('data-original-text');
          if (original) {
            textSpan.textContent = original;
            buttonElement.textContent = '译';
            buttonElement.title = '翻译';
            buttonElement.onclick = null; // 移除点击事件，恢复默认行为
          }
        };
      }

      // 检查是否有新内容需要翻译
      setTimeout(() => {
        checkAndAddNewTranslationButtons();
      }, 1000);
    } catch (error) {
      console.error('显示句子翻译结果时出错:', error);
      // 恢复按钮状态
      if (buttonElement) {
        buttonElement.textContent = '❌';
        setTimeout(() => {
          buttonElement.textContent = '译';
          buttonElement.disabled = false;
        }, 2000);
      }
    }
  }

  // ===== 内容提取功能模块 =====

  // 提取页面主要内容
  function extractMainContent() {
    // 这里保留原有的内容提取逻辑
    // 由于代码较长，此处简化处理

    console.log('提取页面主要内容...');

    // 创建TurndownService实例
    const turndownService = new TurndownService({
      headingStyle: 'atx',
      hr: '---',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      emDelimiter: '*',
      strongDelimiter: '**',
      linkStyle: 'inlined',
      linkReferenceStyle: 'full'
    });

    // 添加自定义规则
    turndownService.addRule('pre', {
      filter: 'pre',
      replacement: function(content) {
        return '\n\n```\n' + content + '\n```\n\n';
      }
    });

    // 提取主要内容容器
    let contentElement = document.querySelector('main') ||
                         document.querySelector('article') ||
                         document.querySelector('.content') ||
                         document.querySelector('#content') ||
                         document.body;

    // 转换为Markdown
    let markdown = turndownService.turndown(contentElement);

    // 清理多余的空行
    markdown = markdown.replace(/\n{3,}/g, '\n\n');

    return markdown.trim();
  }

  // ===== 初始化和事件监听 =====

  // 页面加载完成后初始化
  function initialize() {
    console.log('Content script 初始化');

    // 初始化Turndown Service
    if (typeof TurndownService !== 'undefined' && !window.turndownService) {
      window.turndownService = new TurndownService({
        headingStyle: 'atx',
        hr: '---',
        bulletListMarker: '-',
        codeBlockStyle: 'fenced',
        emDelimiter: '*',
        strongDelimiter: '**',
        linkStyle: 'inlined',
        linkReferenceStyle: 'full'
      });

      // 特殊处理pre和code标签
      window.turndownService.keep(['pre', 'code']);
      console.log('TurndownService 初始化完成');
    }

    // ===== 消息处理 =====
    /* ===== 临时注释：此处的早期消息监听器已被更完整的全局监听器替代（见文件末尾 ~2754行）。为避免重复与异常日志，注释掉该块 =====
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'showPageSelection') {
        console.log('content_script:  a0 a0 a0 a0 a0  a0 a0 a0 a0 a0 a0 a0 a0 a0 a0 a0 a0 a0 a0 a0 a0 a0  a0 a0 a0 a0 a0 a0 a0 a0 a0  a0 a0 a0 a0 a0 a0  a0 a0 a0 a0 a0  a0 a0 a0 a0 a0 a0  a0 a0 a0 a0 a0','




');
        try { console.log('content_script:  a0 a0 a0 a0 a0 showPageSelection




 links

 length:', (request.links || []).length); } catch (e) {}
        createPageSelectionModal(request.links);
        sendResponse({ success: true });
      } else if (request.action === 'extractCurrentPage') {
        // 处理提取当前页的请求
        extractCurrentPage().then(content => {
          sendResponse({
            success: true,
            content: content,
            pageTitle: document.title
          });
        }).catch(error => {
          sendResponse({
            success: false,
            error: error.message
          });
        });
        // 由于使用了异步操作，需要返回 true 来保持消息通道开放
        return true;
      }
      });
    */

    // 初始化翻译功能
    initializeTranslationFeature();
  }

  // 初始化翻译功能
  async function initializeTranslationFeature() {
    try {
      console.log('=== 翻译功能初始化开始 ===');

      // 尝试从chrome.storage获取设置，如果失败则使用默认值
      let settings;
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
          settings = await new Promise((resolve) => {
            chrome.storage.sync.get({
              enableTranslation: true,
              showTranslationButton: true, // 兼容旧开关（自动显示大按钮）
              showSmallTranslateButton: true, // 新：小翻译按钮开关
              showLargeTranslateButton: true  // 新：大翻译按钮开关
            }, (result) => {
              resolve(result);
            });
          });
          console.log('✅ 从chrome.storage获取设置成功:', settings);
        } else {
          throw new Error('chrome.storage不可用');
        }
      } catch (error) {
        console.log('⚠️ 获取设置失败，使用默认设置:', error);
        settings = { enableTranslation: true, showTranslationButton: true, showSmallTranslateButton: true, showLargeTranslateButton: true };
      }

      console.log('📋 最终使用的设置:', settings);

      // 条件1：是否启用翻译功能
      if (!settings.enableTranslation) {
        console.log('❌ 条件1不满足: 翻译功能已禁用');
        return;
      }
      console.log('✅ 条件1满足: 翻译功能已启用');

      // 记录按钮开关状态
      const largeEnabled = !!settings.showLargeTranslateButton && !!settings.showTranslationButton; // 兼容旧开关
      const smallEnabled = !!settings.showSmallTranslateButton;
      console.log(`根据设置，小按钮: ${smallEnabled ? '开启' : '关闭'}，大按钮: ${largeEnabled ? '开启' : '关闭'}`);

      console.log('🔍 开始检测页面可翻译内容...');
      detectedSegments = await detectTranslatableContent();

      if (detectedSegments.length === 0) {
        console.log('❌ 未检测到需要翻译的内容');
        console.log('💡 建议: 检查页面是否包含足够的英文内容');
        // 即使没有可翻译内容，也不再强制退出，允许仅显示大按钮作为入口
      } else {
        console.log(`✅ 检测到 ${detectedSegments.length} 个可翻译段落`);
      }

      // 按开关决定是否显示大翻译按钮（入口）
      if (largeEnabled) {
        console.log('🎉 显示大翻译按钮（入口）');
        showTranslationButton();
      } else {
        console.log('ℹ️ 已关闭大翻译按钮显示');
      }

      // 按开关决定是否注入小按钮（段落与图片）
      if (smallEnabled) {
        console.log('🎯 准备注入小翻译按钮');
        setTimeout(() => {
          try {
            addSentenceLevelTranslationButtons();
            addImageTranslationButtons();
          } catch (error) {
            console.error('添加翻译按钮失败:', error);
          }
        }, 1000);
      } else {
        console.log('ℹ️ 已关闭小翻译按钮显示');
      }

    } catch (error) {
      console.error('❌ 翻译功能初始化失败:', error);
      try {
        // 失败兜底：仅在开关允许的情况下尝试显示
        chrome.storage.sync.get({ showSmallTranslateButton: true, showLargeTranslateButton: true, showTranslationButton: true }, (cfg) => {
          if (cfg.showLargeTranslateButton && cfg.showTranslationButton) {
            try { showTranslationButton(); } catch (e) {}
          }
          if (cfg.showSmallTranslateButton) {
            setTimeout(() => { try { addSentenceLevelTranslationButtons(); addImageTranslationButtons(); } catch (e) {} }, 1000);
          }
        });
      } catch (e) {
        console.error('强制显示翻译按钮也失败:', error);
      }
    }
  }

  // 添加处理句子翻译的函数
  async function translateSentenceWithConcurrency(text) {
    // 检查缓存
    const cache = ensureTranslationCache();
    if (cache.has(text)) {
      console.log('从缓存中获取翻译结果');
      return cache.get(text);
    }

    // 控制并发数量
    while (efficientTranslationState.activeCount >= efficientTranslationState.concurrentLimit) {
      console.log('达到最大并发数，等待中...');
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    efficientTranslationState.activeCount++;
    console.log(`开始翻译句子，当前活跃请求数: ${efficientTranslationState.activeCount}`);

    try {
      const result = await translateSentence(text); // 移除多余的模型参数
      cache.set(text, result);
      return result;
    } finally {
      efficientTranslationState.activeCount--;
      console.log(`翻译完成，当前活跃请求数: ${efficientTranslationState.activeCount}`);
    }
  }

  // 添加提取当前页面内容的函数
  async function extractCurrentPage() {
    try {
      console.log('开始提取当前页面内容...');

      // 确保TurndownService已初始化
      if (!window.turndownService) {
        console.log('TurndownService未初始化，正在初始化...');
        if (typeof TurndownService !== 'undefined') {
          window.turndownService = new TurndownService({
            headingStyle: 'atx',
            hr: '---',
            bulletListMarker: '-',
            codeBlockStyle: 'fenced',
            emDelimiter: '*',
            strongDelimiter: '**',
            linkStyle: 'inlined',
            linkReferenceStyle: 'full'
          });
          window.turndownService.keep(['pre', 'code']);
        } else {
          throw new Error('TurndownService库未加载');
        }
      }

      // 查找主要内容区域
      let contentElement = document.querySelector('main') ||
                          document.querySelector('article') ||
                          document.querySelector('[role="main"]') ||
                          document.querySelector('.main-content') ||
                          document.querySelector('#main') ||
                          document.querySelector('.content') ||
                          document.querySelector('#content') ||
                          document.body;

      // 克隆元素以避免修改原始DOM
      const clonedContent = contentElement.cloneNode(true);

      // 移除不需要的元素（只移除UI相关的，保留内容）
      const selectorsToRemove = [
        'script', 'style', 'noscript', 'meta', 'link',
        'nav', 'footer', '.sidebar', '.ads', '.advertisement',
        '.cookie-banner', '.modal', '.popup', '.comment-section',
        '.related-posts', '.social-share', '.newsletter-signup',
        '.sentence-translation-button', '[data-translation-button]'
        // 注意：不再排除 button、.btn、.button 等，允许提取按钮内容
      ];

      selectorsToRemove.forEach(selector => {
        clonedContent.querySelectorAll(selector).forEach(el => el.remove());
      });

      // 注意：不再移除 onclick 属性的元素，允许提取交互元素的内容

      // 移除翻译按钮容器
      clonedContent.querySelectorAll('[data-translation-button-injected]').forEach(el => {
        const buttons = el.querySelectorAll('.sentence-translation-button');
        buttons.forEach(btn => {
          const container = btn.parentElement;
          if (container && container.tagName === 'SPAN') {
            container.remove();
          }
        });
      });

      // 使用Turndown将内容转换为Markdown
      let markdown = window.turndownService.turndown(clonedContent);

      // 清理Markdown
      markdown = markdown
        .replace(/\n{4,}/g, '\n\n')  // 移除过多空行
        .replace(/^\s*[\r\n]/gm, '')  // 移除空行
        .replace(/\[([^\]]+)\]\(javascript:[^)]*\)/g, '$1')  // 移除javascript链接
        .trim();

      if (!markdown || markdown.length < 50) {
        throw new Error('提取的内容过少或为空');
      }

      console.log('页面内容提取完成，长度:', markdown.length);

      // 获取页面标题
      const pageTitle = document.title || document.querySelector('h1')?.textContent || '未命名页面';

      // 发送结果到background script
      chrome.runtime.sendMessage({
        action: 'extractionCompleted',
        result: markdown,
        url: window.location.href,
        pageTitle: pageTitle
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('发送提取完成消息失败:', chrome.runtime.lastError.message);
        }
      });

      return markdown;
    } catch (error) {
      console.error('提取页面内容时出错:', error);
      chrome.runtime.sendMessage({
        action: 'extractionError',
        error: error.message,
        url: window.location.href
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('发送提取错误消息失败:', chrome.runtime.lastError.message);
        }
      });
      throw error;
    }
  }

  // 页面加载完成后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }

  // 添加句子级别翻译按钮 - 支持块级和内联元素
  function addSentenceLevelTranslationButtons() {
    try {
      // 选择块级元素和重要的内联元素
      const targetElements = document.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, span[data-as="p"], div.content, article, section');
      const blockElements = [];
      const processedParents = new Set();

      for (const element of targetElements) {
        // 跳过已注入按钮的元素
        if (element.hasAttribute('data-translation-button-injected')) continue;

        // 跳过在代码块内的元素
        if (element.closest('code, pre, script, style, noscript')) continue;

        // 跳过隐藏的元素
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') continue;

        // 跳过已处理的父元素的子元素
        let isChildOfProcessed = false;
        for (const parent of processedParents) {
          if (parent.contains(element) && parent !== element) {
            isChildOfProcessed = true;
            break;
          }
        }
        if (isChildOfProcessed) continue;

        const fullText = element.textContent.trim();

        // 检查是否包含可翻译内容（最小15字符）
        if (fullText.length >= 15 && containsTranslatableText(fullText)) {
          blockElements.push({
            element: element,
            text: fullText
          });
          processedParents.add(element);
        }
      }

      console.log(`找到 ${blockElements.length} 个可翻译块级元素`);

      // 为每个块级元素添加翻译按钮
      blockElements.forEach((item, index) => {
        const blockElement = item.element;
        const fullText = item.text;

        // 标记元素已注入按钮，防止重复
        blockElement.setAttribute('data-translation-button-injected', 'true');
        // 保存原始 HTML 用于还原
        blockElement.setAttribute('data-original-html', blockElement.innerHTML);

        // 创建翻译按钮容器
        const buttonContainer = document.createElement('span');
        buttonContainer.style.cssText = `
          position: relative;
          display: inline-block;
          margin-right: 4px;
          vertical-align: middle;
        `;

        // 创建翻译按钮
        const button = document.createElement('button');
        button.className = 'sentence-translation-button';
        button.textContent = '译';
        button.dataset.blockIndex = index;
        button.dataset.blockText = fullText;
        button.dataset.isTranslated = 'false';
        button.style.cssText = `
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: linear-gradient(135deg, #007BFF, #28a745);
          color: white;
          border: none;
          font-size: 9px;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 0;
          margin: 0;
          box-shadow: 0 1px 2px rgba(0,0,0,0.2);
          transition: all 0.2s ease;
          z-index: 100;
          flex-shrink: 0;
          vertical-align: middle;
        `;

        // 添加按钮悬停效果
        button.addEventListener('mouseenter', function() {
          this.style.transform = 'scale(1.15)';
          this.style.boxShadow = '0 2px 6px rgba(0,0,0,0.4)';
        });

        button.addEventListener('mouseleave', function() {
          this.style.transform = 'scale(1)';
          this.style.boxShadow = '0 1px 2px rgba(0,0,0,0.2)';
        });

        // 添加翻译功能
        button.addEventListener('click', async function(e) {
          e.stopPropagation();
          const blockText = this.dataset.blockText;
          const buttonElement = this;
          const isTranslated = buttonElement.dataset.isTranslated === 'true';

          if (buttonElement.disabled) return;

          // 如果已翻译，则还原原文
          if (isTranslated) {
            const originalHtml = blockElement.getAttribute('data-original-html');
            if (originalHtml) {
              blockElement.innerHTML = originalHtml;
              // 重新插入按钮
              blockElement.insertBefore(buttonContainer, blockElement.firstChild);
              buttonElement.textContent = '译';
              buttonElement.title = '翻译';
              buttonElement.dataset.isTranslated = 'false';
            }
            return;
          }

          const originalText = buttonElement.textContent;
          buttonElement.textContent = '...';
          buttonElement.disabled = true;

          // 获取用户设置
          chrome.storage.sync.get({ bilingualMode: false }, (settings) => {
            chrome.runtime.sendMessage({
              action: 'translateSentence',
              text: blockText
            }, (response) => {
              if (chrome.runtime.lastError) {
                console.error('块翻译失败:', chrome.runtime.lastError.message);
                buttonElement.textContent = '❌';
                setTimeout(() => {
                  buttonElement.textContent = originalText;
                  buttonElement.disabled = false;
                }, 2000);
                return;
              }

              if (response && response.success) {
                console.log('源文本:', blockText);
                console.log('翻译结果:', response.translation);

                if (settings.bilingualMode) {
                  // 中英对照模式：显示原文和翻译
                  blockElement.innerHTML = blockText + '<br>' + response.translation;
                } else {
                  // 覆盖模式：只显示翻译
                  blockElement.textContent = response.translation;
                }
                blockElement.insertBefore(buttonContainer, blockElement.firstChild);
                buttonElement.textContent = '↩';
                buttonElement.title = '还原原文';
                buttonElement.dataset.isTranslated = 'true';
                buttonElement.disabled = false;
              } else {
                console.error('块翻译失败:', response ? response.error : '未知错误');
                buttonElement.textContent = '❌';
                setTimeout(() => {
                  buttonElement.textContent = originalText;
                  buttonElement.disabled = false;
                }, 2000);
              }
            });
          });
        });

        // 将按钮添加到容器中
        buttonContainer.appendChild(button);
        // 将容器插入到块级元素的最前面
        blockElement.insertBefore(buttonContainer, blockElement.firstChild);
      });
    } catch (error) {
      console.error('添加句子级别翻译按钮时发生错误:', error);
    }
  }

  // 为图片元素添加翻译按钮
  function addImageTranslationButtons() {
    try {
      const images = document.querySelectorAll('img');
      console.log(`找到 ${images.length} 个图片元素`);

      images.forEach((img, index) => {
        // 防止重复注入
        if (img.closest('[data-translation-button-injected]')) return;

        // 跳过隐藏的图片
        const style = window.getComputedStyle(img);
        if (style.display === 'none' || style.visibility === 'hidden') return;

        // 跳过太小的图片（宽度或高度小于50px）
        if (img.width < 50 || img.height < 50) return;

        // 创建图片容器包装器
        const wrapper = document.createElement('div');
        wrapper.style.cssText = `
          position: relative;
          display: inline-block;
          margin: 0;
          padding: 0;
        `;
        wrapper.setAttribute('data-translation-button-injected', 'true');

        // 将原图片移到包装器内
        img.parentNode.insertBefore(wrapper, img);
        wrapper.appendChild(img);

        // 创建翻译按钮容器
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = `
          position: absolute;
          top: 5px;
          right: 5px;
          z-index: 101;
          display: flex;
          gap: 4px;
        `;

        // 创建翻译按钮
        const button = document.createElement('button');
        button.className = 'image-translation-button';
        button.textContent = '🖼️';
        button.dataset.imageIndex = index;
        button.dataset.imageUrl = img.src || img.currentSrc;
        button.dataset.isTranslated = 'false';
        button.title = '翻译图片中的文字';
        button.style.cssText = `
          width: 28px;
          height: 28px;
          border-radius: 4px;
          background: linear-gradient(135deg, #FF6B6B, #FFA500);
          color: white;
          border: none;
          font-size: 14px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0;
          margin: 0;
          box-shadow: 0 2px 8px rgba(0,0,0,0.3);
          transition: all 0.2s ease;
          flex-shrink: 0;
        `;

        // 添加按钮悬停效果
        button.addEventListener('mouseenter', function() {
          this.style.transform = 'scale(1.1)';
          this.style.boxShadow = '0 3px 12px rgba(0,0,0,0.4)';
        });

        button.addEventListener('mouseleave', function() {
          this.style.transform = 'scale(1)';
          this.style.boxShadow = '0 2px 8px rgba(0,0,0,0.3)';
        });

        // 添加图片翻译功能
        button.addEventListener('click', async function(e) {
          e.stopPropagation();
          const imageUrl = this.dataset.imageUrl;
          const buttonElement = this;
          const isTranslated = buttonElement.dataset.isTranslated === 'true';

          if (buttonElement.disabled) return;

          // 如果已翻译，则还原原图
          if (isTranslated) {
            img.src = imageUrl;
            buttonElement.textContent = '🖼️';
            buttonElement.title = '翻译图片中的文字';
            buttonElement.dataset.isTranslated = 'false';
            return;
          }

          const originalText = buttonElement.textContent;
          buttonElement.textContent = '⏳';
          buttonElement.disabled = true;

          console.log(`图片翻译请求: ${imageUrl}`);

          // 发送翻译请求到 background
          chrome.runtime.sendMessage({
            action: 'translateImage',
            imageUrl: imageUrl
          }, (response) => {
            if (chrome.runtime.lastError) {
              console.error('图片翻译失败:', chrome.runtime.lastError.message);
              buttonElement.textContent = '❌';
              setTimeout(() => {
                buttonElement.textContent = originalText;
                buttonElement.disabled = false;
              }, 2000);
              return;
            }

            if (response && response.success && response.translatedImageUrl) {
              console.log(`图片翻译完成: ${response.translatedImageUrl}`);

              // 检查是否是JSON格式的翻译数据
              if (response.translatedImageUrl.startsWith('data:application/json')) {
                try {
                  const jsonData = JSON.parse(atob(response.translatedImageUrl.split(',')[1]));
                  // 在Canvas上绘制翻译文字
                  drawTranslatedTextOnImage(img, jsonData.imageUrl, jsonData.translatedText).then(dataUrl => {
                    img.src = dataUrl;
                    buttonElement.textContent = '↩';
                    buttonElement.title = '还原原图';
                    buttonElement.dataset.isTranslated = 'true';
                    buttonElement.disabled = false;
                  }).catch(error => {
                    console.error('绘制翻译文字失败:', error);
                    buttonElement.textContent = '❌';
                    setTimeout(() => {
                      buttonElement.textContent = originalText;
                      buttonElement.disabled = false;
                    }, 2000);
                  });
                } catch (error) {
                  console.error('解析翻译数据失败:', error);
                  buttonElement.textContent = '❌';
                  setTimeout(() => {
                    buttonElement.textContent = originalText;
                    buttonElement.disabled = false;
                  }, 2000);
                }
              } else {
                // 直接使用返回的图片URL
                img.src = response.translatedImageUrl;
                buttonElement.textContent = '↩';
                buttonElement.title = '还原原图';
                buttonElement.dataset.isTranslated = 'true';
                buttonElement.disabled = false;
              }
            } else {
              console.error('图片翻译失败:', response ? response.error : '未知错误');
              buttonElement.textContent = '❌';
              setTimeout(() => {
                buttonElement.textContent = originalText;
                buttonElement.disabled = false;
              }, 2000);
            }
          });
        });

        buttonContainer.appendChild(button);
        wrapper.appendChild(buttonContainer);
      });

      console.log('图片翻译按钮注入完成');
    } catch (error) {
      console.error('添加图片翻译按钮失败:', error);
    }
  }

  // 在图片上绘制翻译文字
  function drawTranslatedTextOnImage(imageUrl, translatedText) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';

      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');

        // 绘制原图
        ctx.drawImage(img, 0, 0);

        // 设置文字样式
        const fontSize = Math.max(12, Math.floor(img.width / 30));
        ctx.font = `bold ${fontSize}px Arial, sans-serif`;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.lineWidth = 2;
        ctx.textAlign = 'left';

        // 在图片底部绘制翻译文字
        const padding = 10;
        const lineHeight = fontSize + 5;
        const maxWidth = img.width - 2 * padding;
        const lines = wrapTextForCanvas(translatedText, ctx, maxWidth);

        let y = img.height - padding - (lines.length * lineHeight);
        y = Math.max(padding, y);

        // 绘制半透明背景
        const bgHeight = lines.length * lineHeight + 2 * padding;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(padding, y - padding, maxWidth, bgHeight);

        // 绘制文字
        ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
        lines.forEach((line, index) => {
          const lineY = y + (index * lineHeight) + fontSize;
          ctx.strokeText(line, padding + 2, lineY);
          ctx.fillText(line, padding + 2, lineY);
        });

        // 转换为Data URL
        const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
        resolve(dataUrl);
      };

      img.onerror = () => {
        reject(new Error('图片加载失败'));
      };

      img.src = imageUrl;
    });
  }

  // 文字换行辅助函数
  function wrapTextForCanvas(text, ctx, maxWidth) {
    const chars = text.split('');
    const lines = [];
    let currentLine = '';

    for (const char of chars) {
      const testLine = currentLine + char;
      const metrics = ctx.measureText(testLine);

      if (metrics.width > maxWidth && currentLine.length > 0) {
        lines.push(currentLine);
        currentLine = char;
      } else {
        currentLine = testLine;
      }
    }

    if (currentLine.length > 0) {
      lines.push(currentLine);
    }

    return lines.slice(0, 3); // 最多显示3行
  }

  // 根据设置移除/恢复翻译按钮的辅助函数
  function removeLargeTranslateButton() {
    // 移除悬浮的大翻译按钮
    try {
      const btn = document.getElementById('page-translation-button');
      if (btn) btn.remove();
      if (typeof translationButton !== 'undefined' && translationButton) {
        try { translationButton.remove(); } catch {}
        translationButton = null;
      }
      console.log('已移除大翻译按钮');
    } catch (e) {
      console.error('移除大翻译按钮失败:', e);
    }
  }

  function removeSmallTranslateButtons() {
    try {
      // 移除句子级按钮
      document.querySelectorAll('.sentence-translation-button').forEach(btn => {
        const container = btn.parentElement; // 外层 span 容器
        if (container && container.parentElement) {
          container.remove();
        } else {
          btn.remove();
        }
      });
      // 移除图片上的按钮容器与包装器
      document.querySelectorAll('.image-translation-button').forEach(btn => {
        const container = btn.parentElement;
        if (container) container.remove();
      });
      document.querySelectorAll('[data-translation-button-injected]').forEach(el => {
        // 如果是包裹图片的 wrapper，需要将图片移回原位置
        if (el.tagName && el.tagName.toLowerCase() === 'div') {
          const img = el.querySelector('img');
          if (img && el.parentNode) {
            el.parentNode.insertBefore(img, el);
          }
        }
        el.removeAttribute('data-translation-button-injected');
      });
      console.log('已移除小翻译按钮');
    } catch (e) {
      console.error('移除小翻译按钮失败:', e);
    }
  }

  // 检查并添加新的翻译按钮
  function checkAndAddNewTranslationButtons() {
    console.log('检查是否有新内容需要添加翻译按钮');
    addSentenceLevelTranslationButtons();
    addImageTranslationButtons();
  }

  //  chrome.storage.sync  
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      const logChange = (k, c) => console.log('\u2699\ufe0f \u8bbe\u7f6e\u53d8\u66f4:', k, '=>', c.oldValue, '->', c.newValue);
      if (changes.showSmallTranslateButton) {
        logChange('showSmallTranslateButton', changes.showSmallTranslateButton);
        if (changes.showSmallTranslateButton.newValue === false) {
          removeSmallTranslateButtons();
        } else {
          //  
          addSentenceLevelTranslationButtons();
          addImageTranslationButtons();
        }
      }
      if (changes.showLargeTranslateButton || changes.showTranslationButton) {
        if (changes.showLargeTranslateButton) logChange('showLargeTranslateButton', changes.showLargeTranslateButton);
        if (changes.showTranslationButton) logChange('showTranslationButton', changes.showTranslationButton);
        const allowedLarge = (changes.showLargeTranslateButton ? changes.showLargeTranslateButton.newValue : undefined);
        const allowedAuto  = (changes.showTranslationButton ? changes.showTranslationButton.newValue : undefined);
        if (allowedLarge === false || allowedAuto === false) {
          removeLargeTranslateButton();
        } else if (allowedLarge === true || allowedAuto === true) {
          //  
          showTranslationButton();
        }
      }
    });
  }


  // ===== 翻译菜单（已翻译状态） =====
  function showTranslationMenu() {
    console.log('显示翻译菜单');

    // 移除旧菜单
    const oldMenu = document.getElementById('translation-menu');
    if (oldMenu) oldMenu.remove();

    // 创建菜单
    const menu = document.createElement('div');
    menu.id = 'translation-menu';
    menu.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.7);
      z-index: 100000;
      display: flex;
      align-items: center;
      justify-content: center;
    `;

    menu.innerHTML = `
      <div style="
        background: white;
        border-radius: 8px;
        padding: 20px;
        max-width: 400px;
        width: 80%;
        box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        position: relative;
      ">
        <h2 style="margin-top: 0; color: #333;">页面翻译</h2>
        <p style="color: #666; margin-bottom: 20px;">页面已翻译，请选择操作：</p>
        <div style="display: flex; flex-direction: column; gap: 10px;">
          <button id="showOriginal" style="
            padding: 12px 16px;
            background: #6c757d;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            transition: background 0.2s;
          ">📄 显示原文</button>
          <button id="retranslate" style="
            padding: 12px 16px;
            background: #007bff;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            transition: background 0.2s;
          ">🔄 重新翻译</button>
          <button id="cancelMenu" style="
            padding: 12px 16px;
            background: white;
            color: #333;
            border: 1px solid #ccc;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            transition: background 0.2s;
          ">取消</button>
        </div>
      </div>
    `;

    document.body.appendChild(menu);

    // 添加事件监听
    const showOriginalBtn = menu.querySelector('#showOriginal');
    const retranslateBtn = menu.querySelector('#retranslate');
    const cancelBtn = menu.querySelector('#cancelMenu');

    showOriginalBtn.addEventListener('click', () => {
      restoreOriginalPage();
      menu.remove();
    });

    retranslateBtn.addEventListener('click', async () => {
      menu.remove();
      // 重新翻译前先还原页面，清空旧的翻译状态
      console.log('🔄 重新翻译：先还原页面...');
      restoreOriginalPage();

      // 等待还原完成后再开始翻译
      setTimeout(async () => {
        console.log('🔄 重新翻译：开始新的翻译...');
        await handleTranslationRequest();
      }, 100);
    });

    cancelBtn.addEventListener('click', () => {
      menu.remove();
    });

    // 添加按钮悬停效果
    [showOriginalBtn, retranslateBtn].forEach(btn => {
      btn.addEventListener('mouseenter', function() {
        this.style.opacity = '0.9';
        this.style.transform = 'translateY(-2px)';
      });
      btn.addEventListener('mouseleave', function() {
        this.style.opacity = '1';
        this.style.transform = 'translateY(0)';
      });
    });

    // 点击背景关闭菜单
    menu.addEventListener('click', (e) => {
      if (e.target === menu) {
        menu.remove();
      }
    });
  }

  // ===== 翻译模态框显示函数 =====
  function showTranslationModal() {
    console.log('显示翻译模态框');

    // 删除旧的模态框（确保每次都是全新的，避免样式污染）
    if (translationModal && translationModal.parentNode) {
      translationModal.remove();
    }

    // 创建翻译模态框
    translationModal = document.createElement('div');
    translationModal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.7);
      z-index: 100000;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0;
      padding: 0;
      border: none;
    `;

    translationModal.innerHTML = `
      <div style="
        background: white;
        border-radius: 8px;
        padding: 20px;
        max-width: 500px;
        width: 80%;
        box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        position: absolute;
        margin: 0;
        border: none;
      ">
        <h2 style="margin-top: 0; color: #333;">页面翻译</h2>
        <p>检测到页面中有 ${detectedSegments.length} 段可翻译内容。</p>
        <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px;">
          <button id="cancelTranslation" style="
            padding: 8px 16px;
            border: 1px solid #ccc;
            background: white;
            border-radius: 4px;
            cursor: pointer;
          ">取消</button>
          <button id="confirmTranslation" style="
            padding: 8px 16px;
            background: #007bff;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
          ">开始翻译</button>
        </div>
      </div>
    `;

    document.body.appendChild(translationModal);

    // 添加事件监听器
    const cancelButton = translationModal.querySelector('#cancelTranslation');
    const confirmButton = translationModal.querySelector('#confirmTranslation');

    cancelButton.addEventListener('click', () => {
      translationModal.style.display = 'none';
    });

    confirmButton.addEventListener('click', async () => {
      translationModal.style.display = 'none';
      await handleTranslationRequest();
    });
  }

  // ===== 翻译功能 =====
  async function translateAllSegments() {
    const checkboxes = document.querySelectorAll('#translation-list input[type="checkbox"]:checked');
    isTranslationCancelled = false;

    // 显示停止按钮
    const stopBtn = document.getElementById('stop-translation-btn');
    if (stopBtn) {
      stopBtn.style.display = 'inline-block';
    }

    // 收集所有需要翻译的段落索引
    const indicesToTranslate = [];
    for (let i = 0; i < checkboxes.length; i++) {
      if (isTranslationCancelled) {
        console.log('翻译被用户停止');
        break;
      }

      const index = parseInt(checkboxes[i].id.replace('segment-', ''));
      indicesToTranslate.push(index);
    }

    // 如果有需要翻译的段落，执行翻译（使用并发处理提高速度）
    if (indicesToTranslate.length > 0) {
      const concurrencyLimit = 10;  // 同时处理 10 个请求（提升并发数以加快翻译速度）

      // 并发翻译所有选中的段落
      for (let i = 0; i < indicesToTranslate.length; i += concurrencyLimit) {
        if (isTranslationCancelled) {
          console.log('翻译被用户停止');
          break;
        }

        // 获取当前批次的段落索引
        const batchIndices = indicesToTranslate.slice(i, i + concurrencyLimit);

        // 并发翻译这一批段落
        const batchPromises = batchIndices.map(index => translateSegment(index));
        await Promise.all(batchPromises);

        // 批次之间添加小延迟，避免 API 过于频繁调用
        if (i + concurrencyLimit < indicesToTranslate.length) {
          await new Promise(resolve => setTimeout(resolve, 50));  // 减少延迟从 100ms 到 50ms
        }
      }
    }

    // 隐藏停止按钮
    if (stopBtn) {
      stopBtn.style.display = 'none';
    }
  }

  // 验证翻译结果，过滤掉异常内容
  function validateTranslationResult(translation, originalText) {
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

  // 添加处理句子翻译的函数（只翻译纯文本，不翻译 HTML）
  async function translateSentence(text, isHtml = false) {
    // 注意：即使 isHtml 为 true，我们也只翻译纯文本内容，不翻译 HTML 标签或属性
    console.log(`开始翻译文本:`, text.substring(0, 50) + '...');

    try {
      // 使用缓存的配置，避免每次翻译都重新获取
      const config = await getConfigCached();

      const apiKey = config.OPENROUTER_API_KEY;
      if (!apiKey) {
        console.error('❌ API 密钥未配置，config:', config);
        throw new Error('未配置 OpenRouter API 密钥');
      }

      // 使用统一的纯文本翻译 prompt（不翻译 HTML 属性）
      let systemPrompt = `You are a professional translator specializing in accurate, natural translations. Your task is to translate text to Chinese.

CRITICAL RULES - FOLLOW STRICTLY:
1. Output ONLY the translated text in Chinese - nothing else
2. Do NOT include explanations, notes, metadata, or any commentary
3. Do NOT include the original text or any reference to it
4. Do NOT include phrases like "translation:", "translating", "placeholder", "here is", "the translation is"
5. Preserve ALL formatting: parentheses (), brackets [], braces {}, punctuation marks, line breaks
6. Preserve code blocks, URLs, email addresses, and technical terms exactly as they appear
7. For mixed-language content (e.g., "English text (中文)"), translate only the non-Chinese parts
8. Keep numbers, special characters, and symbols unchanged
9. Maintain proper spacing and punctuation in Chinese
10. If text contains code or technical content, preserve it exactly and only translate comments/strings
11. Do NOT translate proper nouns, product or brand names (e.g., OpenAI, Anthropic, Claude, ChatGPT, Cursor, VS Code, Visual Studio Code, GitHub, LangChain, LangGraph, Mintlify, Next.js, React) — keep them exactly as-is
12. Do NOT translate filenames or file paths — any token that looks like a filename (contains an extension like .txt, .md, .json, .js, .ts, .tsx, .py, .java, .go, .rs, .c, .cpp, .yml, .yaml, .toml, .ini, .cfg, .pdf) or contains '/' or '\\' should be preserved unchanged

OUTPUT FORMAT: Pure translated text only, no additional content whatsoever.`;

      // 构造请求
      const requestBody = {
        model: config.TRANSLATION_MODEL || 'google/gemini-2.5-flash-lite',
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: isHtml
              ? `Translate this HTML to Chinese: ${text}`
              : `Translate this text to Chinese: ${text}`
          }
        ],
        temperature: config.TRANSLATION_TEMPERATURE || 0.2,
        top_p: config.TRANSLATION_TOP_P || 0.95,
        max_tokens: config.TRANSLATION_MAX_TOKENS || 1000
      };

      // 发送请求
      const response = await fetch(config.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': config.HTTP_REFERER || 'https://github.com/your-username/browser-plugin',
          'X-Title': config.X_TITLE || 'Browser Plugin'
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API请求失败: ${response.status} ${errorText}`);
      }

      const data = await response.json();
      let translation = data.choices?.[0]?.message?.content?.trim();

      if (!translation) {
        throw new Error('翻译结果为空');
      }

      // 验证翻译结果（纯文本翻译）
      translation = validateTranslationResult(translation, text);

      console.log(`翻译成功:`, translation.substring(0, 50) + '...');
      return translation;
    } catch (error) {
      console.error(`翻译失败:`, error);
      throw error;
    }
  }

  // 添加处理句子翻译的函数

  // ===== 消息处理 =====
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'showPageSelection') {
      createPageSelectionModal(request.links);
      sendResponse({ success: true });
    } else if (request.action === 'extractCurrentPage') {
      // 处理“提取当前页”请求（异步）
      console.log('content_script: 收到 extractCurrentPage 指令，开始提取...');
      try {
        extractCurrentPage().then((content) => {
          console.log('content_script: 提取完成，长度:', (content || '').length);
          sendResponse({ success: true, content, pageTitle: document.title });
        }).catch((err) => {
          console.error('content_script: 提取失败:', err);
          sendResponse({ success: false, error: err?.message || String(err) });
        });
      } catch (err) {
        console.error('content_script: 提取触发异常:', err);
        sendResponse({ success: false, error: err?.message || String(err) });
      }
      return true; // 异步响应
    }
  });
})();