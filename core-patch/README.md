# core-patch — 内核补丁

Context Window Manager 扩展依赖 SillyTavern 内核里的**一处**改动。这个目录把改动打包成「一条命令能装、能验、能撤」的形式。

---

## 改的是什么

`public/scripts/openai.js` 的 `populateChatHistory()` 里，原本把三个历史窗口策略参数硬编码在函数内部：

| 硬编码 | 含义 |
|---|---|
| `HISTORY_WINDOW_TOKEN_CAP = 16000` | 聊天历史部分的 token 上限 |
| 保留最旧一半（`/ 2`） | 窗口装不下时丢弃多少 |
| 总是 sticky（只增不减） | 前缀是否保持字节稳定 |

补丁把它们改成从 `globalThis.STContextWindowPolicy` 读取，也就是由扩展在运行时写入。四个替换点：

| 补丁条目 | 位置 | 作用 |
|---|---|---|
| `import-chat-metadata` | 文件头 import 列表 | 引入 `chat_metadata`（窗口边界要存进它） |
| `import-save-metadata` | 文件头 import 区 | 引入 `saveMetadataDebounced`（持久化边界） |
| `policy-block-and-window-boundary` | `populateChatHistory()` 开头 | 读取策略 + 尊重已记住的窗口边界 |
| `overflow-reanchor` | 历史插入循环之后 | 按 `overflowKeepRatio` 重锚窗口起点 |

**没装扩展时**，`globalThis.STContextWindowPolicy` 不存在，上面每一处都回退到原常量 —— 行为与官方原版逐字节一致。

---

## 用法

在 SillyTavern 根目录执行（脚本会自己向上定位根目录，从哪跑都行）：

```
node core-patch/apply-core-patch.mjs
```

| 命令 | 作用 |
|---|---|
| `node apply-core-patch.mjs` | 打补丁（已打过则跳过） |
| `node apply-core-patch.mjs --check` | 只报告状态，不写任何文件 |
| `node apply-core-patch.mjs --dry-run` | 列出将要发生的替换，不写盘 |
| `node apply-core-patch.mjs --revert` | 从最近一次备份还原 |
| `node apply-core-patch.mjs --list` | 列出补丁条目 |
| `node apply-core-patch.mjs --root <路径>` | 手动指定 SillyTavern 根目录 |

打完补丁**刷新浏览器**即可生效（`public/` 是静态资源，不需要重启 Node 进程）。

### 安全设计

- 所有替换**先在内存里完整校验**（每条必须唯一命中）才会写盘；任何一条失败就整体放弃，文件一个字节都不动，退出码 `2`；
- 写盘前备份为 `openai.js.bak.<时间戳>`；
- 写入后**复验**，若标记缺失或原始代码残留就自动回滚到内存中的原始内容；
- 保留原文件的换行风格（LF/CRLF）与 BOM；
- 幂等：文件里已有 `STContextWindowPolicy` 就跳过。

---

## 不用脚本的手工方式

`sticky-history-window.patch` 是标准 unified diff，路径前缀已经写成 `a/public/scripts/openai.js` / `b/public/scripts/openai.js`，所以：

```
git apply core-patch/sticky-history-window.patch
```

在 SillyTavern 根目录执行即可（不是 git 仓库也能用）。或者打开 `sticky-history-window.json`，里面是逐条的「原始代码 → 替换后代码」文本对，照着粘贴。

---

## 适用范围与失败处理

补丁数据是从 **SillyTavern 1.19.0** 的真实 diff 里机械导出的，因此依赖上游那几行代码**没有被改动过**。

如果目标机器上的版本不同，脚本会明确报出哪一条找不到锚点，并**拒绝修改**。这时有两条路：

1. 对照 `sticky-history-window.json`，在目标版本里找到语义相同的位置手工改（改动很小，逻辑是自包含的）；
2. 用 `--dry-run` 看预期替换内容，确认后再手工处理。

**不要**把 `--force` 之类的开关加进来绕过校验 —— 锚点失配几乎一定意味着上下文不同，硬替换可能破坏语法。

---

## 重新生成补丁数据

上游升级后，若那几行代码变了，需要重新出补丁：

1. 取新版本的 `public/scripts/openai.js` 作为「上游原版」；
2. 取当前**已打补丁**的文件作为「目标」；
3. 用项目里的 `.workbuddy/build_patch_set.py` 重新生成 JSON 与 patch —— 它是从 diff 的 hunk 反向构建 old/new 文本对的，不靠手抄，所以不会引入笔误。

生成后**务必**在副本上验证一遍：把上游原版放回一个假目录，跑一次脚本，再与真实的已打补丁文件 diff —— 差异应当只剩**不属于本补丁**的那些改动。
