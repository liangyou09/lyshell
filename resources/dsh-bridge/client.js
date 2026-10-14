// LyShell 托管 Harness 的 dsh 桥 —— **client 半**（浏览器端 bundle，由官方 clientModules 装载）。
//
// v3：共享同一可用后台与页签。仅同步状态与一次性官方导航，不拦截输入或写操作。
//
// 凭据边界：client 半永远拿不到 host bridge key / LyShell token / 插件 host token；
// 它只用同源 cookie（HttpOnly，脚本读不到值）访问 viewer 端点。也不读 localStorage 存凭据。
;(function () {
  'use strict'

  var STATUS_URL = '/__lyshell/harness/viewer/status'
  var ACK_URL = '/__lyshell/harness/viewer/ack'
  var BROWSE_URL = '/__lyshell/harness/viewer/browse'
  var BANNER_ID = 'lyshell-readonly-banner'
  var POLL_MS = 1000
  var NAV_VERIFY_MS = 6000
  /**
   * 导航刚下发后的「静默观察窗口」：官方 UI 的当前会话在这段时间里的移动先视为导航自身的过渡，
   * 不当作「用户自己切走」。窗口过后仍不在目标才算用户浏览（作废请求，不拽回）。
   * 取 1.2s：远小于 NAV_VERIFY_MS 的等待上限，又足以覆盖一次同步导航的生效延迟。
   */
  var NAV_SETTLE_GRACE_MS = 1200
  var OBSERVE_MS = 400

  var TEXT = {
    title: '与 PetLink 共用 Harness',
    detailHeld: '官方工作台可以正常输入和操作。',
    detailApproval: 'Pet 当前任务有操作需要在桌宠确认。',
    offline: '无法读取 PetLink 连接状态，请重试连接。',
    offlineKeep: 'PetLink 状态暂不可用，官方工作台仍可正常使用。',
    retry: '重试连接',
    retrying: '正在重试…',
    released: 'PetLink 已断开，官方工作台仍可正常使用。'
  }

  function createController() {
    var state = {
      ctx: null,
      uiWorkspace: null,
      sessions: null,
      conversation: null,
      gatedPaths: [],
      readOnly: false,
      reason: null,
      known: false,
      offline: false,
      failures: 0,
      request: null,
      /** 本地已应用的请求（一次性；绝不重复导航） */
      applied: Object.create(null),
      /** 本地已上报过结果的请求（一次性；同一请求不重复 ack） */
      acked: Object.create(null),
      pendingNav: null,
      /**
       * 本次导航请求的**应用时刻**。官方 `uiWorkspace.openSession` 的效力是异步的：
       * 它先改变官方 UI 的当前会话，下一拍才轮到我们去核对。若不区分「刚下发的导航造成的
       * 视图移动」与「用户自己浏览」，这段窗口里的观测会被误判成用户切走，从而把手上的
       * 导航请求当成 superseded 作废掉（表现为：明明落地了却永远等不到确认）。
       */
      navStartedAt: 0,
      /** status 轮询序号：重叠请求里只有**最后发出**那一次的响应能落地（旧响应必须丢弃） */
      pollSeq: 0,
      currentSessionId: null,
      observed: false,
      /** 官方会话列表 → retainInfo 订阅 */
      sessionSubs: Object.create(null),
      listSub: null,
      banner: null,
      bannerText: null,
      notice: null,
      noticeTimer: 0,
      pollTimer: 0,
      observeTimer: 0,
      navTimer: 0,
      stopped: false
    }

    // ===== 官方服务获取（plugin 装载顺序可能晚于本模块；按需重取，不缓存失败） =====
    function service(name) {
      var ctx = state.ctx
      if (!ctx) return null
      try {
        if (typeof ctx.get === 'function') return ctx.get(name) || null
      } catch (error) {
        return null
      }
      return ctx[name] || null
    }
    function refreshServices() {
      if (!state.uiWorkspace) state.uiWorkspace = service('uiWorkspace')
      if (!state.conversation) state.conversation = service('conversation')
      if (!state.sessions) state.sessions = service('sessions')
    }

    // ===== 官方「当前会话」读取（真值来源，不是我们自己记的期望值） =====
    /**
     * 官方 UI 的当前会话 = 持有 mainView 引用的那个会话（uiWorkspace.replaceMain 的真实结果）。
     * 用 `ctx.sessions.retainInfo(id).retainedBy.mainView` 读，而不是猜调用是否成功。
     */
    function readCurrentSession() {
      var sessions = state.sessions || service('sessions')
      state.sessions = sessions
      if (sessions && typeof sessions.retainInfo === 'function') {
        try {
          var list = sessions.list && typeof sessions.list.getSnapshot === 'function' ? sessions.list.getSnapshot() : null
          var ids = list && list.ids ? list.ids : []
          for (var i = 0; i < ids.length; i++) {
            var id = ids[i]
            var info = sessions.retainInfo(id)
            if (!info || typeof info.getSnapshot !== 'function') continue
            var snapshot = info.getSnapshot()
            var by = snapshot && snapshot.retainedBy ? snapshot.retainedBy : null
            if (by && by.mainView > 0) return id
          }
        } catch (error) {
          /* 读失败回落 localStorage */
        }
      }
      // 回落：ui-workspace 的选中项持久化在 localStorage（同一页面的真实状态）
      try {
        var raw = window.localStorage.getItem('dsh.sessions.current')
        if (typeof raw === 'string' && raw.length > 0) {
          var parsed = JSON.parse(raw)
          if (parsed && typeof parsed.sessionId === 'string' && parsed.sessionId.length > 0) return parsed.sessionId
        }
      } catch (error) {
        /* 无持久化/被禁 = 未知 */
      }
      return null
    }

    /** 订阅官方会话列表与各会话的引用计数，让 currentSession 变化即时可见。 */
    function syncSessionSubscriptions() {
      var sessions = state.sessions || service('sessions')
      state.sessions = sessions
      if (!sessions) return
      try {
        var list = sessions.list
        if (list && typeof list.subscribe === 'function' && !state.listSub) {
          state.listSub = list.subscribe(function () {
            syncSessionSubscriptions()
            observeCurrent()
          })
        }
        var snapshot = list && typeof list.getSnapshot === 'function' ? list.getSnapshot() : null
        var ids = snapshot && snapshot.ids ? snapshot.ids : []
        for (var i = 0; i < ids.length; i++) {
          var id = ids[i]
          if (state.sessionSubs[id]) continue
          if (typeof sessions.retainInfo !== 'function') break
          var info = sessions.retainInfo(id)
          if (!info || typeof info.subscribe !== 'function') continue
          state.sessionSubs[id] = info.subscribe(observeCurrent)
        }
      } catch (error) {
        /* 服务尚未就绪：下一次观察再取，不改变官方输入与操作 */
      }
    }

    // ===== 与桥的往返（同源 cookie；无凭据） =====
    function post(url, payload) {
      try {
        return window
          .fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload)
          })
          .then(function (response) {
            if (!response.ok) return null
            return response.json().catch(function () { return null })
          })
          .catch(function () { return null })
      } catch (error) {
        return Promise.resolve(null)
      }
    }

    /** 只清「当前在等的那只」定时器：旧导航的回调绝不能清掉新导航的定时器。 */
    function clearNavTimer(timer) {
      if (!timer) return
      if (state.navTimer === timer) state.navTimer = 0
      window.clearTimeout(timer)
    }

    /**
     * 上报一次导航结果。
     * 一次性：同一请求的重复 ack 直接短路（桥那边也会拒，但本地先挡住，省一次往返）。
     * 竞态：回调只清**它自己那一个** navTimer，且只在 state.pendingNav 仍是本次导航时才清 ——
     * 否则一次迟到的 ack 会把新导航的验证定时器清掉，新导航就永远等不到落地判定。
     */
    function reportAck(status, currentSessionId, reason) {
      var nav = state.pendingNav
      if (!nav) return Promise.resolve(null)
      if (state.acked[nav.requestId]) return Promise.resolve(null)
      // ack 落地前**再读一次**官方当前会话：verify 循环与这里之间隔着若干拍，
      // 期间会话可能又变过。用回调传入的旧值上报，会在桥侧被 `currentSessionId !== sessionId`
      // 判成 stale 而拒绝 —— 结果请求一直挂着、界面永远停在「等待官方界面确认」。
      // 只认**此刻**的官方当前会话；已不在目标就如实降级为 failed（桥会作废该请求，不复位旧位置）。
      var current = status === 'navigated' ? readCurrentSession() : currentSessionId || null
      var effective = status
      var effectiveReason = reason
      if (status === 'navigated' && current !== nav.sessionId) {
        effective = 'failed'
        effectiveReason = 'left-target-before-ack'
      }
      state.acked[nav.requestId] = true
      state.currentSessionId = current
      state.reportedSessionId = current
      var timer = state.navTimer
      var payload = {
        requestId: nav.requestId,
        revision: nav.revision,
        sessionId: nav.sessionId,
        currentSessionId: current,
        status: effective
      }
      if (effectiveReason) payload.reason = effectiveReason
      return post(ACK_URL, payload).then(function (body) {
        if (state.pendingNav === nav) {
          state.pendingNav = null
          clearNavTimer(timer)
          publish()
        }
        return body
      })
    }

    function reportBrowse(currentSessionId) {
      var timer = state.navTimer
      var superseded = state.pendingNav
      // 这条请求既然按「用户浏览」处理掉了，就地标记为已消费：桥可能还会在下一拍把它回显过来，
      // 不能因为回显又把它当成新请求应用一次（那会让「等待官方界面确认」重新亮起来）。
      if (superseded) state.applied[superseded.requestId] = true
      state.pendingNav = null
      state.reportedSessionId = currentSessionId || null
      clearNavTimer(timer)
      // 等待状态变了（不再有未落地请求）⇒ 让 presence 反映出来
      publish()
      return post(BROWSE_URL, { currentSessionId: currentSessionId || null })
    }

    /** 官方当前会话发生变化：区分「我们的导航落地」「用户浏览」两种来源。 */
    function observeCurrent() {
      var current = readCurrentSession()
      var previous = state.currentSessionId
      if (current === null) {
        // 未知（会话切换中/面板清空）：不下结论、不上报，等下一次观测
        state.observed = true
        state.currentSessionId = null
        return
      }
      if (!state.observed) {
        state.observed = true
        state.currentSessionId = current
        return
      }
      if (current === previous) return
      state.currentSessionId = current
      var nav = state.pendingNav
      if (nav && current === nav.sessionId) {
        // 落地：由**实际当前会话**证明，不是由 openSession 的调用证明
        void reportAck('navigated', current)
        return
      }
      // 导航刚下发的过渡窗口（openSession 的效力还没走完）：视图可能先跳到别处再落到目标。
      // 这段窗口里只观察、不下结论 —— 否则会把在等的导航请求误作废（永远等不到确认）。
      // 窗口过后仍不在目标：才算用户自己切走，作废请求并如实上报浏览。
      if (nav && Date.now() - state.navStartedAt < NAV_SETTLE_GRACE_MS) return
      if (nav) {
        // 用户在导航落地前自己切走了：作废本次请求（不拽回），如实上报浏览
        void reportBrowse(current)
        return
      }
      if (previous !== null) {
        // 纯用户浏览：推进 viewer revision，作废旧请求
        void reportBrowse(current)
      }
    }

    /** 应用一次导航请求：一次性，且必须核对官方 UI 真的到了目标会话。 */
    function applyNavigation(request) {
      if (!request || typeof request.requestId !== 'string' || typeof request.sessionId !== 'string') return
      if (state.applied[request.requestId]) return
      state.applied[request.requestId] = true
      var previous = state.pendingNav
      var previousTimer = state.navTimer
      var nav = { requestId: request.requestId, revision: request.revision, sessionId: request.sessionId, at: Date.now() }
      state.pendingNav = nav
      state.navStartedAt = Date.now()
      // 换了新请求：旧请求的验证定时器必须作废（否则它会用旧 nav 判定并抢报结果）
      if (previous) clearNavTimer(previousTimer)
      var uiWorkspace = state.uiWorkspace || service('uiWorkspace')
      state.uiWorkspace = uiWorkspace
      var deadline = Date.now() + NAV_VERIFY_MS
      var verify = function () {
        if (state.stopped || state.pendingNav !== nav) return
        observeCurrent()
        if (state.currentSessionId === nav.sessionId) {
          if (!state.pendingNav) return // observeCurrent 已 ack
          void reportAck('navigated', state.currentSessionId)
          return
        }
        if (Date.now() >= deadline) {
          void reportAck('failed', state.currentSessionId, 'navigation-timeout')
          return
        }
        // 定时器只在仍是本次导航时登记为新的一只（旧的一只已经在上面被清掉）
        var timer = window.setTimeout(verify, 150)
        if (state.pendingNav === nav) state.navTimer = timer
        else window.clearTimeout(timer)
      }
      // client 半可能先于官方工作区服务装载。冷页签在同一有界请求里等待就绪，
      // 不将正常的模块启动顺序立即误报为导航失败，也不重发已应用的导航。
      var openWhenReady = function () {
        if (state.stopped || state.pendingNav !== nav) return
        var actual = readCurrentSession()
        if (actual === nav.sessionId) {
          state.currentSessionId = actual
          void reportAck('navigated', actual)
          return
        }
        uiWorkspace = state.uiWorkspace || service('uiWorkspace')
        state.uiWorkspace = uiWorkspace
        if (!uiWorkspace || typeof uiWorkspace.openSession !== 'function') {
          if (Date.now() >= deadline) {
            void reportAck('failed', state.currentSessionId, 'navigation-unavailable')
            return
          }
          state.navTimer = window.setTimeout(openWhenReady, 100)
          return
        }
        try {
          uiWorkspace.openSession(request.sessionId)
        } catch (error) {
          globalThis.__LYSHELL_HARNESS_CLIENT__.navigationFailure = {
            name: ['AbortError', 'TypeError', 'Error'].indexOf(error?.name) >= 0 ? error.name : 'unknown',
            code: ['session/writer-held', 'session/not-found'].indexOf(error?.code) >= 0 ? error.code : 'unknown'
          }
          void reportAck('failed', state.currentSessionId, 'navigation-failed')
          return
        }
        // 下一拍核对官方界面；调用本身不算真实落地。
        var timer = window.setTimeout(verify, 60)
        if (state.pendingNav === nav) state.navTimer = timer
        else window.clearTimeout(timer)
      }
      openWhenReady()
    }

    function pollStatus() {
      if (state.stopped) return
      // 轮询可能重叠（一次慢响应 + 下一拍定时器）：给每次请求编号，
      // 只有**最后发出**那一次的响应能落地 —— 旧响应绝不能覆盖用户更新的浏览位置/只读态。
      var seq = ++state.pollSeq
      var request = null
      try {
        request = window.fetch(STATUS_URL, { method: 'GET', credentials: 'same-origin', cache: 'no-store' })
      } catch (error) {
        request = null
      }
      if (!request) {
        if (seq === state.pollSeq) onStatusFailure()
        return
      }
      request
        .then(function (response) {
          if (!response.ok) return null
          return response.json().catch(function () { return null })
        })
        .catch(function () { return null })
        .then(function (body) {
          if (state.stopped) return
          if (seq !== state.pollSeq) return // 这一拍已被更新的请求取代：丢弃，不落地任何状态
          if (!body || body.ok !== true) {
            onStatusFailure()
            return
          }
          state.failures = 0
          state.offline = false
          state.known = true
          if (Array.isArray(body.gatedPaths)) state.gatedPaths = body.gatedPaths.slice(0, 256)
          setReadOnly(body.readOnly === true, typeof body.reason === 'string' ? body.reason : null)
          var pending = body.viewer && body.viewer.request ? body.viewer.request : null
          state.request = pending
          // 桥已经不再报这条请求（我们 acks/超时后它被清掉了）：本地等待也必须收尾，
          // 否则状态永远停在「等待官方界面确认」。**只按 requestId 判定**，绝不按 id 复用。
          if (state.pendingNav && (!pending || pending.requestId !== state.pendingNav.requestId)) {
            var staleTimer = state.navTimer
            state.pendingNav = null
            clearNavTimer(staleTimer)
            publish()
          }
          // 归属核对：只有**这条请求归本浏览器**时才去执行导航/ack。
          // 另一个浏览器读到同一条请求只能只读展示 —— 不能替别人的请求宣告落地。
          var owned = !body.viewer || body.viewer.ownedByCurrentViewer !== false
          if (pending && owned) applyNavigation(pending)
          syncSessionSubscriptions()
          observeCurrent()
          // 只发布实测连接与导航状态，不改变官方 composer。
          publish()
        })
    }

    function onStatusFailure() {
      state.failures++
      if (state.failures < 2) return
      if (!state.offline) {
        state.offline = true
        renderBanner()
        publish()
      }
    }

    // ===== 兼容状态字段与连接提示（v3 始终可操作） =====
    function reasonText(reason) {
      return reason === 'approval-pending' ? TEXT.detailApproval : TEXT.detailHeld
    }

    function setReadOnly(next, reason) {
      var changed = state.readOnly !== next || state.reason !== reason
      // v3：后台共享可操作，旧状态也不能重新禁用官方输入。
      state.readOnly = false
      state.reason = reason
      renderBanner()
      if (changed) publish()
    }

    // ===== 横幅（可读原因 + 键盘可达的重试入口；状态不只靠颜色） =====
    function renderBanner(noticeOverride) {
      var doc = document
      if (!doc || !doc.body) return
      var banner = state.banner
      if (!banner || !banner.isConnected) {
        banner = doc.getElementById(BANNER_ID)
        if (!banner) {
          banner = doc.createElement('div')
          banner.id = BANNER_ID
          banner.setAttribute('role', 'status')
          banner.setAttribute('aria-live', 'polite')
          banner.style.cssText = [
            'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
            'display:none', 'gap:8px', 'align-items:center', 'padding:8px 12px',
            'font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif',
            'color:#1b1b1f', 'background:#ffe9b8', 'border-bottom:1px solid #d9a441',
            'box-shadow:0 1px 4px rgba(0,0,0,.18)'
          ].join(';')
          var text = doc.createElement('span')
          text.id = BANNER_ID + '-text'
          text.style.cssText = 'flex:1 1 auto;min-width:0'
          banner.appendChild(text)
          var retry = doc.createElement('button')
          retry.id = BANNER_ID + '-retry'
          retry.type = 'button'
          retry.textContent = TEXT.retry
          retry.style.cssText = [
            'flex:0 0 auto', 'padding:4px 10px', 'border-radius:6px',
            'border:1px solid #8a6413', 'background:#fff7e2', 'color:#4a3606',
            'font:inherit', 'cursor:pointer'
          ].join(';')
          retry.addEventListener('click', function (event) {
            event.preventDefault()
            event.stopPropagation()
            retry.textContent = TEXT.retrying
            state.failures = 0
            state.offline = false
            pollStatus()
            window.setTimeout(function () { retry.textContent = TEXT.retry }, 1200)
          })
          banner.appendChild(retry)
          doc.body.appendChild(banner)
        }
        state.banner = banner
      }
      var textNode = banner.querySelector('#' + BANNER_ID + '-text') || null
      var message
      if (noticeOverride) {
        message = TEXT.title + ' —— ' + noticeOverride
      } else if (state.offline) {
        message = state.readOnly ? TEXT.offlineKeep : TEXT.offline
      } else if (state.readOnly) {
        message = TEXT.title + '：' + reasonText(state.reason)
      } else {
        message = ''
      }
      if (textNode) textNode.textContent = message
      banner.style.display = message ? 'flex' : 'none'
      banner.setAttribute('data-lyshell-readonly', state.readOnly ? '1' : '0')
      if (state.readOnly) banner.setAttribute('data-lyshell-state', state.offline ? 'offline' : 'readonly')
      else banner.removeAttribute('data-lyshell-state')
      try {
        document.documentElement.setAttribute('data-lyshell-readonly', state.readOnly ? '1' : '0')
      } catch (error) {
        /* 忽略 */
      }
    }

    /** 给验证方（与 S2 presence 检查同一钩子）暴露**实测**状态，不是声明。 */
    function publish() {
      var presence = globalThis.__LYSHELL_HARNESS_CLIENT__
      if (!presence) return
      presence.readOnly = state.readOnly
      presence.readOnlyReason = state.reason
      presence.offline = state.offline
      presence.gatedPathCount = state.gatedPaths.length
      presence.currentSessionId = state.currentSessionId
      presence.pendingViewerRequest = state.request ? state.request.requestId : null
      presence.appliedViewerRequests = Object.keys(state.applied).length
      presence.pendingNavigation = state.pendingNav ? state.pendingNav.requestId : null
    }

    function start() {
      refreshServices()
      renderBanner()
      publish()
      pollStatus()
      state.pollTimer = window.setInterval(function () {
        if (state.stopped) return
        refreshServices()
        pollStatus()
      }, POLL_MS)
      state.observeTimer = window.setInterval(function () {
        if (state.stopped) return
        if (!state.observed) observeCurrent()
        syncSessionSubscriptions()
      }, OBSERVE_MS)
      window.addEventListener('beforeunload', function () { state.stopped = true })
    }

    return { state: state, start: start, publish: publish, _test: { readCurrentSession: readCurrentSession } }
  }

  window.__ModuleLoader__.load({
    id: 'lyshell-harness-bridge',
    factory: function () {
      // S2 的存在性标记保留（验证方按它确认 client 半随实例装载）；S4 起它同时是**实测**状态面。
      globalThis.__LYSHELL_HARNESS_CLIENT__ = {
        protocolVersion: 2,
        presence: true,
        readOnly: false,
        readOnlyReason: null,
        offline: false,
        gatedPathCount: 0,
        currentSessionId: null,
        pendingViewerRequest: null,
        appliedViewerRequests: 0,
        pendingNavigation: null
      }
      var controller = createController()
      return {
        inject: [],
        apply(ctx) {
          controller.state.ctx = ctx || null
          try {
            controller.start()
          } catch (error) {
            // 导航观察初始化失败不改装载事实：presence 保留，验证方按状态字段判断
            globalThis.__LYSHELL_HARNESS_CLIENT__.error = String((error && error.message) || error).slice(0, 200)
          }
        }
      }
    }
  })
})()
