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
 *
 * 界面挂在**用户设置页**第三列（与 Chat/Message Handling 同级的原生段），不占扩展页。
 */

const MODULE_NAME = 'contextWindowManager';
const EXTENSION_PATH = 'third-party/context-window-manager';
const LOCALE_DIR = 'locales';

/** 历史窗口上限的滑块量程。0 表示不限制。 */
const CAP_MIN = 0;
const CAP_MAX = 200000;
const KEEP_MIN = 10;
const KEEP_MAX = 100;

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

/** 界面文案统一走核心的 translate()，词条在 locales/zh-cn.json；查不到时原样返回英文键。 */
function tr(text) {
    const { translate } = ctx();
    try {
        return typeof translate === 'function' ? translate(text) : text;
    } catch {
        return text;
    }
}

function clampInt(value, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return min;
    }
    return Math.min(Math.max(Math.round(parsed), min), max);
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

/**
 * 把设置回填到控件。
 *
 * 滑块与数字框是核心 .neo-range-slider / .neo-range-input 的成对写法：
 * 数字框只负责在失焦或回车时把值打回滑块并派发 input，所以这里两者都要回填，
 * 且必须用 .val() 直接赋值，不能触发事件（否则会和用户的输入互相打架）。
 */
function updateControlState() {
    const settings = getSettings();
    const off = settings.enabled === false;

    $('#ctxwm_enabled').prop('checked', !off);

    const cap = Number(settings.historyTokenCap);
    const capValue = Number.isFinite(cap) && cap > 0 ? Math.min(Math.round(cap), CAP_MAX) : CAP_MIN;
    $('#ctxwm_history_cap').val(capValue);
    $('#ctxwm_history_cap_counter').val(capValue);

    const keep = Number(settings.overflowKeepPercent);
    const keepValue = Number.isFinite(keep) ? clampInt(keep, KEEP_MIN, KEEP_MAX) : 50;
    $('#ctxwm_keep').val(keepValue);
    $('#ctxwm_keep_counter').val(keepValue);

    $('#ctxwm_toggles').find('input').prop('disabled', off);
    $('#ctxwm_settings').toggleClass('ctxwm-disabled', off);
}

/** 内核补丁状态：null = 尚未检测，true = 已安装，false = 未安装。 */
let corePatchState = null;

/**
 * 检测内核是否已打补丁。
 *
 * 补丁的标记是 openai.js 里出现 STContextWindowPolicy —— 只有改过的内核才会去读这个对象。
 * 没打补丁时本扩展的界面照常显示、参数照常保存，但**设置不会起作用**，
 * 所以必须把这件事明确摆到面板上，否则用户只会觉得"扩展没用"。
 *
 * @returns {Promise<boolean|null>} true 已装 / false 未装 / null 无法确认
 */
async function detectCorePatch() {
    if (corePatchState !== null) {
        return corePatchState;
    }
    try {
        const response = await fetch('/scripts/openai.js');
        if (!response.ok) {
            return null;
        }
        corePatchState = (await response.text()).includes('STContextWindowPolicy');
    } catch (error) {
        console.debug('[ContextWindow] 内核补丁检测失败', error);
        return null;
    }
    return corePatchState;
}

function renderCorePatchNotice(state) {
    const box = $('#ctxwm_core_patch');
    if (!box.length) {
        return;
    }

    if (state === true) {
        box.attr('class', 'ctxwm-core-patch ok show')
            .text(tr('Core patch is installed. The settings below take effect immediately.'));
        return;
    }

    if (state === false) {
        const command = '<code>node data/default-user/extensions/context-window-manager/core-patch/apply-core-patch.mjs</code>';
        box.attr('class', 'ctxwm-core-patch warn show').html(
            `<b>${tr('Core patch is NOT installed, so the settings below will have no effect.')}</b><br>` +
            `${tr('This extension needs one change in openai.js (handing the history window policy over to the extension) and it cannot be delivered with the extension itself. Run once from the SillyTavern root directory (the script locates the root, backs up, then patches):')}<br>` +
            `${command}<br>` +
            tr('If your user directory is not default-user, replace it in the path above. Undo with --revert, see core-patch/README.md.'),
        );
        return;
    }

    box.attr('class', 'ctxwm-core-patch warn show')
        .text(tr('Could not determine the core patch state (reading openai.js failed). Check the browser console.'));
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

    const cap = Number(settings.historyTokenCap);
    const capText = Number.isFinite(cap) && cap > 0 ? cap.toLocaleString('en-US') : tr('unlimited');
    const tokenText = typeof windowTokens === 'number'
        ? `${Math.round(windowTokens).toLocaleString('en-US')} tok`
        : tr('count failed');

    const rows = [
        [tr('Total messages'), total],
        [tr('Window start'), `#${front}`],
        [tr('In window'), windowMessages.length],
        [tr('Window size'), tokenText],
        [tr('History cap'), capText],
        [tr('Mode'), settings.sticky !== false ? tr('sticky (append-only)') : tr('sliding window')],
    ];

    $('#ctxwm_status').html(rows.map(([label, value]) => `<div><b>${label}</b><span>${value}</span></div>`).join(''));
}

