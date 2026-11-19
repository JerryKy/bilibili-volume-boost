# 哔哩哔哩 音量增强

**Bilibili Volume Boost** — 让 B 站播放器音量突破 100% 上限，最高放大 **10 倍（约 +20 dB）**。

[![Version](https://img.shields.io/badge/version-0.1.1-00aeec)](CHANGELOG.md)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-supported-28a745)](https://www.tampermonkey.net/)
[![Violentmonkey](https://img.shields.io/badge/Violentmonkey-supported-28a745)](https://violentmonkey.github.io/)

纯油猴用户脚本，零依赖、免构建，单文件安装即用。

## 特性

- **音量放大**：1×–10× 可调（约 +20 dB），在原生音量之上叠加倍率；原生音量条、静音按钮、快捷键照常工作
- **悬停即用**：鼠标划过控制条上的按钮展开面板，指针离开自动收起；触屏 / 键盘可点击或 Tab 聚焦，`Esc` 收起
- **削波保护**：内置压限器，高倍率下抑制破音与削波（可关闭）
- **直通开关**：关闭增强时增益回落到 1×、压限器中立，声音连续不中断，不拆音频链路
- **设置记忆**：localStorage 持久化，切分 P / 换清晰度 / 进出全屏均自动跟随
- **像素对齐**：图标几何运行时镜像原生按钮，普通态与网页全屏 / 全屏态都与相邻按钮对齐

## 安装

前置：Chrome / Edge / Firefox 等支持 Web Audio 的浏览器 + [Tampermonkey](https://www.tampermonkey.net/)
或 [Violentmonkey](https://violentmonkey.github.io/)

1. 安装脚本管理器
2. 打开 [`volume-boost.user.js`](./volume-boost.user.js)，点击 **Raw**，管理器会弹出安装页
3. 确认安装后刷新任意 B 站视频页，控制条音量图标右侧会出现 **🔊+** 按钮

手动安装：管理器 → 新建脚本 → 粘贴脚本全文 → 保存。

> 脚本管理器不会热更新，**升级后需刷新页面**。

## 使用

鼠标划过 **🔊+** 按钮即展开面板（触屏 / 键盘：点击或 Tab 聚焦；`Esc` 或点击空白处收起）。

| 项目 | 说明 |
|---|---|
| 启用增强 | 总开关。关闭后回到原始音量（直通，见「工作原理」） |
| 增益倍率 | `1× – 10×` 滑杆，实时生效，右侧显示对应 dB（2× ≈ +6 dB） |
| 削波保护（压限） | 倍率过大时防止破音 / 削波，建议开启 |
| 状态行 | 当前音频接管状态 |

实际输出音量 = **原生音量 × 倍率**。

## 工作原理

浏览器规范把 `<video>` 的 `volume` 锁死在 `0–1`（100%），写入大于 1 会被静默夹回。
本脚本通过 Web Audio 重新路由音频来绕过这一限制：

```
<video> → MediaElementSource → Gain（1–10×） → DynamicsCompressor（可选） → 扬声器
```

### 为什么关闭增强不会静音

按规范，`<video>` 一旦被 `createMediaElementSource` 接管，音频就**永久只能走这条链路**，且同一元素
不允许二次接管。因此关闭增强时**不能**拆节点或 `close()` AudioContext —— 那等于把元素接到已关闭的
音箱上，当场静音且无法恢复。

本脚本采用**直通模式**：关闭增强时增益回到 `1×`、压限器参数置中性（0 dB 阈值 + 1:1 压缩，完全透明），
声音连续、无需重建。AudioContext 只在 video 元素被销毁（离开 DOM 超过 20s 宽限期）后才回收。

## 限制

- **WASM / bwp 新内核播放器**（灰度中）的音频不走 `<video>`，无法放大；脚本会自动跳过
- 超过 0 dB 后扬声器 / 耳机可能失真：小音量素材适合高倍率，本就响的素材建议 1.5–2× 并开启削波保护
- 浏览器「自动播放策略」下首次需要一次点击才出声（B 站本身亦然），脚本会随点击自动恢复 AudioContext

## 常见问题

**看不到按钮 / 面板不展开？**

1. 确认脚本已安装，并**刷新过页面**（管理器不会热更新）
2. 确认处于**视频 / 番剧播放页**（其他页面没有控制条）
3. 控制条可能已自动隐藏，移动鼠标将其唤出
4. 面板靠**鼠标划过**按钮展开；触屏 / 键盘请点击或 Tab 聚焦

**开了 10× 声音却没变大？**

可能命中了 WASM 内核播放器（见「限制」），或页面尚未获得用户激活（自动播放策略）。面板状态行会
提示「未接管」或「点击播放器后生效」。

**会影响其他网站吗？**

不会。脚本仅在 `www.bilibili.com` / `www.bilibili.tv` 运行，且只处理播放器内的 `<video>`。

## 开发

单个 `.user.js` 文件，无构建步骤，修改后刷新页面即可。

控制条按钮在不同状态下尺寸不同，脚本在运行时读取原生按钮的实测值来镜像（`syncIconMetrics()`）。

| 检查项 | 普通态 | 网页全屏 / 全屏 |
|---|---|---|
| 按钮 | 36 × 22 px | 54 × 43 px |
| 按钮 `line-height` | 22 px | 32 px |
| 图标块 `.bpx-player-ctrl-btn-icon` | 36 × 22 px | 54 × 32 px |
| svg | 36 × 22 px | 54 × 28 px（相对图标块下移 2px） |
| 按钮位置 | `.bpx-player-control-bottom-right` 内、音量按钮之后 | 同左 |
| 面板定位 | 控制条上方 8px，右边缘对齐按钮 | 同左 |

> 网页全屏的状态类加在 `<body>`（`webscreen-fix`）而非播放器容器上，因此图标同步用
> `ResizeObserver` 观察参考图标自身尺寸，而不是监听容器 class。

## 更新日志

见 [CHANGELOG.md](./CHANGELOG.md)。

## 许可证

[MIT](./LICENSE) © JerryKy
