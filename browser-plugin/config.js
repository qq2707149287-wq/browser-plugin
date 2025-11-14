/**
 * 配置管理模块
 * 从 .env 文件或 chrome.storage 加载配置
 * 
 * 使用方式：
 * const config = await loadConfig();
 * const apiKey = config.OPENROUTER_API_KEY;
 */

// 默认配置值（当 .env 文件不存在时使用）
const DEFAULT_CONFIG = {
  // API 配置
  OPENROUTER_API_KEY: '',  // 请在设置页面配置或使用 .env 文件
  OPENROUTER_API_URL: 'https://openrouter.ai/api/v1/chat/completions',

  // 模型配置
  TRANSLATION_MODEL: 'google/gemini-2.5-flash-lite',  // 默认使用 Gemini 2.5 Flash Lite（推荐）
  IMAGE_RECOGNITION_MODEL: 'google/gemini-2.5-flash-lite',

  // 请求配置
  HTTP_REFERER: 'https://github.com/your-username/browser-plugin',
  X_TITLE: 'Browser Plugin',
  TRANSLATION_TIMEOUT: 30000,
  IMAGE_RECOGNITION_TIMEOUT: 30000,

  // 翻译参数
  TRANSLATION_TEMPERATURE: 0.2,
  TRANSLATION_TOP_P: 0.95,
  TRANSLATION_MAX_TOKENS: 1000,
  IMAGE_RECOGNITION_MAX_TOKENS: 2000,

  // 爬虫配置
  MIN_CONTENT_LENGTH: 30,
  MAX_CONCURRENT_TABS: 2,
  MAX_PAGES: 50,
  REQUEST_DELAY: 1000,
  RETRY_ATTEMPTS: 3,
  EXTRACTION_TIMEOUT: 20000,

  // 功能开关
  ENABLE_TRANSLATION: true,
  SHOW_SMALL_TRANSLATE_BUTTON: true,
  SHOW_LARGE_TRANSLATE_BUTTON: true,
  BILINGUAL_MODE: false,

  // 导出配置
  EXPORT_LANGUAGE: 'original',
  INCLUDE_CODE_BLOCKS: true,
  INCLUDE_IMAGES: false,
  REMOVE_NAVIGATION: true,
  HEADING_STYLE: 'atx',
  CODE_BLOCK_STYLE: 'fenced',
  INCLUDE_TOC: false
};

/**
 * 从 chrome.storage 加载配置
 * @returns {Promise<Object>} 配置对象
 */
async function loadConfigFromStorage() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_CONFIG, (result) => {
      resolve(result || DEFAULT_CONFIG);
    });
  });
}

/**
 * 从 .env 文件加载配置（仅在开发环境）
 * @returns {Promise<Object>} 配置对象
 */
async function loadConfigFromEnv() {
  try {
    // 尝试从 .env 文件加载
    const response = await fetch(chrome.runtime.getURL('.env'));
    if (!response.ok) {
      console.warn('未找到 .env 文件，使用默认配置');
      return DEFAULT_CONFIG;
    }

    const envText = await response.text();
    const config = { ...DEFAULT_CONFIG };

    // 解析 .env 文件
    const lines = envText.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      
      // 跳过注释和空行
      if (!trimmed || trimmed.startsWith('#')) continue;

      const [key, ...valueParts] = trimmed.split('=');
      if (!key) continue;

      const value = valueParts.join('=').trim();
      
      // 移除引号
      const cleanValue = value.replace(/^["']|["']$/g, '');

      // 类型转换
      if (cleanValue === 'true') {
        config[key.trim()] = true;
      } else if (cleanValue === 'false') {
        config[key.trim()] = false;
      } else if (!isNaN(cleanValue) && cleanValue !== '') {
        config[key.trim()] = Number(cleanValue);
      } else {
        config[key.trim()] = cleanValue;
      }
    }

    return config;
  } catch (error) {
    console.warn('加载 .env 文件失败:', error);
    return DEFAULT_CONFIG;
  }
}

/**
 * 加载配置（优先级：chrome.storage > .env > 默认值）
 * @returns {Promise<Object>} 配置对象
 */
async function loadConfig() {
  try {
    // 首先尝试从 chrome.storage 加载
    const storageConfig = await loadConfigFromStorage();
    
    // 如果 storage 中有自定义配置，使用它
    if (storageConfig && Object.keys(storageConfig).length > 0) {
      return storageConfig;
    }

    // 否则尝试从 .env 文件加载
    return await loadConfigFromEnv();
  } catch (error) {
    console.error('加载配置失败:', error);
    return DEFAULT_CONFIG;
  }
}

/**
 * 保存配置到 chrome.storage
 * @param {Object} config 配置对象
 * @returns {Promise<void>}
 */
async function saveConfig(config) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.set(config, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        console.log('配置已保存');
        resolve();
      }
    });
  });
}

/**
 * 获取单个配置值
 * @param {string} key 配置键
 * @param {*} defaultValue 默认值
 * @returns {Promise<*>} 配置值
 */
async function getConfigValue(key, defaultValue = null) {
  const config = await loadConfig();
  return config[key] !== undefined ? config[key] : (defaultValue || DEFAULT_CONFIG[key]);
}

/**
 * 设置单个配置值
 * @param {string} key 配置键
 * @param {*} value 配置值
 * @returns {Promise<void>}
 */
async function setConfigValue(key, value) {
  const config = await loadConfig();
  config[key] = value;
  return saveConfig(config);
}

// 导出函数（支持 ES6 模块和 CommonJS）
export {
  loadConfig,
  loadConfigFromStorage,
  loadConfigFromEnv,
  saveConfig,
  getConfigValue,
  setConfigValue,
  DEFAULT_CONFIG
};

// CommonJS 兼容性
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    loadConfig,
    loadConfigFromStorage,
    loadConfigFromEnv,
    saveConfig,
    getConfigValue,
    setConfigValue,
    DEFAULT_CONFIG
  };
}