function resetWindow() {
    const { chatMetadata, saveMetadataDebounced } = ctx();
    if (!chatMetadata) {
        return;
    }
    chatMetadata.historyStickyFront = 0;
    saveMetadataDebounced?.();
    if (typeof toastr !== 'undefined') {
        toastr.info(tr('Window start has been reset. The next generation will fill from the oldest message again.'));
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

    // 滑块是主控件：数字框在失焦/回车时会把值打回滑块并派发 input，所以这里只需监听滑块。
    $('#ctxwm_history_cap').on('input', () => {
        const value = clampInt($('#ctxwm_history_cap').val(), CAP_MIN, CAP_MAX);
        getSettings().historyTokenCap = value;
        $('#ctxwm_history_cap_counter').val(value);
        saveSettings();
        applyPolicy();
        refreshStatus();
    });

    $('#ctxwm_keep').on('input', () => {
        const value = clampInt($('#ctxwm_keep').val(), KEEP_MIN, KEEP_MAX);
        getSettings().overflowKeepPercent = value;
        $('#ctxwm_keep_counter').val(value);
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

/**
 * 载入本扩展自己的语言词条。
 *
 * 正常路径是核心的 addExtensionLocale()（读 manifest.i18n）——它在本模块求值之前就发起 fetch，
 * 但不保证已经完成。这里补一次：拿不到就保持英文键的原样显示，不会报错。
 */
async function applyOwnLocale() {
    const { getCurrentLocale, addLocaleData } = ctx();
    if (typeof getCurrentLocale !== 'function' || typeof addLocaleData !== 'function') {
        return;
    }

    const locale = String(getCurrentLocale() || '').toLowerCase();
    if (!locale || locale.startsWith('en')) {
        return;
    }

    try {
        const response = await fetch(`/scripts/extensions/${EXTENSION_PATH}/${LOCALE_DIR}/${locale}.json`);
        if (!response.ok) {
            return;
        }
        const data = await response.json();
        if (!data || typeof data !== 'object') {
            return;
        }
        addLocaleData(locale, data); // 已载入过则被忽略，无副作用
    } catch (error) {
        console.debug('[ContextWindow] 语言文件未载入，面板保持英文', error);
        return;
    }

    // 重新触发翻译：改写 data-i18n 属性即可命中 i18n.js 的 MutationObserver。
    document.querySelectorAll('#ctxwm_settings [data-i18n]').forEach(element => {
        element.setAttribute('data-i18n', element.getAttribute('data-i18n'));
    });
}

/** 用户设置页里的挂载点，按优先级排列。 */
const SETTINGS_MOUNT_SELECTORS = [
    '#power-user-option-checkboxes',      // 第三列，与 Chat/Message Handling、STscript Settings 同级
    '#power-user-options-block',
    '#user-settings-block-content',
];

function findSettingsMountPoint() {
    for (const selector of SETTINGS_MOUNT_SELECTORS) {
        const $target = $(selector);
        if ($target.length) {
            return $target;
        }
    }
    return $();
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
        const target = findSettingsMountPoint();

        if (target.length) {
            target.append(html);
        } else {
            // 设置页结构变了的话别让面板整个消失，退回扩展页总比没有强。
            const fallback = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
            if (!fallback.length) {
                console.warn('[ContextWindow] 找不到任何可用的面板容器');
                return;
            }
            console.warn('[ContextWindow] 用户设置页容器不存在，面板临时挂到扩展页');
            fallback.append(html);
        }

        mounted = true;
        await applyOwnLocale();
        bindUi();
        updateControlState();
        renderCorePatchNotice(await detectCorePatch());
        await refreshStatus();
    } catch (error) {
        console.error('[ContextWindow] 设置面板挂载失败', error);
    }
}

/** 换聊天、生成结束时刷新读数，免得面板一直显示上一个聊天的窗口。 */
function watchChatEvents() {
    const { eventSource, eventTypes } = ctx();
    if (!eventSource || !eventTypes) {
        return;
    }
    for (const name of ['CHAT_CHANGED', 'GENERATION_ENDED']) {
        const type = eventTypes[name];
        if (!type) {
            continue;
        }
        try {
            eventSource.on(type, () => {
                if (mounted) {
                    refreshStatus();
                }
            });
        } catch (error) {
            console.debug('[ContextWindow] 事件订阅失败', name, error);
        }
    }
}

// 策略必须在任何一次生成之前装好，所以模块加载时立刻生效，不等 DOM。
applyPolicy();

jQuery(async () => {
    await mountSettings();
    watchChatEvents();
});
