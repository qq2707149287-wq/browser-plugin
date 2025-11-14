(function() {
    'use strict';

    // 获取DOM元素
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');
    const progressPercent = document.getElementById('progress-percent');
    const currentUrlElement = document.getElementById('current-url');
    const statusElement = document.getElementById('status');
    const resultsSection = document.getElementById('results-section');
    const tabsHeader = document.getElementById('tabs-header');
    const tabContent = document.getElementById('tab-content');

    // 批量操作相关元素
    const selectAllCheckbox = document.getElementById('select-all');
    const pagesCount = document.getElementById('pages-count');
    const copyAllBtn = document.getElementById('copy-all-btn');
    const downloadSelectedBtn = document.getElementById('download-selected-btn');
    const downloadAllBtn = document.getElementById('download-all-btn');
    const languageToggleBtn = document.getElementById('language-toggle');
    // 新增：ZIP 下载选项
    const zipToggleEl = document.getElementById('zip-download-toggle');

    // 数据存储
    let allPages = [];
    let tabIdCounter = 0;
    let selectedPages = new Set();
    let isRendered = false; // 防止重复渲染
    let processedUrls = new Set(); // 记录已处理的URL去重

    // 语言状态管理
    let currentLanguage = 'original'; // original, english, chinese
    let translationCache = new Map(); // 缓存翻译内容
    let isTranslating = false;

    // 状态日志管理
    let statusLogElement = null;
    let crawlLogs = [];

    // 工具函数
    function generateTabId() {
        return `tab-${++tabIdCounter}`;
    }

    // 状态日志功能
    function addStatusLog(message, type = 'info', maxEntries = 50) {
        if (!statusLogElement) {
            statusLogElement = document.getElementById('status-log');
        }

        if (!statusLogElement) return;

        const timestamp = new Date().toLocaleTimeString('zh-CN');
        const logEntry = document.createElement('div');
        logEntry.className = `log-entry ${type}`;
        logEntry.innerHTML = `
            <span>${message}</span>
            <span class="timestamp">${timestamp}</span>
        `;

        crawlLogs.unshift(logEntry);
        if (crawlLogs.length > maxEntries) {
            crawlLogs = crawlLogs.slice(0, maxEntries);
        }

        statusLogElement.innerHTML = '';
        crawlLogs.forEach(entry => statusLogElement.appendChild(entry));
    }

    function clearStatusLogs() {
        crawlLogs = [];
        if (statusLogElement) {
            statusLogElement.innerHTML = '<div class="log-entry info">系统准备就绪，等待开始抓取...</div>';
        }
    }

    function sanitizeFilename(filename) {
        return filename.replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
    }

    function generatePageFilename(page) {
        // 依据页面标题与域名生成单文件名
        const title = page.title || page.url.split('/').pop() || 'untitled';
        const domain = new URL(page.url).hostname.replace(/^www\./, '');
        return sanitizeFilename(`${domain}-${title}.md`);
    }

    // 生成 ZIP 文件名（站点_抓取结果_日期时间.zip）
    function formatDateTime(d = new Date()) {
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    }

    function generateZipFilename(pages) {
        try {
            const domains = new Set();
            (pages || []).forEach(p => { if (p?.url) { domains.add(new URL(p.url).hostname.replace(/^www\./, '')); } });
            const name = domains.size === 1 ? Array.from(domains)[0] : '多站点';
            return sanitizeFilename(`${name}_抓取结果_${formatDateTime()}.zip`);
        } catch { return sanitizeFilename(`抓取结果_${formatDateTime()}.zip`); }
    }

    // ===== 轻量级 ZIP 打包（存储方式，无压缩） =====
    // 说明：为避免引入外部库，这里实现最小可用 ZIP 生成，条目使用 STORE(0) 方法
    function makeCRCTable() {
        const table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) {
                c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            }
            table[n] = c >>> 0;
        }
        return table;
    }
    const CRC_TABLE = makeCRCTable();
    function crc32Uint8(u8) {
        let c = 0 ^ (-1);
        for (let i = 0; i < u8.length; i++) {
            c = (c >>> 8) ^ CRC_TABLE[(c ^ u8[i]) & 0xFF];
        }
        return (c ^ (-1)) >>> 0;
    }

    function toDosTimeDate(date = new Date()) {
        const time = ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1F);
        const y = date.getFullYear();
        const dateField = (((y < 1980 ? 0 : y - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0x0F) << 5) | (date.getDate() & 0x1F);
        return { time, date: dateField };
    }

    function buildZipBlob(files) {
        // files: [{ name: string, content: string }]
        const enc = new TextEncoder();
        const out = [];
        const central = [];
        let offset = 0;
        const now = new Date();
        const { time: dosTime, date: dosDate } = toDosTimeDate(now);

        function writeU16(n) { out.push(n & 0xFF, (n >>> 8) & 0xFF); offset += 2; }
        function writeU32(n) { out.push(n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF); offset += 4; }
        function writeBytes(arr) { for (let i = 0; i < arr.length; i++) { out.push(arr[i]); } offset += arr.length; }

        const localOffsets = [];

        // 写入本地文件头与数据
        files.forEach((f, idx) => {
            const nameBytes = enc.encode(f.name);
            const dataBytes = enc.encode(f.content);
            const crc = crc32Uint8(dataBytes);
            localOffsets.push(offset);
            // Local file header
            writeU32(0x04034b50);
            writeU16(20); // version needed
            writeU16(0);  // flags
            writeU16(0);  // method = store
            writeU16(dosTime);
            writeU16(dosDate);
            writeU32(crc);
            writeU32(dataBytes.length);
            writeU32(dataBytes.length);
            writeU16(nameBytes.length);
            writeU16(0); // extra len
            writeBytes(nameBytes);
            // data
            writeBytes(dataBytes);
            // 记录 central 目录项信息
            central.push({ nameBytes, crc, size: dataBytes.length, offset: localOffsets[localOffsets.length - 1], time: dosTime, date: dosDate });
            if ((idx + 1) % 25 === 0) { try { addStatusLog(`ZIP 打包进度: ${idx + 1}/${files.length}`, 'info'); } catch {} }
        });

        const centralStart = offset;
        // 写入中央目录
        central.forEach((c) => {
            writeU32(0x02014b50); // central header
            writeU16(20); // version made by
            writeU16(20); // version needed
            writeU16(0);  // flags
            writeU16(0);  // method = store
            writeU16(c.time);
            writeU16(c.date);
            writeU32(c.crc);
            writeU32(c.size);
            writeU32(c.size);
            writeU16(c.nameBytes.length);
            writeU16(0); // extra len
            writeU16(0); // comment len
            writeU16(0); // disk number
            writeU16(0); // internal attrs
            writeU32(0); // external attrs
            writeU32(c.offset); // relative offset
            writeBytes(c.nameBytes);
        });
        const centralSize = offset - centralStart;

        // End of central directory
        writeU32(0x06054b50);
        writeU16(0); // disk
        writeU16(0); // start disk
        writeU16(central.length);
        writeU16(central.length);
        writeU32(centralSize);
        writeU32(centralStart);
        writeU16(0); // comment len

        return new Blob([new Uint8Array(out)], { type: 'application/zip' });
    }

    function downloadZip(files, zipName) {
        const blob = buildZipBlob(files);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = zipName;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    }



    // 调用后台的并发翻译服务（支持目标语言）
    async function translateSentence(text, targetLanguage) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({
                action: 'translateSentence',
                text,
                targetLanguage
            }, (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                if (response && response.success) {
                    resolve(response.translation);
                } else {
                    reject(new Error(response?.error || '翻译失败'));
                }
            });
        });
    }

    // 语言键到显示名/目标名的映射
    function toLanguageName(langKey) {
        switch (langKey) {
            case 'chinese': return 'Chinese';
            case 'english': return 'English';
            case 'japanese': return 'Japanese';
            case 'korean': return 'Korean';
            default: return 'Chinese';
        }
    }

    // 翻译页面内容（按行处理，结合缓存）
    async function translatePageContent(content, targetLanguage) {
        if (targetLanguage === 'original') return content;

        // 先按 Markdown 代码块（```）分段，代码块内内容完全保留
        const lines = content.split('\n');
        const segments = [];
        let buf = [];
        let inFence = false;
        for (const line of lines) {
            const isFence = line.trim().startsWith('```');
            if (isFence) {
                if (!inFence) {
                    if (buf.length) {
                        segments.push({ type: 'text', text: buf.join('\n') });
                        buf = [];
                    }
                    inFence = true;
                    buf.push(line);
                } else {
                    buf.push(line);
                    segments.push({ type: 'code', text: buf.join('\n') });
                    buf = [];
                    inFence = false;
                }
            } else {
                buf.push(line);
            }
        }
        if (buf.length) segments.push({ type: inFence ? 'code' : 'text', text: buf.join('\n') });

        // 翻译文本段，保留 Markdown 前缀和行内代码 `...`
        async function translateTextBlock(block) {
            const blockLines = block.split('\n');
            const out = [];
            const targetName = toLanguageName(targetLanguage);
            const isChineseTarget = targetLanguage === 'chinese';
            for (const line of blockLines) {
                const originalLine = line;
                const trimmed = line.trim();
                if (!trimmed) { out.push(line); continue; }

                // 保留 Markdown 结构前缀（标题/列表/引用/任务）
                let prefix = '';
                let rest = line;
                const m = rest.match(/^(\s*(?:#{1,6}\s+|>+\s+|[-*+]\s+|\d+\.\s+|(?:[-*]\s{0,3}\[[ xX]\]\s+)))/);
                if (m) {
                    prefix = m[1];
                    rest = line.slice(prefix.length);
                }

                // 保护行内代码片段 `...`
                const tokens = [];
                let masked = rest.replace(/`([^`]+)`/g, (_m, p1) => {
                    const ph = `@@CODE_${tokens.length}@@`;
                    tokens.push({ ph, code: p1 });
                    return ph;
                });

                try {
                    let translated;
                    if (isChineseTarget) {
                        const hasZh = /[\u4e00-\u9fff]/.test(masked);
                        const hasEn = /[A-Za-z]/.test(masked);
                        if ((hasZh && !hasEn) || !hasEn) {
                            translated = rest; // 中文或无英文，保持
                        } else {
                            translated = await translateSentence(masked, 'Chinese');
                        }
                    } else {
                        translated = await translateSentence(masked, targetName);
                    }
                    // 还原行内代码
                    for (const t of tokens) {
                        translated = translated.split(t.ph).join('`' + t.code + '`');
                    }
                    out.push(prefix + translated);
                } catch (e) {
                    out.push(originalLine);
                }
            }
            return out.join('\n');
        }

        const resultParts = [];
        for (const seg of segments) {
            if (seg.type === 'code') {
                resultParts.push(seg.text);
            } else {
                resultParts.push(await translateTextBlock(seg.text));
            }
        }
        return resultParts.join('\n');
    }

    // 更新指定索引的单个标签页内容（遵循缓存）
    async function updateOneTabContent(index) {
        const page = allPages[index];
        if (!page) return;
        const tabId = `tab-${index + 1}`;
        const tabPane = document.getElementById(tabId);
        const textarea = tabPane?.querySelector('.content-textarea');
        if (!textarea || !page.content) return;
        try {
            const cacheKey = `${page.url}::${currentLanguage}`;
            let cached = translationCache.get(cacheKey);
            if (!cached) {
                cached = await translatePageContent(page.content, currentLanguage);
                translationCache.set(cacheKey, cached);
            }
            textarea.value = cached;
        } catch (error) {
            console.error(`更新页面 ${page.url} 内容失败:`, error);
            textarea.value = page.content;
        }
    }

    // 按用户选择范围更新内容：有勾选→仅勾选，无勾选→仅当前活动标签页
    async function updateScopedTabContents() {
        const indices = [];
        if (selectedPages.size > 0) {
            indices.push(...Array.from(selectedPages));
        } else {
            const activePane = document.querySelector('.tab-pane.active');
            if (activePane) {
                const m = activePane.id.match(/^tab-(\d+)$/);
                const idx = m ? (parseInt(m[1], 10) - 1) : 0;
                if (!Number.isNaN(idx)) indices.push(idx);
            } else if (allPages.length > 0) {
                indices.push(0);
            }
        }
        const labelMap = { original: '原文', chinese: '中文', english: 'English', japanese: '日本語', korean: '한국어' };
        const titles = indices.map(i => (allPages[i]?.title || `页面 ${i + 1}`)).slice(0, 3).join(', ');
        addStatusLog(`开始翻译(${labelMap[currentLanguage] || currentLanguage}): ${indices.length} 个页面${titles ? '：' + titles : ''}`, 'info');
        await Promise.all(indices.map(i => updateOneTabContent(i)));
        addStatusLog(`翻译完成: ${indices.length} 个页面`, 'success');
    }


    // 语言切换功能
    async function toggleLanguage() {
        if (isTranslating) return;

        isTranslating = true;
        const originalText = languageToggleBtn.textContent;
        languageToggleBtn.textContent = '翻译中...';
        languageToggleBtn.disabled = true;

        try {
            // 循环切换语言
            if (currentLanguage === 'original') {
                currentLanguage = 'chinese';
                languageToggleBtn.textContent = '🌐 中文';
                languageToggleBtn.classList.add('active');
            } else if (currentLanguage === 'chinese') {
                currentLanguage = 'english';
                languageToggleBtn.textContent = '🌐 English';
                languageToggleBtn.classList.remove('active');
            } else {
                currentLanguage = 'original';
                languageToggleBtn.textContent = '🌐 原文';
                languageToggleBtn.classList.remove('active');
            }

            // 重新渲染所有标签页内容
            await updateAllTabContents();

        } catch (error) {
            console.error('语言切换失败:', error);
            alert('翻译失败，请重试');
        } finally {
            isTranslating = false;
            languageToggleBtn.disabled = false;
        }
    }

    // 更新所有标签页内容
    async function updateAllTabContents() {
        for (let i = 0; i < allPages.length; i++) {
            const page = allPages[i];
            const tabId = `tab-${i + 1}`;
            const tabPane = document.getElementById(tabId);
            const textarea = tabPane?.querySelector('.content-textarea');

            if (textarea && page.content) {
                try {
                    // 检查缓存
                    const cacheKey = `${page.url}::${currentLanguage}`;
                    let cached = translationCache.get(cacheKey);
                    if (!cached) {
                        cached = await translatePageContent(page.content, currentLanguage);
                        translationCache.set(cacheKey, cached);
                    }
                    textarea.value = cached;
                } catch (error) {
                    console.error(`更新页面 ${page.url} 内容失败:`, error);
                    // 失败时保持原文
                    textarea.value = page.content;
                }
            }
        }
    }

    function createTabButton(page, index) {
        const tabId = generateTabId();
        const tabButton = document.createElement('li');
        tabButton.className = 'tab-button';
        tabButton.dataset.tabId = tabId;

        const title = page.title || page.url.split('/').pop() || `页面 ${index + 1}`;
        const shortTitle = title.length > 15 ? title.substring(0, 12) + '...' : title;

        tabButton.innerHTML = `
            <span class="tab-title">${shortTitle}</span>
            <button class="close-btn" title="关闭标签页">&times;</button>
        `;

        // 标签页点击事件
        tabButton.addEventListener('click', (e) => {
            if (e.target.classList.contains('close-btn')) {
                closeTab(tabId);
            } else {
                switchTab(tabId);
            }
        });

        return { tabButton, tabId };
    }

    function createTabPane(page, tabId, index) {
        const tabPane = document.createElement('div');
        tabPane.className = 'tab-pane';
        tabPane.id = tabId;

        const title = page.title || page.url.split('/').pop() || `页面 ${index + 1}`;
        const domain = new URL(page.url).hostname.replace(/^www\./, '');

        tabPane.innerHTML = `
            <div class="tab-pane-header">
                <div>
                    <h3 class="tab-pane-title">${title}</h3>
                    <div class="tab-pane-url">${page.url}</div>
                    <div class="tab-pane-url">域名: ${domain}</div>
                </div>
                <div class="tab-pane-actions">
                    <button class="action-btn copy-btn" data-tab-id="${tabId}">复制内容</button>
                    <button class="action-btn download-btn" data-tab-id="${tabId}">下载文件</button>
                </div>
            </div>
            <textarea class="content-textarea" readonly>${page.content || ''}</textarea>
        `;

        // 为复制和下载按钮添加事件监听器
        const copyBtn = tabPane.querySelector('.copy-btn');
        const downloadBtn = tabPane.querySelector('.download-btn');

        if (copyBtn) {
            copyBtn.addEventListener('click', () => copyPageContent(tabId));
        }

        if (downloadBtn) {
            downloadBtn.addEventListener('click', () => downloadPage(tabId));
        }

        return tabPane;
    }

    function switchTab(tabId) {
        // 移除所有活动状态
        document.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));

        // 激活当前标签页
        const activeButton = document.querySelector(`[data-tab-id="${tabId}"]`);
        const activePane = document.getElementById(tabId);

        if (activeButton) activeButton.classList.add('active');
        if (activePane) activePane.classList.add('active');
    }

    function closeTab(tabId) {
        const tabButton = document.querySelector(`[data-tab-id="${tabId}"]`);
        const tabPane = document.getElementById(tabId);

        if (tabButton) tabButton.remove();
        if (tabPane) tabPane.remove();

        // 如果关闭的是活动标签页，切换到第一个可用的
        if (tabButton?.classList.contains('active')) {
            const firstTab = document.querySelector('.tab-button');
            if (firstTab) {
                switchTab(firstTab.dataset.tabId);
            }
        }

        // 更新页面计数
        updatePagesCount();
    }

    function updatePagesCount() {
        const pageCount = allPages.length;
        const selectedCount = selectedPages.size;
        pagesCount.textContent = `共 ${pageCount} 个页面${selectedCount > 0 ? ` (已选中 ${selectedCount} 个)` : ''}`;
    }

    function selectAllPages(checked) {
        selectedPages.clear();
        if (checked) {
            allPages.forEach((_, index) => selectedPages.add(index));
        }

        // 更新所有复选框状态
        document.querySelectorAll('.tab-pane input[type="checkbox"]').forEach(cb => {
            cb.checked = checked;
        });

        updatePagesCount();
        updateBulkActionButtons();
    }

    function selectPage(index, checked) {
        if (checked) {
            selectedPages.add(index);
        } else {
            selectedPages.delete(index);
        }

        // 更新全选状态
        selectAllCheckbox.checked = selectedPages.size === allPages.length;

        updatePagesCount();
        updateBulkActionButtons();
    }

    function updateBulkActionButtons() {
        const hasSelection = selectedPages.size > 0;
        copyAllBtn.disabled = allPages.length === 0;
        downloadSelectedBtn.disabled = !hasSelection;
        downloadAllBtn.disabled = allPages.length === 0;
    }

    // 全局函数（供HTML调用）
    window.copyPageContent = function(tabId) {
        const tabPane = document.getElementById(tabId);
        const textarea = tabPane?.querySelector('.content-textarea');
        if (textarea) {
            textarea.select();
            document.execCommand('copy');

            // 显示复制成功提示
            const button = tabPane.querySelector('.copy-btn');
            const originalText = button.textContent;
            button.textContent = '已复制!';
            button.style.background = '#4caf50';

            setTimeout(() => {
                button.textContent = originalText;
                button.style.background = '';
            }, 1500);
        }
    };

    window.downloadPage = function(tabId) {
        const tabPane = document.getElementById(tabId);
        const textarea = tabPane?.querySelector('.content-textarea');
        const title = tabPane?.querySelector('.tab-pane-title')?.textContent;
        const url = tabPane?.querySelector('.tab-pane-url')?.textContent;

        if (textarea && title) {
            const content = `# ${title}\n\n**来源**: ${url}\n\n${textarea.value}`;
            downloadContent(content, generatePageFilename({ title, url }));
        }
    };

    function copyAllContent() {
        const allContent = allPages.map((page, index) => {
            const title = page.title || `页面 ${index + 1}`;
            return `# ${title}\n\n**来源**: ${page.url}\n\n${page.content || ''}\n`;
        }).join('\n---\n\n');

        const textarea = document.createElement('textarea');
        textarea.value = allContent;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);

        // 显示复制成功提示
        const originalText = copyAllBtn.textContent;
        copyAllBtn.textContent = '已复制全部!';
        copyAllBtn.style.background = '#4caf50';

        setTimeout(() => {
            copyAllBtn.textContent = originalText;
            copyAllBtn.style.background = '';
        }, 1500);
    }

    function downloadSelectedPages() {
        if (selectedPages.size === 0) return;
        const indices = Array.from(selectedPages);
        if (zipToggleEl && zipToggleEl.checked) {
            const files = indices.map((index) => {
                const page = allPages[index];
                const title = page.title || `页面 ${index + 1}`;
                const content = `# ${title}\n\n**来源**: ${page.url}\n\n${page.content || ''}`;
                return { name: generatePageFilename(page), content };
            });
            try { addStatusLog(`开始打包 ZIP（选中 ${files.length} 个）`, 'info'); } catch {}
            const pagesForName = indices.map(i => allPages[i]);
            downloadZip(files, generateZipFilename(pagesForName));
            try { addStatusLog('ZIP 打包完成', 'success'); } catch {}
        } else {
            indices.forEach(index => {
                const page = allPages[index];
                const title = page.title || `页面 ${index + 1}`;
                const content = `# ${title}\n\n**来源**: ${page.url}\n\n${page.content || ''}`;
                downloadContent(content, generatePageFilename(page));
            });
        }
    }

    function downloadAllPages() {
        if (zipToggleEl && zipToggleEl.checked) {
            const files = allPages.map((page, index) => {
                const title = page.title || `页面 ${index + 1}`;
                const content = `# ${title}\n\n**来源**: ${page.url}\n\n${page.content || ''}`;
                return { name: generatePageFilename(page), content };
            });
            try { addStatusLog(`开始打包 ZIP（全部 ${files.length} 个）`, 'info'); } catch {}
            downloadZip(files, generateZipFilename(allPages));
            try { addStatusLog('ZIP 打包完成', 'success'); } catch {}
        } else {
            allPages.forEach((page, index) => {
                const title = page.title || `页面 ${index + 1}`;
                const content = `# ${title}\n\n**来源**: ${page.url}\n\n${page.content || ''}`;
                downloadContent(content, generatePageFilename(page));
            });
        }
    }

    function downloadContent(content, filename) {
        if (!content.trim()) return;

        const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
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

    function renderResults(pages) {
        allPages = pages;
        selectedPages.clear();
        tabIdCounter = 0;
        translationCache.clear(); // 清空翻译缓存

        // 清空现有内容
        tabsHeader.innerHTML = '';
        tabContent.innerHTML = '';

        // 创建标签页
        pages.forEach((page, index) => {
            const { tabButton, tabId } = createTabButton(page, index);
            const tabPane = createTabPane(page, tabId, index);

            // 添加复选框到标签页头部
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.style.marginRight = '8px';
            checkbox.addEventListener('change', (e) => selectPage(index, e.target.checked));

            tabButton.insertBefore(checkbox, tabButton.firstChild);

            tabsHeader.appendChild(tabButton);
            tabContent.appendChild(tabPane);
        });

        // 激活第一个标签页
        if (pages.length > 0) {
            const firstTabId = tabsHeader.querySelector('.tab-button')?.dataset.tabId;
            if (firstTabId) switchTab(firstTabId);
        }

        // 更新UI
        updatePagesCount();
        updateBulkActionButtons();
        selectAllCheckbox.checked = false;

        // 显示结果区域
        resultsSection.classList.remove('hidden');
    }

    // 批量操作事件
    selectAllCheckbox.addEventListener('change', (e) => selectAllPages(e.target.checked));
    copyAllBtn.addEventListener('click', copyAllContent);
    downloadSelectedBtn.addEventListener('click', downloadSelectedPages);
    downloadAllBtn.addEventListener('click', downloadAllPages);

    // 语言切换事件（展开式选择器）
    const languageSelector = document.getElementById('language-selector');
    const languageSelectedBtn = document.getElementById('language-selected-btn');
    const languageOptions = document.getElementById('language-options');

    if (languageSelectedBtn && languageSelector) {
        languageSelectedBtn.addEventListener('click', () => {
            languageSelector.classList.toggle('open');
        });
    }

    if (languageOptions) {
        languageOptions.addEventListener('click', async (e) => {
            const btn = e.target.closest('button[data-lang]');
            if (!btn) return;
            const lang = btn.getAttribute('data-lang');
            if (isTranslating) return;
            isTranslating = true;
            try {
                currentLanguage = lang;
                if (languageSelectedBtn) {
                    const labelMap = { original: '原文', chinese: '中文', english: 'English', japanese: '日本語', korean: '한국어' };
                    languageSelectedBtn.textContent = `🌐 ${labelMap[lang] || '原文'}`;
                }
                await updateScopedTabContents();
            } finally {
                isTranslating = false;
                // 确保选择器被关闭
                if (languageSelector) {
                    languageSelector.classList.remove('open');
                }
            }
        });
    }

    // 监听来自background的消息
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'crawlProgress') {
            // 更新进度条
            const state = request.state;
            const percent = state.total > 0 ? Math.round((state.processedCount / state.total) * 100) : 0;

            progressBar.style.width = `${percent}%`;
            progressPercent.textContent = `${percent}%`;
            progressText.textContent = `进度: ${state.processedCount}/${state.total}`;
            currentUrlElement.textContent = state.currentUrl || '-';
            statusElement.textContent = '🔄 正在抓取中...';
            statusElement.style.background = 'linear-gradient(135deg, #fff3e0, #e3f2fd)';
            statusElement.style.borderColor = '#ff9800';
            statusElement.style.color = '#f57c00';

            // 添加状态日志
            if (state.currentUrl) {
                addStatusLog(`开始处理: ${state.currentUrl}`, 'info');
            }
        } else if (request.action === 'crawlStatusUpdate') {
            // 处理详细的抓取状态更新
            const { type, url, title, error, message, processedCount, total } = request;

            if (type === 'success') {
                addStatusLog(`✅ 成功提取: ${title || url}`, 'success');
            } else if (type === 'error') {
                addStatusLog(`❌ 提取失败: ${error} (${url})`, 'error');
            } else if (type === 'skip') {
                addStatusLog(`⏭️ 已跳过: ${error} (${url})`, 'skip');
            } else if (type === 'info') {
                addStatusLog(message, 'info');
            }

        } else if (request.action === 'crawlFinished') {
            // 防止重复处理同一个完成消息
            if (isRendered) {
                console.log('已完成渲染，跳过重复处理');
                sendResponse({ status: 'received' });
                return true;
            }

            // 抓取完成，显示结果
            // 兼容新的分组结果格式
            let pages = request.pages || [];

            // 如果没有pages但有groupedResults，从分组结果中提取页面
            if (pages.length === 0 && request.groupedResults) {
                const groupedResults = request.groupedResults;
                pages = [];

                Object.keys(groupedResults).forEach(groupKey => {
                    const group = groupedResults[groupKey];
                    if (group && Array.isArray(group.pages)) {
                        group.pages.forEach(page => {
                            // 去重处理：检查URL是否已存在
                            if (page.url && !processedUrls.has(page.url)) {
                                processedUrls.add(page.url);
                                pages.push(page);
                            }
                        });
                    }
                });

                console.log(`从分组结果中提取到 ${pages.length} 个页面（去重后）`);
            } else {
                // 如果直接有pages数组，也需要去重
                const uniquePages = [];
                pages.forEach(page => {
                    if (page.url && !processedUrls.has(page.url)) {
                        processedUrls.add(page.url);
                        uniquePages.push(page);
                    }
                });
                pages = uniquePages;
            }

            statusElement.textContent = '✅ 抓取完成!';
            statusElement.style.background = 'linear-gradient(135deg, #e8f5e8, #f0f8ff)';
            statusElement.style.borderColor = '#4caf50';
            statusElement.style.color = '#2e7d32';

            if (pages.length > 0) {
                renderResults(pages);
                isRendered = true; // 标记为已渲染
            } else {
                // 显示空状态
                tabContent.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-state-icon">📄</div>
                        <p class="empty-state-text">没有抓取到任何内容</p>
                    </div>
                `;
                resultsSection.classList.remove('hidden');
                updatePagesCount();
                updateBulkActionButtons();
                isRendered = true; // 标记为已渲染
            }

            // 隐藏进度相关元素
            const info = document.querySelector('.progress-info');
            const bar = document.querySelector('.progress-bar-container');
            const cur = document.querySelector('.current-url');
            if (info) info.classList.add('hidden');
            if (bar) bar.classList.add('hidden');
            if (cur) cur.classList.add('hidden');
        }

        sendResponse({ status: 'received' });
        return true;
    });

    // 页面加载完成后通知background script
    document.addEventListener('DOMContentLoaded', () => {
        statusLogElement = document.getElementById('status-log');
        clearStatusLogs();
        chrome.runtime.sendMessage({ action: 'crawlProgressPageReady' });
    });
})();