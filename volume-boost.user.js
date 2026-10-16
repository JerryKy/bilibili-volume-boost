// ==UserScript==
// @name         哔哩哔哩 音量增强 (突破 100%)
// @name:en      Bilibili Volume Boost (over 100%)
// @namespace    https://github.com/jerry/bilibili-volume-boost
// @version      0.1.0
// @description  用 Web Audio 接管播放器音频, 把音量放大到最高 10 倍 (约 +20dB); 禁用时自动直通回原始音量; 控制条集成音量增强按钮
// @description:en Take over the player audio via Web Audio and amplify volume up to 10x (~+20dB); passthrough when disabled; control-bar button UI.
// @author       jerry
// @match        *://www.bilibili.com/*
// @match        *://www.bilibili.tv/*
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

/* global localStorage */

(() => {
  'use strict'

  // ================= 配置与常量 =================
  const MAX_BOOST = 10
  const CONFIG_KEY = 'bvb-config-v2'
  const defaultConfig = { enabled: true, boost: 2, limitClipping: true }

  const clamp = (n, min, max) => Math.min(Math.max(n, min), max)

  /** 归一化配置。localStorage 可能被手改或写坏 (boost 变成字符串/NaN),
   *  一旦透传给 AudioParam.setTargetAtTime 会直接抛异常, 所以读入时就收敛到合法区间 */
  const normalizeConfig = (raw) => ({
    enabled: raw.enabled !== false,
    boost: clamp(Number(raw.boost) || defaultConfig.boost, 1, MAX_BOOST),
    limitClipping: raw.limitClipping !== false,
  })

  const loadConfig = () => {
    try {
      const raw = localStorage.getItem(CONFIG_KEY)
      if (raw) return normalizeConfig({ ...defaultConfig, ...JSON.parse(raw) })
    } catch (e) { /* ignore */ }
    return { ...defaultConfig }
  }
  let config = loadConfig()
  const saveConfig = () => {
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(config)) } catch (e) { /* ignore */ }
  }

  // ================= 播放器定位 (基于实测的 bpx DOM) =================
  /** 实测结构: #bilibili-player > .bpx-docker > .bpx-player-container
   *  > .bpx-player-primary-area > .bpx-player-video-area
   *     ├─ .bpx-player-control-wrap > .bpx-player-control-entity
   *     │    └─ .bpx-player-control-bottom
   *     │        ├─ .bpx-player-control-bottom-left   (播放/时间…)
   *     │        └─ .bpx-player-control-bottom-right  (清晰度/倍速/字幕/音量/设置/…全屏)
   *     └─ .bpx-player-video-perch > .bpx-player-video-wrap > video
   */
  const findPlayer = () => {
    const container = document.querySelector('.bpx-player-container')
    if (!container) return null
    const video = container.querySelector('video')
    return { container, video: video || null }
  }

  // ================= 音频接管引擎 =================
  /**
   * v2 架构:
   * - createMediaElementSource 接管后元素音频永久只走 Web Audio 链路, 且禁止二次接管
   * - 关闭增强 = 直通 (增益 1×, 压限器中性), 绝不因开关关闭 AudioContext
   * - 链路按 video 元素用 Map 独立管理; 元素离开 DOM 后再宽限一段才拆除 (见 collectDetached)
   */
  const AudioContextCtor =
    window.AudioContext ||
    (window.webkitAudioContext && window.webkitAudioContext.bind(window)) ||
    null

  const graphs = new Map()
  /** 已处理过的 video 元素: 成功接管和接管失败都会记入.
   *  失败也记, 否则每 2s 心跳都会重试一次 (新建一个 AudioContext + 刷一条控制台警告) */
  const handledVideos = new WeakSet()
  const DETACH_GRACE = 20000
  let activeVideo = null

  const ensureGraph = (video) => {
    const existing = graphs.get(video)
    if (existing) return existing
    if (handledVideos.has(video)) return null
    if (!AudioContextCtor) return null
    let ctx = null
    try {
      ctx = new AudioContextCtor()
      const source = ctx.createMediaElementSource(video)
      const gain = ctx.createGain()
      const limiter = ctx.createDynamicsCompressor()
      gain.gain.value = 0
      source.connect(gain)
      gain.connect(limiter)
      limiter.connect(ctx.destination)
      applyLimiterParams(limiter, false)

      const handler = () => applyGain(video)
      video.addEventListener('volumechange', handler)
      const graph = { ctx, source, gain, limiter, handler, detachedAt: 0 }
      graphs.set(video, graph)
      handledVideos.add(video)
      return graph
    } catch (e) {
      console.warn('[volumeBoost] 接管失败:', e)
      // 半途失败时上面那个 AudioContext 还活着, 必须显式关掉, 否则每次重试都在泄漏上下文
      if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined)
      handledVideos.add(video)
      return null
    }
  }

  const destroyGraph = (video) => {
    const g = graphs.get(video)
    if (!g) return
    if (g.handler) video.removeEventListener('volumechange', g.handler)
    const { ctx, source, gain, limiter } = g
    try { source.disconnect() } catch (e) { /* noop */ }
    try { gain.disconnect() } catch (e) { /* noop */ }
    try { limiter.disconnect() } catch (e) { /* noop */ }
    if (ctx && ctx.state !== 'closed') {
      void ctx.close().catch(() => undefined)
    }
    graphs.delete(video)
    if (video === activeVideo) activeVideo = null
  }

  /** 回收已离开 DOM 的链路。
   *  不立刻拆: 接管是一次性的, 若播放器只是把元素挪走再放回来, 拆掉就等于永久静音且无法重建。
   *  所以先记下"离开时刻", 存活在 DOM 里就清零计时; 真被替换掉的元素不会回来, 宽限期后回收。 */
  const collectDetached = () => {
    const now = Date.now()
    graphs.forEach((g, el) => {
      if (el.isConnected) { g.detachedAt = 0; return }
      if (!g.detachedAt) { g.detachedAt = now; return }
      if (now - g.detachedAt >= DETACH_GRACE) destroyGraph(el)
    })
  }

  const applyLimiterParams = (limiter, active) => {
    const t = limiter.context.currentTime
    if (active) {
      limiter.threshold.setValueAtTime(-1, t)
      limiter.knee.setValueAtTime(3, t)
      limiter.ratio.setValueAtTime(20, t)
      limiter.attack.setValueAtTime(0.001, t)
      limiter.release.setValueAtTime(0.15, t)
    } else {
      limiter.threshold.setValueAtTime(0, t)
      limiter.knee.setValueAtTime(0, t)
      limiter.ratio.setValueAtTime(1, t)
      limiter.attack.setValueAtTime(0.003, t)
      limiter.release.setValueAtTime(0.25, t)
    }
  }

  const applyGain = (video = activeVideo) => {
    if (!video) return
    const g = graphs.get(video)
    if (!g) return
    const { enabled, boost, limitClipping } = config
    const multiplier = enabled ? clamp(boost, 1, MAX_BOOST) : 1
    const target = video.muted ? 0 : clamp(video.volume * multiplier, 0, MAX_BOOST)
    applyLimiterParams(g.limiter, enabled && limitClipping && multiplier > 1)
    g.gain.gain.setTargetAtTime(target, g.ctx.currentTime, 0.03)
  }

  const resumeContexts = () => {
    graphs.forEach((g) => {
      if (g.ctx.state === 'suspended') void g.ctx.resume().catch(() => undefined)
    })
  }

  // ================= UI (控制条按钮 + 设置面板) =================
  const ui = { container: null, btn: null, panel: null }
  let uiControls = null

  /** 悬停开合的"收起"延时器。
   *  面板在控制条上方 8px, 鼠标从按钮斜穿进面板会先经过这段空隙 → 先触发按钮的 mouseleave。
   *  所以离开时不立刻收起, 留一小段宽限给"正要挪进面板"的指针; 进入面板即取消。 */
  let panelHideTimer = null
  const PANEL_HIDE_DELAY = 180

  const cancelPanelHide = () => {
    if (panelHideTimer) { clearTimeout(panelHideTimer); panelHideTimer = null }
  }

  const closePanel = () => {
    cancelPanelHide()
    if (ui.panel) ui.panel.classList.remove('open')
  }

  // 只用于无障碍标签(原生按钮也是这样提供文字, 不用 title, 免得冒出浏览器原生提示)
  const BTN_LABEL = '音量增强 (突破 100%)'

  const SVG_ICON =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">' +
    '<path d="M3 9v6h4l5 5V4L7 9H3z"/>' +
    '<path d="M18.5 7.5h-2v3h-3v2h3v3h2v-3h3v-2h-3z"/>' +
    '</svg>'

  const PANEL_HTML =
    '<div class="bvb-head">' +
    '  <div class="bvb-title">音量增强</div>' +
    '  <div class="bvb-sub">放大播放器音量, 突破 100% 上限</div>' +
    '</div>' +
    '<div class="bvb-row">' +
    '  <span class="bvb-label">启用增强</span>' +
    '  <span class="bvb-switch" data-bvb-role="enabled"><input type="checkbox"></span>' +
    '</div>' +
    '<div class="bvb-row">' +
    '  <span class="bvb-label">增益倍率</span>' +
    '  <span class="bvb-db" data-bvb-role="db"></span>' +
    '</div>' +
    '<input type="range" class="bvb-range" min="1" max="' + MAX_BOOST + '" step="0.5" data-bvb-role="boost">' +
    '<div class="bvb-hint">最高 ' + MAX_BOOST + '× (≈ +' + Math.round(20 * Math.log10(MAX_BOOST)) +
    ' dB)。建议 2–4×, 倍率过大请开启削波保护防破音</div>' +
    '<div class="bvb-row">' +
    '  <span class="bvb-label">削波保护 (压限)</span>' +
    '  <span class="bvb-switch" data-bvb-role="limiter"><input type="checkbox"></span>' +
    '</div>' +
    '<div class="bvb-status" data-bvb-role="status"></div>'

  const CSS =
    // 布局完全交给 B 站自己的 .bpx-player-ctrl-btn / .bpx-player-ctrl-btn-icon 规则
    // (实测: 普通态 36×22 line-height 22px; 网页全屏/全屏 54×43 line-height 32px, 图标 28px)
    // 这里只负责交互与状态配色, 不覆盖尺寸, 否则全屏态会与其他按钮错位
    '.bvb-btn{cursor:pointer;user-select:none}' +
    '.bvb-btn:hover,.bvb-btn:hover .bpx-player-ctrl-btn-icon{color:#00aeec}' +
    '.bvb-btn.bvb-on,.bvb-btn.bvb-on .bpx-player-ctrl-btn-icon{color:#00aeec}' +
    '.bvb-ico{display:block}' +
    '.bvb-ico svg{display:block}' +
    // 面板
    '.bvb-panel{position:absolute;z-index:99999;width:262px;padding:10px 12px;box-sizing:border-box;' +
    '  background:rgba(18,20,24,.95);border:1px solid rgba(255,255,255,.08);border-radius:8px;' +
    '  box-shadow:0 8px 28px rgba(0,0,0,.4);color:#e6e8eb;display:none;' +
    '  font:12px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;pointer-events:auto}' +
    '.bvb-panel.open{display:block}' +
    '.bvb-panel .bvb-head{margin-bottom:6px}' +
    '.bvb-panel .bvb-title{font-size:13px;font-weight:600;color:#fff}' +
    '.bvb-panel .bvb-sub{font-size:11px;color:#99a1a8}' +
    '.bvb-panel .bvb-row{display:flex;align-items:center;justify-content:space-between;padding:5px 0}' +
    '.bvb-panel .bvb-label{color:#e6e8eb}' +
    '.bvb-panel .bvb-db{color:#00aeec;font-variant-numeric:tabular-nums;font-weight:600}' +
    '.bvb-panel .bvb-switch{position:relative;flex:none;width:32px;height:18px;border-radius:9px;background:#4b5158;transition:background .2s;cursor:pointer}' +
    '.bvb-panel .bvb-switch.checked{background:#00aeec}' +
    '.bvb-panel .bvb-switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:left .2s}' +
    '.bvb-panel .bvb-switch.checked::after{left:16px}' +
    '.bvb-panel .bvb-switch input{display:none}' +
    '.bvb-panel .bvb-range{width:100%;margin:2px 0 0;accent-color:#00aeec;cursor:pointer}' +
    '.bvb-panel .bvb-row.off .bvb-label,.bvb-panel .bvb-row.off .bvb-db{opacity:.35}' +
    '.bvb-panel .bvb-range:disabled{opacity:.35;cursor:not-allowed}' +
    '.bvb-panel .bvb-hint{color:#8a9299;font-size:11px;margin-top:2px;line-height:1.5}' +
    '.bvb-panel .bvb-status{margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.08);color:#99a1a8;font-size:11px}'

  let styleInjected = false
  const injectStyle = () => {
    if (styleInjected) return
    styleInjected = true
    const style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)
  }

  let docListenersBound = false
  const bindDocListeners = () => {
    if (docListenersBound) return
    docListenersBound = true
    document.addEventListener('click', (e) => {
      const t = e.target
      if (t && t.closest && !t.closest('.bvb-panel, .bvb-btn')) {
        closePanel()
      }
    }, true)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePanel()
    })
  }

  /**
   * 找到音量按钮所在的控制条右区; 返回 { row, anchor }, 还没到可插入的时机则返回 null
   * row = .bpx-player-control-bottom-right (按钮们所在 flex 行)
   * anchor = 音量按钮(插到其后; 找不到时退化为追加到行尾)
   *
   * 为什么要多判一步"行里有没有原生按钮": 播放器搭建控制条时, 这个 flex 行会先于按钮出现。
   * 此时 anchor 为 null → 走追加分支, 我们的按钮就成了行里唯一的(也是第一个)子元素, 之后
   * 原生按钮陆续追加在它后面 —— 于是按钮永久停在最左端(实测还被 flex 撑到 978×16), 而
   * ensureUI() 之后会判定"已就位"不再校正。所以这种中间态按 pending 处理, 等下一次协调;
   * 只有"行里已有原生按钮、但确实没有音量按钮"时才走追加到行尾的兜底。
   */
  const locateControls = (container) => {
    const row = container.querySelector('.bpx-player-control-bottom-right')
    if (!row) return null
    if (!row.querySelector('.bpx-player-ctrl-btn:not(.bvb-btn)')) return null // 控制条还在搭, 等下一轮
    return { row, anchor: row.querySelector('.bpx-player-ctrl-volume') }
  }

  /** 安装按钮 + 面板。
   *  返回 'pending' (控制条还没挂载, 等下次协调) | 'rebuilt' (本次新建, 需重新镜像几何) | 'ready' */
  const ensureUI = () => {
    const container = (findPlayer() || {}).container
    if (!container) return 'pending'

    const spot = locateControls(container)
    if (!spot) return 'pending' // 控制条还没挂载, 心跳重试

    // 已就位且位置正确 → 跳过
    if (ui.btn && ui.btn.isConnected && spot.row.contains(ui.btn)) {
      ui.container = container
      return 'ready'
    }

    // 重建: 移除旧节点(若还挂在别处); 旧面板的收起定时器一并作废, 否则会去操作已移除的节点
    cancelPanelHide()
    if (ui.btn) { try { ui.btn.remove() } catch (e) { /* noop */ } }
    if (ui.panel) { try { ui.panel.remove() } catch (e) { /* noop */ } }
    ui.container = null; ui.btn = null; ui.panel = null; uiControls = null

    injectStyle()
    ui.container = container

    // ---- 按钮: 插入到音量按钮之后, 结构/类名与原生按钮保持一致 ----
    const btn = document.createElement('div')
    btn.className = 'bpx-player-ctrl-btn bvb-btn'
    // 原生按钮用 aria-label 提供文字(无 title, 避免浏览器原生提示), 这里保持一致
    btn.setAttribute('role', 'button')
    btn.setAttribute('aria-label', BTN_LABEL)
    btn.setAttribute('tabindex', '0')
    btn.innerHTML =
      '<div class="bpx-player-ctrl-btn-icon bvb-ico">' + SVG_ICON + '</div>'
    if (spot.anchor && spot.anchor.nextSibling) {
      spot.row.insertBefore(btn, spot.anchor.nextSibling)
    } else {
      spot.row.appendChild(btn)
    }
    ui.btn = btn

    // ---- 面板: 挂在播放器容器上(overflow 可见, position relative) ----
    const panel = document.createElement('div')
    panel.className = 'bvb-panel'
    panel.innerHTML = PANEL_HTML
    container.appendChild(panel)
    ui.panel = panel

    const role = (name) => panel.querySelector('[data-bvb-role="' + name + '"]')
    const enabledSwitch = role('enabled').querySelector('input')
    const limiterSwitch = role('limiter').querySelector('input')
    const boostSlider = role('boost')
    const boostRow = boostSlider.previousElementSibling
    uiControls = {
      enabledSwitch, limiterSwitch, boostSlider, boostRow,
      dbEl: role('db'),
      statusEl: role('status'),
    }

    const syncUI = () => {
      // input.checked 必须一起同步: 面板左侧的开关视觉态由 span 的 class 决定,
      // 但点击处理读的是 input.checked, 只同步 class 会让首次点击被"吃掉"
      enabledSwitch.checked = config.enabled
      limiterSwitch.checked = config.limitClipping
      role('enabled').classList.toggle('checked', config.enabled)
      role('limiter').classList.toggle('checked', config.limitClipping)
      boostSlider.value = String(config.boost)
      boostSlider.disabled = !config.enabled
      const db = 20 * Math.log10(Math.max(config.boost, 1))
      uiControls.dbEl.textContent = config.boost + '×  (+' + db.toFixed(1) + ' dB)'
      boostRow.classList.toggle('off', !config.enabled)
      btn.classList.toggle('bvb-on', config.enabled && config.boost > 1)
    }
    syncUI()

    enabledSwitch.addEventListener('change', () => {
      config.enabled = enabledSwitch.checked
      saveConfig(); syncUI(); refreshStatus()
      if (activeVideo) applyGain(activeVideo)
    })
    limiterSwitch.addEventListener('change', () => {
      config.limitClipping = limiterSwitch.checked
      saveConfig(); syncUI()
      if (activeVideo) applyGain(activeVideo)
    })
    // 拖动中实时生效, 但不在每个 input 事件里写 localStorage(拖动期间会触发几十次同步落盘)
    boostSlider.addEventListener('input', () => {
      config.boost = clamp(parseFloat(boostSlider.value) || 1, 1, MAX_BOOST)
      syncUI(); refreshStatus()
      if (activeVideo) applyGain(activeVideo)
    })
    boostSlider.addEventListener('change', saveConfig)
    ;['enabled', 'limiter'].forEach((name) => {
      const sw = role(name)
      sw.addEventListener('click', () => {
        const inp = sw.querySelector('input')
        inp.checked = !inp.checked
        inp.dispatchEvent(new Event('change'))
      })
    })

    // ---- 开合交互: 鼠标划过图标即展开, 指针离开图标/面板即收起 ----
    const openPanel = () => {
      cancelPanelHide()
      if (!panel.classList.contains('open')) {
        panel.classList.add('open')
        positionPanel() // 必须等 display 生效后再量, 隐藏态 offsetWidth 为 0
      }
      refreshStatus()
    }
    const scheduleClose = () => {
      cancelPanelHide()
      panelHideTimer = setTimeout(() => { panelHideTimer = null; closePanel() }, PANEL_HIDE_DELAY)
    }

    btn.addEventListener('mouseenter', openPanel)
    btn.addEventListener('mouseleave', scheduleClose)
    // 指针进面板(开关/滑块)即取消收起, 离开面板才收起
    panel.addEventListener('mouseenter', cancelPanelHide)
    panel.addEventListener('mouseleave', scheduleClose)
    // 拖动滑块时指针可能滑出面板, 按下期间不收起
    panel.addEventListener('pointerdown', cancelPanelHide)

    // 触屏 / 键盘没有 hover: 点击与聚焦仍可展开; 点空白处或 Esc 收起
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      openPanel()
    })
    btn.addEventListener('focus', openPanel)

    bindDocListeners()
    return 'rebuilt'
  }

  const positionPanel = () => {
    const { panel, btn, container } = ui
    if (!panel || !btn || !container) return
    // 宽度直接量面板自己(它有 box-sizing:border-box, CSS 里的 width 就是实际宽度),
    // 不在这里再抄一份常量, 否则改 CSS 时必然忘记同步 → 面板横向偏移
    const panelW = panel.offsetWidth
    const cr = container.getBoundingClientRect()
    const br = btn.getBoundingClientRect()
    const entity = container.querySelector('.bpx-player-control-entity')
    const er = entity ? entity.getBoundingClientRect() : null
    // 面板底部 = 控制条顶部上方 8px; 右侧对齐按钮
    const bottom = er ? (cr.bottom - er.top) + 8 : Math.max(8, cr.bottom - br.top + 8)
    const left = clamp((br.right - cr.left) - panelW, 8, Math.max(8, cr.width - panelW - 8))
    panel.style.left = left + 'px'
    panel.style.bottom = bottom + 'px'
  }

  /**
   * 运行时镜像原生按钮的图标几何:
   * B 站按钮在不同状态尺寸不同 (普通 36×22/图标22, 网页全屏与全屏 54×43/图标32+svg28),
   * 且靠 "块级 + line-height" 对齐而非 flex 居中. 这里直接读取同行原生按钮的实测值套用,
   * 任何状态下都能与相邻按钮精确对齐 (只需在状态切换/换容器后调用一次).
   */
  const syncIconMetrics = () => {
    const btn = ui.btn
    if (!btn || !btn.isConnected) return
    const row = btn.parentElement
    if (!row) return
    const myIcon = btn.querySelector('.bvb-ico')
    const mySvg = myIcon && myIcon.querySelector('svg')
    if (!myIcon || !mySvg) return
    // 取同行原生按钮作参照 (设置按钮结构最稳定, 兜底那条要排除自己)
    const refIcon = row.querySelector('.bpx-player-ctrl-setting .bpx-player-ctrl-btn-icon') ||
      row.querySelector('.bpx-player-ctrl-btn-icon:not(.bvb-ico)')
    if (!refIcon) return
    const refSvg = refIcon.querySelector('svg')
    const ics = getComputedStyle(refIcon)
    myIcon.style.width = ics.width
    myIcon.style.height = ics.height
    myIcon.style.lineHeight = ics.lineHeight
    if (refSvg) {
      const scs = getComputedStyle(refSvg)
      mySvg.style.width = scs.width
      mySvg.style.height = scs.height
      // 原生 svg 相对图标块的垂直偏移(部分状态非 0), 精确复刻
      const offset = refSvg.getBoundingClientRect().top - refIcon.getBoundingClientRect().top
      mySvg.style.marginTop = offset + 'px'
    }
  }

  const refreshStatus = () => {
    if (!uiControls || !ui.panel.classList.contains('open')) return
    const s = uiControls.statusEl
    const graph = graphs.get(activeVideo)
    const boosting = config.enabled && config.boost > 1
    if (!activeVideo) {
      s.textContent = '等待播放器…'
    } else if (!AudioContextCtor) {
      s.textContent = '当前浏览器不支持 Web Audio, 无法放大'
    } else if (!graph) {
      s.textContent = config.enabled ? '未接管 (可能已切换视频)' : '已关闭, 播放器为原始音量'
    } else if (graph.ctx.state === 'suspended') {
      s.textContent = boosting
        ? '已接管, 点击播放器后生效 (浏览器自动播放限制)'
        : '直通中, 与原生音量一致'
    } else {
      s.textContent = boosting
        ? '已接管: 音量 0–100% × ' + config.boost + '×'
        : '直通中: 与原生音量一致'
    }
  }

  // ================= 协调 (低频, 避免干扰播放器) =================
  let reconcileTimer = null
  /** reason 只用来区分触发源: 图标几何镜像要读 computed style 并强制布局,
   *  没必要跟着 2s 心跳跑, 只有"尺寸可能变了"的来源才做 */
  const reconcile = (reason) => {
    if (reconcileTimer) return // 合并心跳+观察器触发
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null
      const player = findPlayer()
      const video = player ? player.video : null

      collectDetached()

      const uiState = ensureUI()
      if (uiState === 'rebuilt' || reason !== 'heartbeat') syncIconMetrics()

      if (!video) {
        activeVideo = null // 容器在但还没 video: 按钮已尝试安装
        refreshStatus()
        return
      }

      activeVideo = video
      refreshStatus()

      if (config.enabled && !graphs.has(video)) ensureGraph(video)
      applyGain(video)
    }, 120)
  }

  // ================= 启动 =================
  const start = () => {
    // 只观察两个低变更区: video 所在区域(换源/换清晰度时元素替换) 与控制条右区(挂载)
    let perchObserved = null
    const perchObserver = new MutationObserver(() => reconcile('video-area'))
    // 已挂过"容器状态"观察器的容器。用 WeakSet 而不是给元素挂 expando:
    // defineProperty 一旦失败(页面属性不可写等)守卫就永远不生效, 每次心跳都会重复挂一个观察器
    const observedContainers = new WeakSet()
    const tryObserve = () => {
      const perch = document.querySelector('.bpx-player-video-perch')
      if (perch && perch !== perchObserved) {
        if (perchObserved) perchObserver.disconnect()
        perchObserver.observe(perch, { childList: true, subtree: true })
        perchObserved = perch
      }
      const cont = document.querySelector('.bpx-player-container')
      if (cont && !observedContainers.has(cont)) {
        // SPA 整页重建 + 播放模式切换(网页全屏/全屏会改容器 class) 检测
        observedContainers.add(cont)
        new MutationObserver(() => reconcile('container-state')).observe(cont, {
          childList: true,
          attributes: true,
          attributeFilter: ['class'],
        })
      }
    }
    tryObserve()

    // 全屏/窗口尺寸变化 → 立即镜像图标几何(各状态按钮尺寸不同)
    document.addEventListener('fullscreenchange', () => reconcile('fullscreen'))
    window.addEventListener('resize', () => reconcile('resize'))

    // 兜底心跳: 2s, 覆盖控制条晚挂载 / SPA 导航后容器重建
    setInterval(() => {
      if (document.hidden) return
      tryObserve()
      reconcile('heartbeat')
    }, 2000)

    document.addEventListener('pointerdown', resumeContexts, true)
    document.addEventListener('keydown', resumeContexts, true)
    reconcile('init')
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', start, { once: true })
  } else {
    start()
  }
})()
