/**
 * Context Window Manager / 上下文窗口管理
 *
 * 把 openai.js -> populateChatHistory() 里原本硬编码的三个策略参数外置成可调项：
 *   1. 历史部分的 token 上限（原 HISTORY_WINDOW_TOKEN_CAP = 16000）
 *   2. 溢出时保留多少比例（原固定保留最新的一半）
 *   3. 窗口是否 sticky（只增不减、保前缀缓存；关掉就是上游的平滑滑窗）
 *
 * 传递方式：本扩展把策略写到 globalThis.STContextWindowPolicy，核心每次生成时读取。
 * 未安装本扩展时该对象不存在，核心回退到内置常量，行为与改动前完全一致。
 */

const MODULE_NAME = 'contextWindowManager';
const EXTENSION_PATH = 'third-party/context-window-manager';

const defaultSettings = {
    enabled: true,
    historyTokenCap: 16000,
    overflowKeepPercent: 50,
    sticky: true,
};

let mounted = false;

function ctx() {
    try {
        return globalThis.SillyTavern?.getContext?.() ?? {};
    } catch (error) {
        console.error('[ContextWindow] 无法取得上下文', error);
        return {};
    }
}

function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings) {
        return { ...defaultSettings };
    }
    if (!extensionSettings[MODULE_NAME] || typeof extensionSettings[MODULE_NAME] !== 'object') {
        extensionSettings[MODULE_NAME] = {};
    }
    const settings = extensionSettings[MODULE_NAME];
    for (const key of Object.keys(defaultSettings)) {
        if (settings[key] === undefined) {
            settings[key] = defaultSettings[key];
        }
    }
    return settings;
}

function saveSettings() {
    ctx().saveSettingsDebounced?.();
}

function isEnabled() {
    return getSettings().enabled !== false;
}

/**
 * 把当前设置推送给核心。核心在每次组装提示词时读取 globalThis.STContextWindowPolicy。
 */
function applyPolicy() {
    if (!isEnabled()) {
        delete globalThis.STContextWindowPolicy;
        console.debug('[ContextWindow] 已停用，核心回退到内置 sticky 行为');
        return;
    }

    const settings = getSettings();
    const cap = Number(settings.historyTokenCap);
    const keepPercent = Number(settings.overflowKeepPercent);

    const policy = {
        sticky: settings.sticky !== false,
        historyTokenCap: Number.isFinite(cap) && cap > 0 ? cap : Infinity,
        overflowKeepRatio: Math.min(Math.max((Number.isFinite(keepPercent) ? keepPercent : 50) / 100, 0.05), 1),
    };

    globalThis.STContextWindowPolicy = policy;
    console.debug('[ContextWindow] 策略已生效', policy);
}

function updateControlState() {
    const { historyTokenCap, overflowKeepPercent, sticky, enabled } = getSettings();
    $('#ctxwm_enabled').prop('checked', enabled !== false);
    $('#ctxwm_history_cap').val(historyTokenCap);
    $('#ctxwm_keep').val(overflowKeepPercent);
    $('#ctxwm_keep_value').text(`${overflowKeepPercent}%`);
    $('#ctxwm_sticky').prop('checked', sticky !== false);
    const off = enabled === false;
    $('#ctxwm_history_cap, #ctxwm_keep, #ctxwm_sticky').prop('disabled', off);
    $('#ctxwm_settings').toggleClass('ctxwm-disabled', off);
}

