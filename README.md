# Context Window Manager · 上下文窗口管理

一个 SillyTavern 扩展：把「聊天历史如何进入上下文窗口」这件事变成三个可调参数 —— 窗口 token 上限、溢出时保留多少、以及窗口是否保持前缀稳定。

配合侧边栏的实时状态面板，可以直观看到当前窗口起点、窗口内消息数、以及窗口约合多少 token。

---

## ⚠️ 前置条件（必读）

**本扩展是策略的「注入端」，不是「执行端」。**

它只负责把参数写到全局对象 `globalThis.STContextWindowPolicy`；真正读取这个对象、并据此裁剪聊天历史的代码在内核里：

```
public/scripts/openai.js → populateChatHistory()
```

**官方原版 SillyTavern 没有这段读取逻辑。** 因此：

| 你的环境 | 结果 |
|---|---|
| 已经给 `populateChatHistory()` 打过 sticky window 补丁 | ✅ 装上即生效 |
| 原版 SillyTavern，未打补丁 | ⚠️ **完全没有任何效果**（核心不认识这个全局对象，仍走自己的默认滑窗） |

未安装本扩展时，内核会 `?? {}` 回退到内置常量，行为与改动前完全一致 —— 所以装/卸本扩展本身是安全的，不会弄坏任何东西。

### 内核需要实现的最小契约

内核侧需要读取这三个字段（缺省值即原硬编码常量）：

```js
const policy = globalThis.STContextWindowPolicy ?? {};

const sticky             = policy.sticky !== false;              // 缺省 true
const historyTokenCap    = typeof policy.historyTokenCap === 'number'
                           && !Number.isNaN(policy.historyTokenCap)
                           ? policy.historyTokenCap : 16000;     // 缺省 16000
const overflowKeepRatio  = Number.isFinite(policy.overflowKeepRatio)
                           ? policy.overflowKeepRatio : 0.5;     // 缺省 0.5
```

> 判空**必须**用 `typeof … === 'number' && !Number.isNaN(…)`，不能用 `Number.isFinite()` —— 插件用 `Infinity` 表示「不限制」，而 `Number.isFinite(Infinity)` 为 `false`，会被静默回退成 16000。

---

## 安装

在 SillyTavern 中打开 **Extensions（扩展）** 面板 → 点击 **Install Extension（安装扩展）** → 粘贴**下面任一地址** → 安装后**刷新页面**：

| 源 | 地址 |
|---|---|
| GitHub（主仓库） | `https://github.com/Hua-git365/context-window-manager` |
| Gitee（镜像，国内更快） | `https://gitee.com/luleihua/context-window-manager` |

两个地址是同一份代码的镜像，装哪个都一样；带不带 `.git` 后缀都能识别。

> **仓库名必须保持 `context-window-manager`。** 扩展代码里硬编码了设置面板的路径 `third-party/context-window-manager`，SillyTavern 又是按仓库名建文件夹的，改名会导致设置面板加载失败。

---

## 参数说明

| 参数 | 默认 | 含义 |
|---|---|---|
| **启用接管** | 开 | 关掉即删除全局策略对象，核心回退到内置行为 |
| **历史窗口上限** | `16000` | 只约束**聊天历史**部分的 token 上限，不含系统提示词与角色卡。填 `0` = 不限制（仍受模型上下文预算约束） |
| **溢出时保留比例** | `50%` | 窗口溢出时，保留多少比例的旧窗口。`50%` = 丢掉最旧的一半 |
| **保持前缀稳定** | 开 | 开启后窗口**只增不减**，系统提示词之后的前缀字节稳定，前缀缓存能持续命中；关闭则恢复上游的平滑滑窗 |

### 这个取舍要理解清楚

- **开启 sticky（默认）**：两次「骤降」之间前缀完全不变，缓存持续命中；但溢出时会**一次性砍掉最旧的一半**，输入 token 曲线呈锯齿形。
- **关闭 sticky**：窗口每轮只前移最小步长，曲线平滑；但前缀每轮都变，**前缀缓存基本打不中**。
- **保留比例调到 100% 时，效果等同于关闭 sticky** —— 不存在「既平滑又保缓存」的中间态，这是同一个取舍的两端。

### 常用按钮

- **刷新状态**：重新统计窗口信息
- **重置窗口起点**：把 `chat_metadata.historyStickyFront` 归零，下次生成从最早的消息重新开始填充

---

## 工作原理

```
扩展（本插件）                      内核（openai.js）
─────────────────                  ─────────────────
读取设置                           每次组装提示词时
   ↓                                  ↓
写入 globalThis.STContextWindowPolicy ──→ 读取策略
                                      ↓
                                   按策略裁剪聊天历史
                                      ↓
                                   chat_metadata.historyStickyFront（窗口起点）
```

窗口边界存在 `chat_metadata.historyStickyFront` 里，随聊天存档持久化 —— 所以每个聊天的窗口状态是独立的，换聊天不会串。

---

## 兼容性

- SillyTavern 1.12+（依赖 `globalThis.SillyTavern.getContext()` 与 `renderExtensionTemplateAsync`）
- 不修改任何核心文件，与其它扩展无已知冲突
- 设置面板挂载在 `#extensions_settings2`

---

## 许可

[MIT](LICENSE)
