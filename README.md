# 哔哩哔哩 音量增强（突破 100%）

让 B 站播放器音量突破 100% 上限，最高放大 **10 倍（约 +20 dB）**。
纯油猴（Tampermonkey / Violentmonkey）用户脚本，零依赖、免构建，安装即用。

## 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展
2. 打开 [volume-boost.user.js](./volume-boost.user.js)（或从「管理面板 → 新建脚本」粘贴内容）
3. 刷新 B 站视频页即可

> 若想手动添加：油猴面板 → 实用工具 → 导入 → 选择 `volume-boost.user.js` 文件。

## 使用

- 播放器底部控制条（音量图标旁）新增一个 **🔊+ 音量增强按钮**
- 鼠标悬停显示提示条，外观与播放器原生提示一致（黑底圆角、延迟淡入并上浮；实现方式与样式取自
  [BilibiliSponsorBlock](https://github.com/hanydd/BilibiliSponsorBlock)，配色走播放器 CSS 变量）
- 点击按钮弹出设置面板：
  - **启用增强**：总开关。关闭时回到原始音量（直通，见下方原理）
  - **增益倍率**：`1× – 10×` 滑块，实时生效，显示对应 dB 值（2× ≈ +6 dB）
  - **削波保护（压限）**：倍率过大时防止破音/削波，建议开启
- 原生的音量条、静音按钮、快捷键 **全部照常工作**（增强是在原生音量之上叠加倍率）
- 设置自动记忆（localStorage），切换分 P / 视频 / 清晰度自动跟随

## 原理

浏览器规范把 `<video>` 的 volume 锁死在 `0–1`（100%），写大于 1 会被强制夹回。
本脚本用 **Web Audio 重路由**绕过：

```
<video> → MediaElementSource → 增益节点(最高10×) → 压限器(可选) → 扬声器
```

实际输出音量 = 原生音量 × 倍率。原生音量条仍控制"原生音量"这一层，因此语义不冲突。

### 为什么"关闭增强"不会静音（v2 关键修复）

Web Audio 的接管有一个规范级特性：**一个 video 元素一旦被 `createMediaElementSource` 接管，
它的音频就永久只能走这条链路**（同一元素也不允许二次接管）。v1 版本"关闭增强"时直接拆除
节点并 `close()` 了 AudioContext——等于把元素接到了一个已关闭的音箱上，当场静音且无法恢复
（刷新页面后元素虽换新，但脚本若反复触发"接管→拆除"同样会陷入静音）。

v2 改为**直通模式**：

- 关闭增强 ≠ 拆除链路，而是把增益回到 `1×`、压限器参数置中性（0 dB 阈值 + 1:1 压缩 =
  完全透明），声音连续、无中断、无需重建
- AudioContext **永不因开关而关闭**，只有 video 元素被播放器销毁（离开 DOM）时才拆除
- 同一元素只接管一次；链路按元素独立管理，播放器轮换/重建元素互不干扰

## 限制

- **WASM/bwp 新内核播放器**（灰度中）的音频不走 `<video>`，无法放大；脚本会自动识别并跳过，
  绝大多数用户仍是 HTML5 内核，不受影响
- 声音超过 0 dB 后扬声器/耳机可能失真：小音量素材用高倍率很合适，本来就大声的素材
  建议 1.5–2× 并开启削波保护
- 浏览器「自动播放策略」下首次需要一次点击才出声（B 站本身也如此），脚本会随点击自动恢复

## 版本记录

- **2.1.0**：按需求**只保留 BilibiliSponsorBlock 的实现方式**，移除其它所有方案。
  - 删除了：播放器官方 tooltip API 直连、页面桥接（postMessage 代调）、"官方失败才自绘"的兜底逻辑，
    以及为访问页面全局而加的 `@grant unsafeWindow` 与页面窗口解析器（`localStorage` / `AudioContext`
    恢复为直接用 `window`）。
  - 悬停提示改为**按钮内嵌元素 + CSS 控制**，声明照搬 BilibiliSponsorBlock 的 `.playerButtonTooltip`
    （其注释注明灵感来自 the1812/Bilibili-Evolved）：`font-size:12px`、`padding:6px 8px`、
    `line-height:1.5`、`white-space:nowrap`、`border-radius:4px`、
    `color:var(--bpx-tooltip-color,#fff)`、`background-color:var(--bpx-tooltip-bgcolor,#000)`、
    `pointer-events:none`、`position:absolute`、`opacity:0`；
    hover 时 `transition:all .2s ease-out .1s` + 淡入并上浮 5px。
  - 唯一改动：原实现用 `transform: translateY(calc(-100% - 36px))` 相对"按钮内容流"定位（按 22px 图标
    折算即按钮上方 14px），在图标 32px 的全屏态下间距会被压缩；本实现改为 `top:0` 锚点 + 同样的
    14px → 19px 间距，各状态间距一致。
  - 实测（headless）：普通态未悬停 `opacity:0`／间距 14px，悬停 `opacity:1`／间距 19px；
    网页全屏态同样 19px、水平居中偏差 0；`background rgb(0,0,0)`、`border-radius 4px`、
    `padding 6px 8px`、`font-size 12px`、`transition 0.2s ease-out 0.1s`；
    页面内 `.bpx-player-tooltip-item` 我们那条记录数为 0（旧通道已清除）。
- **2.0.7 / 2.0.6 / 2.0.5 / 2.0.4 / 2.0.3**：这几版都在折腾悬停提示的“原生/桥接/兜底”方案
  （官方 player.tooltip API、postMessage 桥接、自愈式注册、复刻样式等），**均已在 2.1.0 中移除**，
  仅保留 BilibiliSponsorBlock 那一套做法。相关细节可查 git 历史。
- **2.0.2**：修复全屏态图标偏下。
  - 实测数据：B 站按钮在不同状态尺寸不同——普通态 `36×22`（`line-height:22px`），
    **网页全屏与全屏态 `54×43`**（`line-height:32px`，图标块 32px、svg 28px），且原生按钮是
    **块级 + line-height 顶部对齐**，不是 flex 居中。v2.0.1 硬编码 `display:flex; height:22px`
    居中，普通态恰好吻合（svg 中心 y=694 vs 原生 694），全屏态就低了 6px（869 vs 863）。
  - 修复：① 按钮结构与类名完全对齐原生（内层改用 `.bpx-player-ctrl-btn-icon`），不再自定义
    尺寸；② 增加"运行时几何镜像"——读取同行原生按钮图标块/svg 的实际计算尺寸与偏移，套用到
    我们的按钮上，并在 `fullscreenchange`、`resize`、容器 class 变化（网页全屏等）时重新同步。
  - 验证（headless 实测，三种状态 svg 中心完全一致，偏差 0）：普通态 694=694、网页全屏 863=863、
    原生全屏 863=863。
- **2.0.1**：针对真实 bpx DOM 修正按钮定位 + 修复老版的卡顿。
  - v2.0.0 假设 `.bpx-player-ctrl-btn-group` 存在并按 38×38 大小设计按钮。新版 B 站根本没有
    这个类——按钮是 `.bpx-player-ctrl-btn` 直接挂在 `.bpx-player-control-bottom-right` 里，
    且每按钮仅 22px 高。v2.0.0 的代码会把按钮插到容器末尾（视频区上空）并溢出控制条。
    本版改为：插入到音量按钮之后、与其它 ctrl-btn 同级（flex 行）。
  - 老版 MutationObserver 监听整个 `.bpx-player-container` 的 `childList:true, subtree:true`，
    会被播放器内的弹幕/进度条等高频 DOM 变化持续触发，回调里再做查询/重试会拖慢主线程。
    本版改为：只观察 `.bpx-player-video-perch`（视频元素所在的低变更区域）+ 容器的直接子节点
    增减与 class 变化（用于检测 SPA 重建与播放模式切换）+ 2 秒兜底心跳；并用合并锁防止观察器
    与心跳同时触发协调。
- **2.0.0**：修复关闭增强后静音（改为直通模式）；UI 改为控制条按钮 + 弹层面板（替换悬浮窗）；
  增益上限 1–10×；元素级链路管理，切集/切清晰度/全屏更稳
- 1.x：Web Audio 接管实现，悬浮面板 UI，增益 1–4×

## 常见问题

**悬停没有提示？** 提示是按钮内的元素，靠 CSS `:hover` 显示，依次确认：
① 脚本版本为 2.1.0 及以上（用户脚本管理器不会热更新，装完需刷新页面）；
② 处在**视频/番剧播放页**且播放器已加载（其它页面没有控制条，也就没有按钮）；
③ 播放器控制条处于显示状态（鼠标在播放器内动一下，控制条会自动隐藏）。

## 调试参考

| 检查项 | 普通态 | 网页全屏 / 全屏态 |
|---|---|---|
| 按钮尺寸 | 36 × 22 px | 54 × 43 px |
| 按钮 line-height | 22 px | 32 px |
| 图标块（`.bpx-player-ctrl-btn-icon`） | 36 × 22 px | 54 × 32 px |
| svg | 36 × 22 px | 54 × 28 px（相对图标块下移 2px） |
| 按钮位置 | `.bpx-player-control-bottom-right` 内、`.bpx-player-ctrl-volume` 之后 | 同左 |
| 面板定位 | 控制条上方（`bottom ≈ container.bottom - entity.top + 8px`），右侧对齐按钮 | 同左 |

MIT License
