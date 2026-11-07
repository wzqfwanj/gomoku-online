/* 五子棋 · 前端逻辑（原生 JS，无依赖） */
(function () {
  'use strict';

  var BOARD_SIZE = 15;
  var BOARD_PAD_RATIO = 0.065; // 棋盘留白占画布比例（与点击命中判定共用）
  var MOVE_ANIM_MS = 560; // 最后一手落子动画时长
  var MUSIC_WATCHDOG_MS = 12000; // 音乐加载超时（超时视为失败，自动跳下一首）

  var API = {
    room: './api/room',
    join: './api/join',
    move: './api/move',
    restart: './api/restart',
    stream: './api/stream'
  };

  var PLAYLIST_URL = './playlist.json';
  var LS_THEME = 'gomoku:theme';
  var LS_TOKEN_PREFIX = 'gomoku:token.';
  var LS_MUSIC = {
    playing: 'gomoku:music:playing',
    volume: 'gomoku:music:volume',
    index: 'gomoku:music:index',
    muted: 'gomoku:music:muted'
  };

  var reducedMotionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  function $(id) {
    return document.getElementById(id);
  }

  var ui = {
    lobby: $('view-lobby'),
    game: $('view-game'),
    createBtn: $('create-btn'),
    joinForm: $('join-form'),
    joinCode: $('join-code'),
    joinSubmit: $('join-submit'),
    themeToggle: $('theme-toggle'),
    roomCode: $('room-code'),
    copyBtn: $('copy-btn'),
    status: $('status'),
    presence: $('presence'),
    board: $('board'),
    boardFx: $('board-fx'),
    restartBtn: $('restart-btn'),
    leaveBtn: $('leave-btn'),
    toast: $('toast'),
    musicBar: $('music-bar'),
    musicPlay: $('music-play'),
    musicNext: $('music-next'),
    musicMute: $('music-mute'),
    musicVolume: $('music-volume'),
    musicTitle: $('music-title'),
    musicArtist: $('music-artist'),
    musicCredit: $('music-credit'),
    audio: $('music-audio')
  };
  var musicInfo = ui.musicTitle ? ui.musicTitle.parentElement : null;

  var app = {
    roomId: '',
    token: '',
    color: 0, // 1 黑 2 白 0 观战/未入座
    state: null,
    es: null,
    joined: false,
    needsRejoin: false,
    busy: false,
    creating: false,
    restartPending: false,
    movePending: false,
    seen: { black: false, white: false },
    spectatorHintShown: false,
    toastTimer: null,
    palette: null,
    view: { ready: false, size: 0, dpr: 1, pad: 0, step: 0 },
    fx: { raf: null, hover: null, moveStart: 0, lastMoveKey: '' },
    music: {
      tracks: [],
      index: 0,
      ready: false,
      available: false,
      playing: false,
      intent: false,
      failures: 0,
      muted: false,
      volume: 0.5,
      watchdog: null,
      pendingPlay: false,
      resumeArmed: false,
      lastErrorAt: 0,
      attemptId: 0,
      failureHandledId: 0
    }
  };

  /* ============================ 存储 / 小工具 ============================ */

  function storageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (err) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (err) {
      /* 忽略隐私模式等写入失败 */
    }
  }

  function storageRemove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (err) {
      /* 忽略 */
    }
  }

  function tokenKey(roomId) {
    return LS_TOKEN_PREFIX + roomId;
  }

  function prefersReducedMotion() {
    return !!(reducedMotionQuery && reducedMotionQuery.matches);
  }

  function systemPrefersDark() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  /* ============================ 主题 ============================ */

  function applyTheme(theme, persist) {
    document.documentElement.setAttribute('data-theme', theme);
    if (persist) storageSet(LS_THEME, theme);
    if (ui.themeToggle) {
      var name = theme === 'dark' ? '深色' : '浅色';
      ui.themeToggle.setAttribute('aria-label', '切换明暗主题（当前' + name + '）');
      ui.themeToggle.setAttribute('title', '切换明暗主题（当前' + name + '）');
    }
    app.palette = null;
    redrawBoard();
  }

  function toggleTheme() {
    applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
  }

  function initTheme() {
    var stored = storageGet(LS_THEME);
    var theme = stored === 'dark' || stored === 'light' ? stored : (systemPrefersDark() ? 'dark' : 'light');
    applyTheme(theme, false);

    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function (ev) {
        var pref = storageGet(LS_THEME);
        if (pref !== 'dark' && pref !== 'light') applyTheme(ev.matches ? 'dark' : 'light', false);
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  }

  function getPalette() {
    var theme = currentTheme();
    if (app.palette && app.palette.theme === theme) return app.palette.colors;

    var styles = getComputedStyle(document.documentElement);
    var read = function (name, fallback) {
      var value = styles.getPropertyValue(name).trim();
      return value || fallback;
    };

    var colors = {
      boardTop: read('--board-bg-top', '#f7f7f7'),
      boardBottom: read('--board-bg-bottom', '#e8e8e8'),
      vignette: read('--board-vignette', 'rgba(0, 0, 0, 0.045)'),
      line: read('--board-line', '#a9a9a9'),
      lineStrong: read('--board-line-strong', '#6e6e6e'),
      star: read('--star', '#6e6e6e'),
      blackHi: read('--stone-black-hi', '#4d4d4d'),
      black: read('--stone-black', '#151515'),
      blackLo: read('--stone-black-lo', '#050505'),
      blackEdge: read('--stone-black-edge', 'rgba(0, 0, 0, 0.5)'),
      blackSpec: read('--stone-black-spec', 'rgba(255, 255, 255, 0.22)'),
      whiteHi: read('--stone-white-hi', '#ffffff'),
      white: read('--stone-white', '#f4f4f4'),
      whiteLo: read('--stone-white-lo', '#d3d3d3'),
      whiteEdge: read('--stone-white-edge', 'rgba(90, 90, 90, 0.55)'),
      whiteSpec: read('--stone-white-spec', 'rgba(255, 255, 255, 0.95)'),
      stoneShadow: read('--stone-shadow', 'rgba(18, 18, 24, 0.26)'),
      markOnBlack: read('--mark-on-black', '#f4f4f4'),
      markOnWhite: read('--mark-on-white', '#141414'),
      winLine: read('--win-line', 'rgba(20, 20, 25, 0.24)'),
      winGlow: read('--win-glow', 'rgba(20, 20, 25, 0.32)'),
      winRing: read('--win-ring', 'rgba(20, 20, 25, 0.72)'),
      ghostRing: read('--ghost-ring', 'rgba(20, 20, 25, 0.45)')
    };
    app.palette = { theme: theme, colors: colors };
    return colors;
  }

  /* ============================ Toast ============================ */

  function toast(message, kind) {
    if (!ui.toast) return;
    ui.toast.textContent = message;
    ui.toast.classList.toggle('toast--error', kind === 'error');
    ui.toast.classList.add('show');
    clearTimeout(app.toastTimer);
    app.toastTimer = setTimeout(function () {
      ui.toast.classList.remove('show');
    }, 2800);
  }

  /* ============================ 网络 ============================ */

  function normalizeRoomId(value) {
    var text = String(value == null ? '' : value).trim().toUpperCase();
    return /^[A-Z0-9]{6}$/.test(text) ? text : '';
  }

  function getRoomFromUrl() {
    try {
      var params = new URLSearchParams(window.location.search);
      return normalizeRoomId(params.get('room'));
    } catch (err) {
      return '';
    }
  }

  function setRoomInUrl(roomId) {
    try {
      window.history.replaceState(null, '', '?room=' + encodeURIComponent(roomId));
    } catch (err) {
      /* 忽略 */
    }
  }

  function clearRoomInUrl() {
    try {
      window.history.replaceState(null, '', window.location.pathname);
    } catch (err) {
      /* 忽略 */
    }
  }

  async function apiPost(path, body) {
    var controller = null;
    var timer = null;
    if (typeof AbortController !== 'undefined') {
      controller = new AbortController();
      timer = setTimeout(function () {
        controller.abort();
      }, 12000);
    }
    try {
      var options = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body || {}),
        cache: 'no-store'
      };
      if (controller) options.signal = controller.signal;
      var response = await fetch(path, options);
      var data = null;
      try {
        data = await response.json();
      } catch (err) {
        data = null;
      }
      if (!response.ok) {
        var error = new Error((data && data.error) || 'http_' + response.status);
        error.status = response.status;
        error.code = (data && data.error) || '';
        throw error;
      }
      return data || {};
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function resolveJoin(res, roomId, fallbackToken) {
    var color = res && typeof res.color === 'number' ? res.color : 0;
    if (color !== 0 && color !== 1 && color !== 2) color = 0;
    var token = res && res.token ? String(res.token) : (fallbackToken || '');
    if (color === 1 || color === 2) return { color: color, token: token };
    storageRemove(tokenKey(roomId));
    return { color: 0, token: '' };
  }

  function handleJoinError(err) {
    if (err && err.code === 'room_not_found') toast('房间不存在或已失效');
    else if (err && err.name === 'AbortError') toast('连接超时，请重试', 'error');
    else toast('加入房间失败，请稍后重试', 'error');
  }

  async function createRoom() {
    if (app.busy || app.creating) return;
    app.creating = true;
    app.busy = true;
    ui.createBtn.disabled = true;
    ui.createBtn.textContent = '创建中…';
    try {
      var res = await apiPost(API.room, {});
      var roomId = normalizeRoomId(res && res.roomId);
      if (!roomId) throw new Error('bad_response');
      var token = res && res.token ? String(res.token) : '';
      var color = res && res.color === 2 ? 2 : 1;
      enterGame(roomId, color, token);
    } catch (err) {
      toast('创建房间失败，请稍后重试', 'error');
    } finally {
      app.creating = false;
      app.busy = false;
      ui.createBtn.disabled = false;
      ui.createBtn.textContent = '创建房间';
    }
  }

  async function joinByCode(code) {
    if (app.busy) return;
    app.busy = true;
    setLobbyControlsDisabled(true);
    try {
      var stored = storageGet(tokenKey(code)) || '';
      var payload = { roomId: code };
      if (stored) payload.token = stored;
      var res = await apiPost(API.join, payload);
      var roomId = normalizeRoomId(res && res.roomId) || code;
      var seat = resolveJoin(res, roomId, stored);
      enterGame(roomId, seat.color, seat.token);
      if (seat.color === 0) toast('房间已满，进入观战');
    } catch (err) {
      handleJoinError(err);
    } finally {
      app.busy = false;
      setLobbyControlsDisabled(false);
    }
  }

  async function autoJoinFromUrl(code) {
    app.busy = true;
    setLobbyControlsDisabled(true);
    ui.joinCode.value = code;
    try {
      var stored = storageGet(tokenKey(code)) || '';
      var payload = { roomId: code };
      if (stored) payload.token = stored;
      var res = await apiPost(API.join, payload);
      var roomId = normalizeRoomId(res && res.roomId) || code;
      var seat = resolveJoin(res, roomId, stored);
      enterGame(roomId, seat.color, seat.token);
      if (seat.color === 0) toast('房间已满或座位已失效，进入观战');
    } catch (err) {
      handleJoinError(err);
      clearRoomInUrl();
      showLobby();
    } finally {
      app.busy = false;
      setLobbyControlsDisabled(false);
    }
  }

  /* ============================ SSE ============================ */

  function closeStream() {
    if (app.es) {
      try {
        app.es.close();
      } catch (err) {
        /* 忽略 */
      }
      app.es = null;
    }
  }

  function openStream() {
    closeStream();
    if (!app.roomId) return;
    if (typeof EventSource === 'undefined') {
      toast('当前浏览器不支持实时连接，请更换浏览器', 'error');
      return;
    }

    var url = API.stream + '?room=' + encodeURIComponent(app.roomId);
    if (app.token) url += '&token=' + encodeURIComponent(app.token);

    var es;
    try {
      es = new EventSource(url);
    } catch (err) {
      toast('无法建立实时连接，请刷新重试', 'error');
      return;
    }
    app.es = es;

    es.addEventListener('open', function () {
      var wasDisconnected = app.needsRejoin;
      app.needsRejoin = false;
      if (wasDisconnected) rejoinAfterReconnect();
    });

    es.addEventListener('state', function (ev) {
      var data = null;
      try {
        data = JSON.parse(ev.data);
      } catch (err) {
        return;
      }
      onServerState(data);
    });

    es.onmessage = function (ev) {
      var data = null;
      try {
        data = JSON.parse(ev.data);
      } catch (err) {
        return;
      }
      onServerState(data);
    };

    es.addEventListener('error', function () {
      if (!app.roomId || app.es !== es) return;
      if (!app.needsRejoin) {
        app.needsRejoin = true;
        toast('连接中断，正在重连…');
      }
    });
  }

  async function rejoinAfterReconnect() {
    if (!app.roomId || !app.token) return;
    try {
      var res = await apiPost(API.join, { roomId: app.roomId, token: app.token });
      var roomId = normalizeRoomId(res && res.roomId);
      if (roomId && roomId !== app.roomId) return;
      var color = res && typeof res.color === 'number' ? res.color : 0;
      if (color === 1 || color === 2) {
        app.color = color;
        if (res && res.token) {
          app.token = String(res.token);
          storageSet(tokenKey(app.roomId), app.token);
        }
        updateAll();
      } else if (color === 0) {
        app.color = 0;
        app.token = '';
        storageRemove(tokenKey(app.roomId));
        toast('座位已失效，转为观战');
        updateAll();
      }
    } catch (err) {
      if (err && err.code === 'room_not_found') {
        toast('房间已失效');
        leaveToLobby();
      }
    }
  }

  function onServerState(state) {
    if (!state || typeof state !== 'object') return;
    var previous = app.state;
    app.state = state;

    if (state.players) {
      if (state.players.black && state.players.black.connected) app.seen.black = true;
      if (state.players.white && state.players.white.connected) app.seen.white = true;
    }
    app.restartPending = false;

    var lm = state.lastMove;
    var key = lm && typeof lm.x === 'number' && typeof lm.y === 'number' ? lm.x + ':' + lm.y + ':' + (state.moves | 0) : '';
    if (key !== app.fx.lastMoveKey) {
      app.fx.lastMoveKey = key;
      app.fx.moveStart = key && !prefersReducedMotion() ? window.performance.now() : 0;
    }

    if (previous && previous.winner !== 0 && !state.winner && (state.moves | 0) === 0) {
      toast('新一局开始，黑方先行');
    }

    updateStatus();
    updatePresence();
    updateRestartButton();
    updateBoardCursor();
    redrawBoard();
  }

  /* ============================ 视图 ============================ */

  function setLobbyControlsDisabled(disabled) {
    ui.createBtn.disabled = disabled;
    ui.joinCode.disabled = disabled;
    ui.joinSubmit.disabled = disabled;
  }

  function resetFxState() {
    app.fx.hover = null;
    app.fx.moveStart = 0;
    app.fx.lastMoveKey = '';
    if (app.fx.raf) {
      window.cancelAnimationFrame(app.fx.raf);
      app.fx.raf = null;
    }
  }

  function showLobby() {
    closeStream();
    resetFxState();
    app.roomId = '';
    app.token = '';
    app.color = 0;
    app.state = null;
    app.joined = false;
    app.needsRejoin = false;
    app.restartPending = false;
    app.movePending = false;
    app.seen = { black: false, white: false };
    app.spectatorHintShown = false;
    app.palette = null;

    ui.game.hidden = true;
    ui.lobby.hidden = false;
    ui.joinCode.value = '';
    ui.roomCode.textContent = '';
    ui.status.textContent = '正在连接…';
    ui.status.className = 'status';
    ui.presence.textContent = '';
    ui.restartBtn.hidden = true;
    ui.restartBtn.disabled = false;
    setLobbyControlsDisabled(false);
  }

  function enterGame(roomId, color, token) {
    closeStream();
    resetFxState();
    app.roomId = roomId;
    app.token = token || '';
    app.color = color === 2 ? 2 : color === 1 ? 1 : 0;
    app.state = null;
    app.joined = true;
    app.needsRejoin = false;
    app.restartPending = false;
    app.movePending = false;
    app.seen = { black: false, white: false };
    app.spectatorHintShown = false;

    if ((app.color === 1 || app.color === 2) && app.token) storageSet(tokenKey(roomId), app.token);

    ui.lobby.hidden = true;
    ui.game.hidden = false;
    ui.roomCode.textContent = roomId;
    setRoomInUrl(roomId);
    updateAll();
    window.requestAnimationFrame(function () {
      redrawBoard();
    });
    openStream();
  }

  function leaveToLobby() {
    closeStream();
    clearRoomInUrl();
    showLobby();
  }

  /* ============================ 状态文案 ============================ */

  function playerAt(seat) {
    return (app.state && app.state.players && app.state.players[seat]) || {};
  }

  function readyAt(seat) {
    return !!playerAt(seat).ready;
  }

  function connectedAt(seat) {
    return !!playerAt(seat).connected;
  }

  function mySeat() {
    if (app.color === 1) return 'black';
    if (app.color === 2) return 'white';
    return '';
  }

  function otherSeat() {
    if (app.color === 1) return 'white';
    if (app.color === 2) return 'black';
    return '';
  }

  function computeStatus() {
    if (!app.roomId) return { text: '', tone: '' };
    var state = app.state;
    if (!state) return { text: '正在连接房间…', tone: 'muted' };

    var isPlayer = app.color === 1 || app.color === 2;
    var mine = mySeat();
    var other = otherSeat();

    if (state.winner) {
      if (readyAt('black') && readyAt('white')) return { text: '双方已准备，正在重开…', tone: 'wait' };
      var base;
      if (state.winner === 3) base = '平局，棋盘已满';
      else if (state.winner === 1) base = '黑方获胜';
      else if (state.winner === 2) base = '白方获胜';
      else base = '本局结束';

      var extra = '';
      if (isPlayer) {
        if (state.winner !== 3) extra += state.winner === app.color ? ' · 你赢了' : ' · 你输了';
        if (readyAt(mine)) extra += ' · 你已准备再来一局';
        else if (readyAt(other)) extra += ' · 对手已准备再来一局';
      } else {
        extra = ' · 观战';
      }
      return { text: base + extra, tone: 'over' };
    }

    if (isPlayer) {
      if (!connectedAt(other)) {
        if (!app.seen[other]) return { text: '等待对手加入房间…', tone: 'wait' };
        return { text: '对手已断线，等待重连…', tone: 'warn' };
      }
      if (state.turn === app.color) return { text: '轮到你落子', tone: 'turn' };
      return { text: '等待对手落子…', tone: 'wait' };
    }

    var turnName = state.turn === 1 ? '黑方' : '白方';
    return { text: '观战中 · 当前' + turnName + '行棋', tone: 'muted' };
  }

  function updateStatus() {
    var info = computeStatus();
    ui.status.textContent = info.text;
    ui.status.className = 'status' + (info.tone ? ' status--' + info.tone : '');
  }

  function updatePresence() {
    var state = app.state;
    if (!state || !state.players) {
      ui.presence.textContent = '';
      return;
    }
    var parts = [];
    ['black', 'white'].forEach(function (seat) {
      var player = playerAt(seat);
      var isMine = (seat === 'black' && app.color === 1) || (seat === 'white' && app.color === 2);
      var label = (seat === 'black' ? '黑方' : '白方') + (isMine ? '（你）' : '');
      var text = player.connected ? '在线' : '离线';
      if (player.ready) text += ' · 已准备';
      parts.push(label + ' ' + text);
    });
    var line = parts.join('　·　');
    if (typeof state.spectators === 'number' && state.spectators > 0) {
      line += '　·　观战 ' + state.spectators + ' 人';
    }
    ui.presence.textContent = line;
  }

  function updateRestartButton() {
    var state = app.state;
    var isPlayer = app.color === 1 || app.color === 2;
    var button = ui.restartBtn;
    if (!isPlayer) {
      button.hidden = true;
      return;
    }
    button.hidden = false;
    var over = !!(state && state.winner);
    var ready = !!(state && app.color && readyAt(mySeat()));
    button.textContent = ready ? '取消准备' : '再来一局';
    button.disabled = !over || app.restartPending;
    button.title = over ? '双方都点击后开始新一局' : '本局结束后可再来一局';
    button.setAttribute('aria-label', button.textContent);
  }

  function canPlayNow() {
    var state = app.state;
    return !!(
      state &&
      (app.color === 1 || app.color === 2) &&
      !state.winner &&
      state.turn === app.color &&
      !app.movePending
    );
  }

  function updateBoardCursor() {
    if (ui.board) ui.board.style.cursor = canPlayNow() ? 'pointer' : 'default';
  }

  function updateAll() {
    updateStatus();
    updatePresence();
    updateRestartButton();
    updateBoardCursor();
    redrawBoard();
  }

  /* ============================ 棋盘绘制 ============================ */

  function layoutCanvases() {
    var base = ui.board;
    var fx = ui.boardFx;
    if (!base || !fx || !base.getContext) {
      app.view.ready = false;
      return false;
    }
    var rect = base.getBoundingClientRect();
    var size = Math.floor(Math.min(rect.width, rect.height));
    if (size < 40) {
      app.view.ready = false;
      return false;
    }
    var dpr = window.devicePixelRatio || 1;
    var pixel = Math.max(1, Math.round(size * dpr));
    [base, fx].forEach(function (canvas) {
      if (canvas.width !== pixel || canvas.height !== pixel) {
        canvas.width = pixel;
        canvas.height = pixel;
      }
      var ctx = canvas.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    });
    var pad = size * BOARD_PAD_RATIO;
    var step = (size - pad * 2) / (BOARD_SIZE - 1);
    app.view = { ready: true, size: size, dpr: dpr, pad: pad, step: step };
    return true;
  }

  function drawStone(ctx, cx, cy, radius, color, palette, options) {
    options = options || {};
    var ghost = !!options.ghost;
    var alpha = typeof options.alpha === 'number' ? options.alpha : 1;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (!ghost) {
      ctx.shadowColor = palette.stoneShadow;
      ctx.shadowBlur = Math.max(2, radius * 0.55);
      ctx.shadowOffsetY = Math.max(1, radius * 0.16);
    }
    var gradient = ctx.createRadialGradient(
      cx - radius * 0.34,
      cy - radius * 0.4,
      radius * 0.08,
      cx,
      cy,
      radius * 1.02
    );
    if (color === 1) {
      gradient.addColorStop(0, palette.blackHi);
      gradient.addColorStop(0.55, palette.black);
      gradient.addColorStop(1, palette.blackLo);
    } else {
      gradient.addColorStop(0, palette.whiteHi);
      gradient.addColorStop(0.6, palette.white);
      gradient.addColorStop(1, palette.whiteLo);
    }
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.lineWidth = Math.max(0.75, radius * 0.055);
    ctx.strokeStyle = color === 1 ? palette.blackEdge : palette.whiteEdge;
    ctx.stroke();
    if (!ghost) {
      ctx.beginPath();
      ctx.arc(cx - radius * 0.3, cy - radius * 0.34, radius * 0.24, 0, Math.PI * 2);
      ctx.fillStyle = color === 1 ? palette.blackSpec : palette.whiteSpec;
      ctx.fill();
    }
    ctx.restore();
  }

  function drawBoardBase() {
    if (!app.view.ready) return;
    var canvas = ui.board;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    var size = app.view.size;
    var dpr = app.view.dpr;
    var pad = app.view.pad;
    var step = app.view.step;
    var edge = pad + (BOARD_SIZE - 1) * step;
    var palette = getPalette();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    // 底色渐变
    var bg = ctx.createLinearGradient(0, 0, size, size);
    bg.addColorStop(0, palette.boardTop);
    bg.addColorStop(1, palette.boardBottom);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size, size);

    // 四周暗角，增加卡面层次
    var vignette = ctx.createRadialGradient(size * 0.5, size * 0.44, size * 0.22, size * 0.5, size * 0.5, size * 0.78);
    vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vignette.addColorStop(1, palette.vignette);
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, size, size);

    // 网格
    ctx.strokeStyle = palette.line;
    ctx.lineWidth = Math.max(0.75, step * 0.028);
    ctx.beginPath();
    for (var i = 0; i < BOARD_SIZE; i++) {
      var p = pad + i * step;
      ctx.moveTo(p, pad);
      ctx.lineTo(p, edge);
      ctx.moveTo(pad, p);
      ctx.lineTo(edge, p);
    }
    ctx.stroke();

    // 外框
    ctx.strokeStyle = palette.lineStrong;
    ctx.lineWidth = Math.max(1.1, step * 0.06);
    ctx.strokeRect(pad, pad, edge - pad, edge - pad);

    // 星位
    var stars = [[3, 3], [3, 11], [7, 7], [11, 3], [11, 11]];
    ctx.fillStyle = palette.star;
    for (var s = 0; s < stars.length; s++) {
      ctx.beginPath();
      ctx.arc(pad + stars[s][0] * step, pad + stars[s][1] * step, Math.max(2, step * 0.075), 0, Math.PI * 2);
      ctx.fill();
    }

    var state = app.state;
    var board = state && Array.isArray(state.board) ? state.board : null;
    var radius = step * 0.43;

    // 胜利连线（画在棋子下面，FX 层额外做光晕）
    if (state && Array.isArray(state.winLine) && state.winLine.length >= 2) {
      var first = state.winLine[0];
      var lastPoint = state.winLine[state.winLine.length - 1];
      if (Array.isArray(first) && Array.isArray(lastPoint)) {
        ctx.strokeStyle = palette.winLine;
        ctx.lineWidth = Math.max(4, step * 0.5);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(pad + first[0] * step, pad + first[1] * step);
        ctx.lineTo(pad + lastPoint[0] * step, pad + lastPoint[1] * step);
        ctx.stroke();
      }
    }

    // 棋子
    if (board) {
      for (var y = 0; y < BOARD_SIZE; y++) {
        for (var x = 0; x < BOARD_SIZE; x++) {
          var value = board[y * BOARD_SIZE + x];
          if (value !== 1 && value !== 2) continue;
          drawStone(ctx, pad + x * step, pad + y * step, radius, value, palette);
        }
      }
    }

    // 最后一手标记（静态圆点，动画在 FX 层）
    if (state && state.lastMove && board) {
      var lm = state.lastMove;
      var lx = Number(lm.x);
      var ly = Number(lm.y);
      if (lx >= 0 && lx < BOARD_SIZE && ly >= 0 && ly < BOARD_SIZE) {
        var lv = board[ly * BOARD_SIZE + lx];
        if (lv === 1 || lv === 2) {
          ctx.fillStyle = lv === 1 ? palette.markOnBlack : palette.markOnWhite;
          ctx.beginPath();
          ctx.arc(pad + lx * step, pad + ly * step, Math.max(2, radius * 0.2), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  function hasWinLine() {
    return !!(app.state && Array.isArray(app.state.winLine) && app.state.winLine.length >= 2);
  }

  function drawFx(now) {
    if (!app.view.ready || !ui.boardFx || !ui.boardFx.getContext) return;
    var ctx = ui.boardFx.getContext('2d');
    if (!ctx) return;
    var size = app.view.size;
    var dpr = app.view.dpr;
    var pad = app.view.pad;
    var step = app.view.step;
    var radius = step * 0.43;
    var palette = getPalette();
    var time = typeof now === 'number' ? now : window.performance.now();
    var state = app.state;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    // 胜利光晕
    if (hasWinLine()) {
      var line = state.winLine;
      var first = line[0];
      var lastPoint = line[line.length - 1];
      if (Array.isArray(first) && Array.isArray(lastPoint)) {
        var pulse = prefersReducedMotion() ? 0.8 : 0.6 + 0.22 * Math.sin(time / 600);
        ctx.save();
        ctx.globalAlpha = pulse;
        ctx.strokeStyle = palette.winGlow;
        ctx.lineWidth = Math.max(6, step * 0.6);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.shadowColor = palette.winGlow;
        ctx.shadowBlur = Math.max(10, step * 0.8);
        ctx.beginPath();
        ctx.moveTo(pad + first[0] * step, pad + first[1] * step);
        ctx.lineTo(pad + lastPoint[0] * step, pad + lastPoint[1] * step);
        ctx.stroke();

        ctx.shadowBlur = Math.max(6, step * 0.4);
        ctx.strokeStyle = palette.winRing;
        ctx.lineWidth = Math.max(1.4, step * 0.09);
        for (var w = 0; w < line.length; w++) {
          if (!Array.isArray(line[w])) continue;
          ctx.beginPath();
          ctx.arc(
            pad + line[w][0] * step,
            pad + line[w][1] * step,
            radius + Math.max(2, step * 0.16),
            0,
            Math.PI * 2
          );
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    // 最后一手落子动画：扩散圆环 + 微光
    if (app.fx.moveStart) {
      var elapsed = time - app.fx.moveStart;
      if (elapsed >= 0 && elapsed < MOVE_ANIM_MS) {
        var progress = elapsed / MOVE_ANIM_MS;
        var eased = 1 - Math.pow(1 - progress, 3);
        var lm = state && state.lastMove;
        if (lm && typeof lm.x === 'number' && typeof lm.y === 'number') {
          var cx = pad + lm.x * step;
          var cy = pad + lm.y * step;
          ctx.save();
          ctx.globalAlpha = (1 - progress) * 0.6;
          ctx.strokeStyle = palette.winRing;
          ctx.lineWidth = Math.max(1.5, step * 0.07);
          ctx.beginPath();
          ctx.arc(cx, cy, radius * (1.05 + eased * 0.85), 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      } else if (elapsed >= MOVE_ANIM_MS) {
        app.fx.moveStart = 0;
      }
    }

    // 悬停幽灵棋子
    var hover = app.fx.hover;
    if (hover && canPlayNow() && state && Array.isArray(state.board) && !state.board[hover.y * BOARD_SIZE + hover.x]) {
      var gx = pad + hover.x * step;
      var gy = pad + hover.y * step;
      var ghostColor = app.color === 1 ? 1 : 2;
      drawStone(ctx, gx, gy, radius, ghostColor, palette, {
        alpha: app.color === 1 ? 0.34 : 0.55,
        ghost: true
      });
      ctx.save();
      ctx.strokeStyle = palette.ghostRing;
      ctx.lineWidth = Math.max(1, step * 0.045);
      ctx.setLineDash([step * 0.2, step * 0.16]);
      ctx.beginPath();
      ctx.arc(gx, gy, radius * 1.14, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  function needsFxLoop(now) {
    if (document.hidden) return false;
    if (app.fx.moveStart && now - app.fx.moveStart < MOVE_ANIM_MS) return true;
    if (hasWinLine() && !prefersReducedMotion()) return true;
    return false;
  }

  function requestFxFrame() {
    if (app.fx.raf) return;
    var tick = function (now) {
      app.fx.raf = null;
      drawFx(now);
      if (needsFxLoop(now)) app.fx.raf = window.requestAnimationFrame(tick);
    };
    app.fx.raf = window.requestAnimationFrame(tick);
  }

  function redrawBoard() {
    if (!layoutCanvases()) return;
    drawBoardBase();
    drawFx(window.performance.now());
    requestFxFrame();
  }

  function eventToPoint(ev) {
    var rect = ui.board.getBoundingClientRect();
    var size = Math.floor(Math.min(rect.width, rect.height));
    if (size < 40) return null;
    var pad = size * BOARD_PAD_RATIO;
    var step = (size - pad * 2) / (BOARD_SIZE - 1);

    var scaleX = rect.width ? size / rect.width : 1;
    var scaleY = rect.height ? size / rect.height : 1;
    var px = (ev.clientX - rect.left) * scaleX;
    var py = (ev.clientY - rect.top) * scaleY;

    var ix = Math.round((px - pad) / step);
    var iy = Math.round((py - pad) / step);
    if (ix < 0 || ix >= BOARD_SIZE || iy < 0 || iy >= BOARD_SIZE) return null;

    var cx = pad + ix * step;
    var cy = pad + iy * step;
    var dist = Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
    if (dist > step * 0.5) return null;
    return { x: ix, y: iy };
  }

  /* ============================ 对局交互 ============================ */

  async function sendMove(x, y) {
    if (!app.roomId || !app.token || app.movePending) return;
    app.movePending = true;
    updateBoardCursor();
    try {
      await apiPost(API.move, { roomId: app.roomId, token: app.token, x: x, y: y });
      // 成功与否都以服务器 SSE 推送的 state 为准，前端不先落子
    } catch (err) {
      if (err && err.code === 'not_your_turn') toast('还没轮到你落子');
      else if (err && err.code === 'invalid_move') toast('这个位置不能落子');
      else if (err && err.code === 'game_over') toast('本局已经结束');
      else if (err && err.code === 'not_player') toast('观战者不能落子');
      else toast('落子失败，请稍后重试', 'error');
    } finally {
      app.movePending = false;
      updateBoardCursor();
    }
  }

  function onBoardClick(ev) {
    var state = app.state;
    if (!state || !Array.isArray(state.board)) return;

    if (state.winner) {
      if (app.color === 1 || app.color === 2) toast('本局已结束，可点击「再来一局」');
      return;
    }
    if (app.color !== 1 && app.color !== 2) {
      if (!app.spectatorHintShown) {
        app.spectatorHintShown = true;
        toast('观战中，不能落子');
      }
      return;
    }
    if (state.turn !== app.color) return;
    if (app.movePending) return;

    var other = otherSeat();
    if (other && !app.seen[other] && !(state.moves > 0)) {
      toast('等待对手加入房间…');
      return;
    }

    var point = eventToPoint(ev);
    if (!point) return;
    if (state.board[point.y * BOARD_SIZE + point.x]) {
      toast('这里已经有棋子了');
      return;
    }
    app.fx.hover = point;
    requestFxFrame();
    sendMove(point.x, point.y);
  }

  function onBoardPointerMove(ev) {
    if (ev && ev.pointerType && ev.pointerType !== 'mouse') return;
    if (!ui.board || !ui.boardFx) return;
    if (!canPlayNow()) {
      if (app.fx.hover) {
        app.fx.hover = null;
        requestFxFrame();
      }
      return;
    }
    var point = eventToPoint(ev);
    var previous = app.fx.hover;
    var changed = (!point && previous) || (point && (!previous || previous.x !== point.x || previous.y !== point.y));
    if (changed) {
      app.fx.hover = point;
      requestFxFrame();
    }
  }

  function onBoardPointerLeave() {
    if (app.fx.hover) {
      app.fx.hover = null;
      requestFxFrame();
    }
  }

  async function restartRound() {
    if (!app.roomId || !app.token || app.restartPending) return;
    var state = app.state;
    if (!state || !state.winner) return;
    app.restartPending = true;
    updateRestartButton();
    try {
      await apiPost(API.restart, { roomId: app.roomId, token: app.token });
      toast('已准备再来一局');
    } catch (err) {
      toast('操作失败，请稍后重试', 'error');
      app.restartPending = false;
      updateRestartButton();
      return;
    }
    setTimeout(function () {
      if (app.restartPending) {
        app.restartPending = false;
        updateRestartButton();
      }
    }, 4000);
  }

  function buildInviteUrl() {
    return window.location.origin + window.location.pathname + '?room=' + encodeURIComponent(app.roomId);
  }

  function fallbackCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, area.value.length);
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (err) {
      ok = false;
    }
    document.body.removeChild(area);
    return ok;
  }

  async function copyInvite() {
    if (!app.roomId) return;
    var url = buildInviteUrl();
    var copied = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
        copied = true;
      }
    } catch (err) {
      copied = false;
    }
    if (!copied) copied = fallbackCopy(url);
    if (copied) toast('邀请链接已复制');
    else toast('复制失败，请从地址栏复制链接', 'error');
  }

  function onJoinSubmit(ev) {
    ev.preventDefault();
    if (app.busy) return;
    var code = normalizeRoomId(ui.joinCode.value);
    if (!code) {
      toast('请输入 6 位房号');
      ui.joinCode.focus();
      return;
    }
    joinByCode(code);
  }

  /* ============================ 背景音乐 ============================ */

  function currentTrack() {
    return app.music.tracks[app.music.index] || null;
  }

  function clearMusicWatchdog() {
    if (app.music.watchdog) {
      clearTimeout(app.music.watchdog);
      app.music.watchdog = null;
    }
  }

  function startMusicWatchdog(attemptId) {
    clearMusicWatchdog();
    app.music.watchdog = setTimeout(function () {
      app.music.watchdog = null;
      var m = app.music;
      if (!m.ready) return;
      if (attemptId !== undefined && attemptId !== m.attemptId) return;
      if (!ui.audio.paused && !ui.audio.ended) return;
      if (m.pendingPlay) onTrackFailure(attemptId);
    }, MUSIC_WATCHDOG_MS);
  }

  function normalizeTrack(track) {
    if (!track || typeof track.url !== 'string' || !track.url.trim()) return null;
    return {
      title: String(track.title || '未命名曲目'),
      artist: String(track.artist || 'Kevin MacLeod'),
      url: track.url.trim(),
      license: String(track.license || 'CC BY 4.0'),
      licenseUrl: String(track.licenseUrl || track.source || 'https://incompetech.com/music/royalty-free/'),
      mood: String(track.mood || '')
    };
  }

  function setMusicDisabled(message) {
    var m = app.music;
    m.ready = false;
    m.available = false;
    m.playing = false;
    m.intent = false;
    m.pendingPlay = false;
    clearMusicWatchdog();
    if (ui.musicBar) ui.musicBar.classList.remove('is-playing', 'is-loading', 'is-muted');
    [ui.musicPlay, ui.musicNext, ui.musicMute, ui.musicVolume].forEach(function (el) {
      if (el) el.disabled = true;
    });
    if (ui.audio) {
      try {
        ui.audio.pause();
      } catch (err) {
        /* 忽略 */
      }
    }
    if (ui.musicTitle) {
      ui.musicTitle.textContent = '背景音乐';
      ui.musicTitle.title = '背景音乐不可用';
      ui.musicTitle.classList.remove('is-scroll');
    }
    if (ui.musicArtist) ui.musicArtist.textContent = message || '音乐不可用';
  }

  function enableMusicControls() {
    [ui.musicPlay, ui.musicNext, ui.musicMute, ui.musicVolume].forEach(function (el) {
      if (el) el.disabled = false;
    });
  }

  function refreshMarquee() {
    if (!ui.musicTitle || !musicInfo) return;
    ui.musicTitle.classList.remove('is-scroll');
    ui.musicTitle.style.removeProperty('--marquee-shift');
    ui.musicTitle.style.removeProperty('--marquee-duration');
    if (prefersReducedMotion()) return;
    window.requestAnimationFrame(function () {
      if (!ui.musicTitle || !musicInfo) return;
      var overflow = ui.musicTitle.scrollWidth - musicInfo.clientWidth;
      if (overflow > 8) {
        ui.musicTitle.style.setProperty('--marquee-shift', '-' + Math.round(overflow) + 'px');
        ui.musicTitle.style.setProperty('--marquee-duration', (9 + overflow / 18).toFixed(1) + 's');
        ui.musicTitle.classList.add('is-scroll');
      }
    });
  }

  function updateCredit(track) {
    if (!ui.musicCredit) return;
    var license = track.license || 'CC BY 4.0';
    var attribution = '音乐：' + (track.artist || 'Kevin MacLeod') + ' · ' + license;
    ui.musicCredit.textContent = license;
    ui.musicCredit.href = track.licenseUrl || 'https://incompetech.com/music/royalty-free/';
    ui.musicCredit.title = attribution;
    ui.musicCredit.setAttribute('aria-label', attribution);
  }

  function updateMusicStatusLabel() {
    var m = app.music;
    var track = currentTrack();
    if (!m.ready || !track || !ui.musicArtist) return;
    if (m.playing) ui.musicArtist.textContent = track.artist || 'Kevin MacLeod';
    else if (m.intent) ui.musicArtist.textContent = '点击继续播放';
    else ui.musicArtist.textContent = '点击播放';
  }

  function updateMusicPlayingUI() {
    var audio = ui.audio;
    var playing = !!(audio && !audio.paused && !audio.ended);
    app.music.playing = playing;
    if (ui.musicBar) ui.musicBar.classList.toggle('is-playing', playing);
    if (ui.musicPlay) {
      ui.musicPlay.setAttribute('aria-label', playing ? '暂停背景音乐' : '播放背景音乐');
      ui.musicPlay.title = playing ? '暂停' : '播放';
    }
    updateMusicStatusLabel();
  }

  function updateMuteUI() {
    var muted = !!app.music.muted;
    if (ui.musicBar) ui.musicBar.classList.toggle('is-muted', muted);
    if (ui.musicMute) {
      ui.musicMute.setAttribute('aria-label', muted ? '取消静音' : '静音');
      ui.musicMute.title = muted ? '取消静音' : '静音';
    }
  }

  function updateTrackLabels(track) {
    if (ui.musicTitle) {
      ui.musicTitle.textContent = track.title;
      ui.musicTitle.title = track.title + (track.artist ? ' · ' + track.artist : '');
    }
    updateCredit(track);
    refreshMarquee();
    updateMusicStatusLabel();
  }

  function selectTrack(index, options) {
    options = options || {};
    var m = app.music;
    if (!m.tracks.length) return;
    m.index = ((index % m.tracks.length) + m.tracks.length) % m.tracks.length;
    storageSet(LS_MUSIC.index, String(m.index));
    var track = m.tracks[m.index];
    m.attemptId += 1;
    var attemptId = m.attemptId;
    clearMusicWatchdog();
    m.pendingPlay = !!options.autoplay;
    if (ui.audio) {
      // 只设置 src，不主动 load()：preload="none" 下真正加载要等用户点击 play()，
      // 避免页面一打开就白耗流量拉取整首 mp3。
      ui.audio.src = track.url;
    }
    updateTrackLabels(track);
    updateMusicPlayingUI();

    if (options.autoplay) {
      m.intent = true;
      storageSet(LS_MUSIC.playing, '1');
      startMusicWatchdog(attemptId);
      var promise = ui.audio.play();
      if (promise && typeof promise.catch === 'function') {
        promise.catch(function (err) {
          handlePlayRejection(err, attemptId);
        });
      }
    }
  }

  function restoreMusic() {
    var m = app.music;
    var storedVolume = parseFloat(storageGet(LS_MUSIC.volume));
    if (isFinite(storedVolume) && storedVolume >= 0) m.volume = Math.min(1, storedVolume);
    else m.volume = 0.5;
    m.muted = storageGet(LS_MUSIC.muted) === '1';
    ui.audio.volume = m.volume;
    ui.audio.muted = m.muted;
    if (ui.musicVolume) ui.musicVolume.value = String(Math.round(m.volume * 100));
    updateMuteUI();

    var storedIndex = parseInt(storageGet(LS_MUSIC.index), 10);
    if (!isFinite(storedIndex) || storedIndex < 0 || storedIndex >= m.tracks.length) storedIndex = 0;
    m.intent = storageGet(LS_MUSIC.playing) === '1';
    enableMusicControls();
    selectTrack(storedIndex, { autoplay: false });
    updateMusicPlayingUI();
    if (m.intent) armResumeOnGesture();
  }

  async function loadPlaylist() {
    if (!ui.audio) return;
    if (ui.musicBar) ui.musicBar.classList.add('is-loading');
    try {
      var response = await fetch(PLAYLIST_URL, { cache: 'no-cache' });
      if (!response.ok) throw new Error('playlist_http_' + response.status);
      var data = await response.json();
      var raw = data && Array.isArray(data.tracks) ? data.tracks : [];
      var tracks = raw.map(normalizeTrack).filter(Boolean);
      if (!tracks.length) throw new Error('playlist_empty');
      app.music.tracks = tracks;
      app.music.ready = true;
      app.music.available = true;
      restoreMusic();
    } catch (err) {
      setMusicDisabled('音乐不可用');
    } finally {
      if (ui.musicBar) ui.musicBar.classList.remove('is-loading');
    }
  }

  function armResumeOnGesture() {
    if (app.music.resumeArmed) return;
    app.music.resumeArmed = true;
    var handler = function (ev) {
      // 点击音乐胶囊内部时交给按钮自身处理，避免刚恢复又被暂停
      if (ev && ev.target && ui.musicBar && ui.musicBar.contains(ev.target)) return;
      detach();
      var m = app.music;
      if (!m.ready || m.playing || !m.intent) return;
      attemptPlay();
    };
    var detach = function () {
      document.removeEventListener('pointerdown', handler, true);
      document.removeEventListener('keydown', handler, true);
      app.music.resumeArmed = false;
    };
    document.addEventListener('pointerdown', handler, true);
    document.addEventListener('keydown', handler, true);
  }

  function handlePlayRejection(err, attemptId) {
    var m = app.music;
    if (attemptId !== undefined && attemptId !== m.attemptId) return; // 旧曲目的迟到事件，忽略
    m.pendingPlay = false;
    clearMusicWatchdog();
    if (err && err.name === 'NotAllowedError') {
      m.intent = false;
      storageSet(LS_MUSIC.playing, '0');
      updateMusicPlayingUI();
      return;
    }
    onTrackFailure(attemptId);
  }

  function onTrackFailure(attemptId) {
    var m = app.music;
    if (!m.ready) return;
    if (attemptId !== undefined && attemptId !== m.attemptId) return; // 旧曲目的迟到事件，忽略
    if (m.failureHandledId === m.attemptId) return; // 同一首只处理一次失败
    m.failureHandledId = m.attemptId;
    clearMusicWatchdog();
    m.pendingPlay = false;
    var now = Date.now();
    if (now - m.lastErrorAt > 900) {
      toast('音乐源暂不可用');
      m.lastErrorAt = now;
    }
    m.failures += 1;
    if (m.failures >= m.tracks.length) {
      m.intent = false;
      storageSet(LS_MUSIC.playing, '0');
      setMusicDisabled('音乐源暂不可用');
      return;
    }
    selectTrack(m.index + 1, { autoplay: m.intent });
  }

  function attemptPlay() {
    var m = app.music;
    if (!m.ready || !m.tracks.length) return;
    if (!ui.audio.getAttribute('src')) selectTrack(m.index, { autoplay: false });
    m.intent = true;
    storageSet(LS_MUSIC.playing, '1');
    m.pendingPlay = true;
    var attemptId = m.attemptId;
    startMusicWatchdog(attemptId);
    var promise = ui.audio.play();
    if (promise && typeof promise.catch === 'function') {
      promise.catch(function (err) {
        handlePlayRejection(err, attemptId);
      });
    }
  }

  function pauseMusic() {
    var m = app.music;
    if (ui.audio) ui.audio.pause();
    m.intent = false;
    m.pendingPlay = false;
    clearMusicWatchdog();
    storageSet(LS_MUSIC.playing, '0');
    updateMusicPlayingUI();
  }

  function onMusicPlayClick() {
    var m = app.music;
    if (!m.ready) return;
    if (!ui.audio.paused && !ui.audio.ended) {
      pauseMusic();
      return;
    }
    attemptPlay();
  }

  function onMusicNextClick() {
    var m = app.music;
    if (!m.ready) return;
    var shouldPlay = m.intent || (!ui.audio.paused && !ui.audio.ended);
    selectTrack(m.index + 1, { autoplay: shouldPlay });
    if (shouldPlay) m.intent = true;
    else updateMusicPlayingUI();
  }

  function bindMusicEvents() {
    if (!ui.audio) return;

    if (ui.musicPlay) ui.musicPlay.addEventListener('click', onMusicPlayClick);
    if (ui.musicNext) ui.musicNext.addEventListener('click', onMusicNextClick);

    if (ui.musicMute) {
      ui.musicMute.addEventListener('click', function () {
        var m = app.music;
        m.muted = !m.muted;
        ui.audio.muted = m.muted;
        storageSet(LS_MUSIC.muted, m.muted ? '1' : '0');
        updateMuteUI();
      });
    }

    if (ui.musicVolume) {
      ui.musicVolume.addEventListener('input', function () {
        var value = Math.min(1, Math.max(0, Number(ui.musicVolume.value) / 100));
        if (!isFinite(value)) return;
        app.music.volume = value;
        ui.audio.volume = value;
        storageSet(LS_MUSIC.volume, String(Math.round(value * 100) / 100));
        if (value > 0 && ui.audio.muted) {
          ui.audio.muted = false;
          app.music.muted = false;
          storageSet(LS_MUSIC.muted, '0');
          updateMuteUI();
        }
      });
    }

    ui.audio.addEventListener('playing', function () {
      var m = app.music;
      clearMusicWatchdog();
      m.pendingPlay = false;
      m.failures = 0;
      m.failureHandledId = 0;
      m.intent = true;
      storageSet(LS_MUSIC.playing, '1');
      updateMusicPlayingUI();
    });

    ui.audio.addEventListener('pause', function () {
      updateMusicPlayingUI();
    });

    ui.audio.addEventListener('ended', function () {
      var m = app.music;
      if (!m.ready) return;
      selectTrack(m.index + 1, { autoplay: m.intent });
    });

    ui.audio.addEventListener('error', function () {
      if (!app.music.ready) return;
      if (!ui.audio.getAttribute('src')) return;
      onTrackFailure(app.music.attemptId);
    });

    ui.audio.addEventListener('volumechange', function () {
      if (!ui.musicVolume) return;
      if (document.activeElement === ui.musicVolume) return;
      ui.musicVolume.value = String(Math.round(ui.audio.volume * 100));
    });
  }

  /* ============================ 初始化 ============================ */

  function setupResize() {
    var schedule = function () {
      window.requestAnimationFrame(function () {
        redrawBoard();
      });
    };
    var debounce = function (fn, wait) {
      var timer = null;
      return function () {
        clearTimeout(timer);
        timer = setTimeout(fn, wait);
      };
    };
    if (typeof ResizeObserver !== 'undefined' && ui.board && ui.board.parentElement) {
      var observer = new ResizeObserver(schedule);
      observer.observe(ui.board.parentElement);
    }
    window.addEventListener('resize', debounce(schedule, 80));
    window.addEventListener('orientationchange', function () {
      setTimeout(schedule, 150);
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (app.fx.raf) {
          window.cancelAnimationFrame(app.fx.raf);
          app.fx.raf = null;
        }
      } else {
        redrawBoard();
      }
    });
    if (reducedMotionQuery) {
      var onMotionChange = function () {
        refreshMarquee();
        redrawBoard();
      };
      if (reducedMotionQuery.addEventListener) reducedMotionQuery.addEventListener('change', onMotionChange);
      else if (reducedMotionQuery.addListener) reducedMotionQuery.addListener(onMotionChange);
    }
  }

  function bindEvents() {
    ui.createBtn.addEventListener('click', createRoom);
    ui.joinForm.addEventListener('submit', onJoinSubmit);
    ui.joinCode.addEventListener('input', function () {
      var cleaned = ui.joinCode.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6);
      if (cleaned !== ui.joinCode.value) ui.joinCode.value = cleaned;
    });
    ui.themeToggle.addEventListener('click', toggleTheme);
    ui.copyBtn.addEventListener('click', copyInvite);
    ui.restartBtn.addEventListener('click', restartRound);
    ui.leaveBtn.addEventListener('click', leaveToLobby);

    ui.board.addEventListener('click', onBoardClick);
    ui.board.addEventListener('pointermove', onBoardPointerMove);
    ui.board.addEventListener('pointerleave', onBoardPointerLeave);
    ui.board.addEventListener('pointercancel', onBoardPointerLeave);
    ui.board.addEventListener('blur', onBoardPointerLeave);

    bindMusicEvents();
  }

  function init() {
    initTheme();
    bindEvents();
    setupResize();
    showLobby();
    loadPlaylist();

    var roomFromUrl = getRoomFromUrl();
    if (roomFromUrl) autoJoinFromUrl(roomFromUrl);
  }

  init();
})();
