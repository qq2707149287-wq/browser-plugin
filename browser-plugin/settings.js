// settings.js - 设置页面逻辑
document.addEventListener('DOMContentLoaded', () => {
  const saveButton = document.getElementById('saveButton');
  const resetButton = document.getElementById('resetButton');
  const statusMessage = document.getElementById('statusMessage');

  // 获取或创建"刷新模型列表"按钮
  let refreshModelsButton = document.getElementById('refreshModelsButton');
  if (!refreshModelsButton) {
    refreshModelsButton = document.createElement('button');
    refreshModelsButton.id = 'refreshModelsButton';
    refreshModelsButton.textContent = '🔄 刷新模型列表';
    refreshModelsButton.style.cssText = `
      padding: 8px 16px;
      margin-left: 10px;
      background-color: #28a745;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
    `;

    // 将按钮插入到翻译模型选择框旁边
    const translationModelSelect = document.getElementById('translationModel');
    if (translationModelSelect && translationModelSelect.parentElement) {
      translationModelSelect.parentElement.appendChild(refreshModelsButton);
    }
  }

  // 默认设置
  const defaultSettings = {
    minContentLength: 30, // 降低最小内容长度要求
    includeCodeBlocks: true,
    includeImages: false, // 默认不包含图片链接
    removeNavigation: true,
    maxConcurrentTabs: 2,
    maxPages: 50,
    requestDelay: 1000,
    retryAttempts: 3,
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    includeToc: false,
    extractionTimeout: 20000, // 添加提取超时设置（20秒）
    enableTranslation: true, // 启用自动翻译
    showTranslationButton: true, // 页面加载时显示翻译按钮（兼容旧开关：控制是否自动显示大按钮）
    showSmallTranslateButton: true, // 新：小翻译按钮（段落/图片旁）
    showLargeTranslateButton: true, // 新：大翻译按钮（悬浮入口）
    bilingualMode: false, // 中英对照模式
    exportLanguage: 'original', // 导出语言设置
    translationModel: 'google/gemini-2.5-flash-lite', // 翻译模型选择
    debugMode: false // 调试模式
  };

  // 保存当前设置的副本，用于比较是否有改变
  let currentSettings = {};

  // 加载设置
  function loadSettings() {
    chrome.storage.sync.get(defaultSettings, (settings) => {
      // 保存当前设置的副本
      currentSettings = JSON.parse(JSON.stringify(settings));

      document.getElementById('minContentLength').value = settings.minContentLength;
      document.getElementById('includeCodeBlocks').checked = settings.includeCodeBlocks;
      document.getElementById('includeImages').checked = settings.includeImages;
      document.getElementById('removeNavigation').checked = settings.removeNavigation;
      document.getElementById('maxConcurrentTabs').value = settings.maxConcurrentTabs;
      document.getElementById('maxPages').value = settings.maxPages;
      document.getElementById('requestDelay').value = settings.requestDelay;
      document.getElementById('retryAttempts').value = settings.retryAttempts;
      document.getElementById('headingStyle').value = settings.headingStyle;
      document.getElementById('codeBlockStyle').value = settings.codeBlockStyle;
      document.getElementById('includeToc').checked = settings.includeToc;
      document.getElementById('extractionTimeout').value = settings.extractionTimeout;
      document.getElementById('enableTranslation').checked = settings.enableTranslation;
      document.getElementById('showTranslationButton').checked = settings.showTranslationButton;
      document.getElementById('bilingualMode').checked = settings.bilingualMode;
      document.getElementById('showSmallTranslateButton').checked = settings.showSmallTranslateButton;
      document.getElementById('showLargeTranslateButton').checked = settings.showLargeTranslateButton;
      document.getElementById('translationModel').value = settings.translationModel;
      document.getElementById('debugMode').checked = settings.debugMode;
      console.log('设置已加载:', settings);

      document.getElementById('exportLanguage').value = settings.exportLanguage;

      // 更新调试模式信息显示
      updateDebugModeInfo();
    });
  }

  // 保存设置
  function saveSettings() {
    const settings = {
      minContentLength: parseInt(document.getElementById('minContentLength').value),
      includeCodeBlocks: document.getElementById('includeCodeBlocks').checked,
      includeImages: document.getElementById('includeImages').checked,
      removeNavigation: document.getElementById('removeNavigation').checked,
      maxConcurrentTabs: parseInt(document.getElementById('maxConcurrentTabs').value),
      maxPages: parseInt(document.getElementById('maxPages').value),
      requestDelay: parseInt(document.getElementById('requestDelay').value),
      retryAttempts: parseInt(document.getElementById('retryAttempts').value),
      headingStyle: document.getElementById('headingStyle').value,
      codeBlockStyle: document.getElementById('codeBlockStyle').value,
      includeToc: document.getElementById('includeToc').checked,
      extractionTimeout: parseInt(document.getElementById('extractionTimeout').value),
      enableTranslation: document.getElementById('enableTranslation').checked,
      showTranslationButton: document.getElementById('showTranslationButton').checked,
      showSmallTranslateButton: document.getElementById('showSmallTranslateButton').checked,
      showLargeTranslateButton: document.getElementById('showLargeTranslateButton').checked,
      bilingualMode: document.getElementById('bilingualMode').checked,
      exportLanguage: document.getElementById('exportLanguage').value,
      translationModel: document.getElementById('translationModel').value,
      debugMode: document.getElementById('debugMode').checked
    };

    console.log('准备保存设置:', settings);

    // 检查设置是否有改变
    const hasChanges = JSON.stringify(settings) !== JSON.stringify(currentSettings);
    const oldModel = currentSettings.translationModel;
    const newModel = settings.translationModel;

    chrome.storage.sync.set(settings, () => {
      if (chrome.runtime.lastError) {
        showStatus('❌ 保存失败: ' + chrome.runtime.lastError.message, 'error');
      } else {
        if (!hasChanges) {
          // 没有任何改变
          showStatus('ℹ️ 设置未改变', 'info');
        } else {
          // 检查是否改变了翻译模型
          if (oldModel !== newModel) {
            showStatus(`✅ 设置保存成功 - 翻译模型已改为: ${newModel}`, 'success');
          } else {
            showStatus('✅ 设置保存成功', 'success');
          }
        }

        // 更新保存的设置副本
        currentSettings = JSON.parse(JSON.stringify(settings));

        // 更新调试模式信息显示
        updateDebugModeInfo();
      }
    });
  }

  // 重置设置
  function resetSettings() {
    chrome.storage.sync.set(defaultSettings, () => {
      loadSettings();
      showStatus('已重置为默认设置', 'success');
    });
  }

  // 显示状态消息
  function showStatus(message, type) {
    statusMessage.textContent = message;
    statusMessage.className = `status ${type}`;
    setTimeout(() => {
      statusMessage.textContent = '';
      statusMessage.className = 'status';
    }, 3000);
  }

  // 动态获取模型列表
  async function fetchAvailableModels() {
    try {
      showStatus('正在获取模型列表...', 'success');
      refreshModelsButton.disabled = true;

      // 从 background 获取 API 配置
      const config = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'getConfig' }, (response) => {
          resolve(response || {});
        });
      });

      const apiUrl = config.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1';
      const apiKey = config.OPENROUTER_API_KEY;

      if (!apiKey) {
        showStatus('❌ API 密钥未配置，无法获取模型列表', 'error');
        refreshModelsButton.disabled = false;
        return;
      }

      // 调用 API 获取模型列表
      const response = await fetch(`${apiUrl}/models`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`API 请求失败: ${response.status}`);
      }

      const data = await response.json();
      const models = data.data || [];

      if (models.length === 0) {
        showStatus('⚠️ 未获取到模型列表', 'error');
        refreshModelsButton.disabled = false;
        return;
      }

      // 更新模型选择下拉菜单
      const translationModelSelect = document.getElementById('translationModel');
      const currentValue = translationModelSelect.value;

      // 清空现有选项
      translationModelSelect.innerHTML = '';

      // 添加获取到的模型
      models.forEach(model => {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = `${model.id} (${model.pricing?.prompt ? '💰' : '✓'})`;
        translationModelSelect.appendChild(option);
      });

      // 恢复之前的选择（如果仍然存在）
      if (Array.from(translationModelSelect.options).some(opt => opt.value === currentValue)) {
        translationModelSelect.value = currentValue;
      }

      showStatus(`✅ 成功获取 ${models.length} 个模型`, 'success');
      refreshModelsButton.disabled = false;
    } catch (error) {
      console.error('获取模型列表失败:', error);
      showStatus(`❌ 获取模型列表失败: ${error.message}`, 'error');
      refreshModelsButton.disabled = false;
    }
  }

  // 更新调试模式信息显示
  function updateDebugModeInfo() {
    const debugMode = document.getElementById('debugMode').checked;
    const debugModeInfo = document.getElementById('debugModeInfo');
    if (debugModeInfo) {
      debugModeInfo.style.display = debugMode ? 'block' : 'none';
    }
  }

  // 事件监听
  saveButton.addEventListener('click', saveSettings);
  resetButton.addEventListener('click', resetSettings);
  refreshModelsButton.addEventListener('click', fetchAvailableModels);

  // 调试模式开关事件
  const debugModeCheckbox = document.getElementById('debugMode');
  if (debugModeCheckbox) {
    debugModeCheckbox.addEventListener('change', updateDebugModeInfo);
  }

  // 加载设置
  loadSettings();
});