async function refreshStatus() {
    const { chat, chatMetadata, getTokenCountAsync } = ctx();
    const settings = getSettings();

    const total = Array.isArray(chat) ? chat.length : 0;
    const rawFront = Number(chatMetadata?.historyStickyFront);
    const front = Number.isInteger(rawFront) && rawFront > 0 && rawFront < total ? rawFront : 0;
    const windowMessages = Array.isArray(chat) ? chat.slice(front) : [];

    let windowTokens = null;
    if (typeof getTokenCountAsync === 'function' && windowMessages.length > 0) {
        try {
            const text = windowMessages.map(message => message?.mes ?? '').join('\n');
            windowTokens = await getTokenCountAsync(text, 0);
        } catch (error) {
            console.debug('[ContextWindow] 统计窗口 token 失败', error);
        }
    }

    const capText = Number.isFinite(Number(settings.historyTokenCap)) && Number(settings.historyTokenCap) > 0
        ? Number(settings.historyTokenCap).toLocaleString('en-US')
        : '不限制';
    const tokenText = typeof windowTokens === 'number' ? `${Math.round(windowTokens).toLocaleString('en-US')}` : '统计失败';

    $('#ctxwm_status').html(
        `<div><b>总消息数</b><span>${total}</span></div>` +
        `<div><b>当前窗口起点</b><span>#${front}</span></div>` +
        `<div><b>窗口内消息</b><span>${windowMessages.length}</span></div>` +
        `<div><b>窗口约合</b><span>${tokenText} tok</span></div>` +
        `<div><b>历史上限</b><span>${capText}</span></div>` +
        `<div><b>模式</b><span>${settings.sticky !== false ? 'sticky 只增不减' : '平滑滑窗'}</span></div>`,
    );
}

function resetWindow() {
    const { chatMetadata, saveMetadataDebounced } = ctx();
    if (!chatMetadata) {
        return;
    }
    chatMetadata.historyStickyFront = 0;
    saveMetadataDebounced?.();
    if (typeof toastr !== 'undefined') {
        toastr.info('历史窗口起点已重置，下次生成会重新从最早的消息开始填充。');
    }
    console.debug('[ContextWindow] historyStickyFront 已重置为 0');
    refreshStatus();
}

function bindUi() {
    $('#ctxwm_enabled').on('input', () => {
        getSettings().enabled = $('#ctxwm_enabled').prop('checked');
        saveSettings();
        applyPolicy();
        updateControlState();
        refreshStatus();
    });

    $('#ctxwm_history_cap').on('input', () => {
        const value = Math.max(0, Math.round(Number($('#ctxwm_history_cap').val()) || 0));
        getSettings().historyTokenCap = value;
        saveSettings();
        applyPolicy();
        refreshStatus();
    });

    $('#ctxwm_keep').on('input', () => {
        const value = Math.min(Math.max(Math.round(Number($('#ctxwm_keep').val()) || 50), 10), 100);
        getSettings().overflowKeepPercent = value;
        $('#ctxwm_keep_value').text(`${value}%`);
        saveSettings();
        applyPolicy();
    });

    $('#ctxwm_sticky').on('input', () => {
        getSettings().sticky = $('#ctxwm_sticky').prop('checked');
        saveSettings();
        applyPolicy();
    });

    $('#ctxwm_refresh').on('click', refreshStatus);
    $('#ctxwm_reset').on('click', resetWindow);
}

async function mountSettings() {
    if (mounted) {
        return;
    }

    if (document.getElementById('ctxwm_settings')) {
        mounted = true;
        return;
    }

    const { renderExtensionTemplateAsync } = ctx();
    if (typeof renderExtensionTemplateAsync !== 'function') {
        console.warn('[ContextWindow] renderExtensionTemplateAsync 不可用，跳过设置面板挂载');
        return;
    }

    try {
        const html = await renderExtensionTemplateAsync(EXTENSION_PATH, 'settings');
        const container = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
        if (!container.length) {
            console.warn('[ContextWindow] 找不到设置面板容器');
            return;
        }
        container.append(html);
        mounted = true;
        bindUi();
        updateControlState();
        await refreshStatus();
    } catch (error) {
        console.error('[ContextWindow] 设置面板挂载失败', error);
    }
}

// 策略必须在任何一次生成之前装好，所以模块加载时立刻生效，不等 DOM。
applyPolicy();

jQuery(async () => {
    await mountSettings();
});
