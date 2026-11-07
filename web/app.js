/* 五子棋 · 前端逻辑（原生 JS，无依赖） */
(function () {
  'use strict';

  var BOARD_SIZE = 15;
  var BOARD_PAD_RATIO = 0.065; // 棋盘留白占画布比例（与点击命中判定共用）

  var API = {
    room: './api/room',
    join: './api/join',
    move: './api/move',
    restart: './api/restart',
    stream: './api/stream'
  };

  var LS_THEME = 'gomoku:theme';
  var LS_TOKEN_PREFIX = 'gomoku:token.';

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
    restartBtn: $('restart-btn'),
    leaveBtn: $('leave-btn'),
    toast: $('toast')
  };

  var app = {
    roomId: '',
    token: '',
    color: 0, // 1 黑 2 白 0 观战/未入座
    state: null, // 服务器最新 state
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
    palette: null
  };

  /* ============================ 存储 / 主题 ============================ */

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

  function systemPrefersDark() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function applyTheme(theme, persist) {
    document.documentElement.setAttribute('data-theme', theme);
    if (persist) storageSet(LS_THEME, theme);
    if (ui.themeToggle) {
      var name = theme === 'dark' ? '深色' : '浅色';
      ui.themeToggle.setAttribute('aria-label', '切换明暗主题（当前' + name + '）');
      ui.themeToggle.setAttribute('title', '切换明暗主题（当前' + name + '）');
    }
    drawBoard();
  }

  function toggleTheme() {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next, true);
  }

  function initTheme() {
    var stored = storageGet(LS_THEME);
    var theme = stored === 'dark' || stored === 'light' ? stored : (systemPrefersDark() ? 'dark' : 'light');
    applyTheme(theme, false);

    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function (ev) {
        var pref = storageGet(LS_THEME);
        if (pref !== 'dark' && pref !== 'light') {
          applyTheme(ev.matches ? 'dark' : 'light', false);
        }
      };
      if (mq.addEventListener) {
        mq.addEventListener('change', onChange);
      } else if (mq.addListener) {
        mq.addListener(onChange);
      }
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
      boardBg: read('--board-bg', '#ececec'),
      line: read('--board-line', '#8f8f8f'),
      lineStrong: read('--board-line-strong', '#5c5c5c'),
      stoneBlack: read('--stone-black', '#101010'),
      stoneBlackEdge: read('--stone-black-edge', '#000000'),
      stoneWhite: read('--stone-white', '#fdfdfd'),
      stoneWhiteEdge: read('--stone-white-edge', '#8a8a8a'),
      markOnBlack: read('--mark-on-black', '#f5f5f5'),
      markOnWhite: read('--mark-on-white', '#101010'),
      winLine: read('--win-line', 'rgba(0, 0, 0, 0.22)'),
      winRing: read('--win-ring', '#2b2b2b')
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
      /* 某些环境（file://）可能不允许，忽略 */
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

    if (color === 1 || color === 2) {
      return { color: color, token: token };
    }
    // 观战者不保存座位 token
    storageRemove(tokenKey(roomId));
    return { color: 0, token: '' };
  }

  function handleJoinError(err) {
    if (err && err.code === 'room_not_found') {
      toast('房间不存在或已失效');
    } else if (err && err.name === 'AbortError') {
      toast('连接超时，请重试', 'error');
    } else {
      toast('加入房间失败，请稍后重试', 'error');
    }
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
      var color = res && res.color === 2 ? 2 : 1; // 创建者执黑
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

    // 兼容未携带 event 名的 data 消息
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
      // 其他错误静默，交给 EventSource 继续重连
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

    if (previous && previous.winner !== 0 && !state.winner && (state.moves | 0) === 0) {
      toast('新一局开始，黑方先行');
    }

    updateStatus();
    updatePresence();
    updateRestartButton();
    updateBoardCursor();
    drawBoard();
  }

  /* ============================ 视图切换 ============================ */

  function setLobbyControlsDisabled(disabled) {
    ui.createBtn.disabled = disabled;
    ui.joinCode.disabled = disabled;
    ui.joinSubmit.disabled = disabled;
  }

  function showLobby() {
    closeStream();
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

    if ((app.color === 1 || app.color === 2) && app.token) {
      storageSet(tokenKey(roomId), app.token);
    }

    ui.lobby.hidden = true;
    ui.game.hidden = false;
    ui.roomCode.textContent = roomId;
    setRoomInUrl(roomId);
    updateAll();
    window.requestAnimationFrame(drawBoard);
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
      if (readyAt('black') && readyAt('white')) {
        return { text: '双方已准备，正在重开…', tone: 'wait' };
      }
      var base;
      if (state.winner === 3) base = '平局，棋盘已满';
      else if (state.winner === 1) base = '黑方获胜';
      else if (state.winner === 2) base = '白方获胜';
      else base = '本局结束';

      var extra = '';
      if (isPlayer) {
        if (state.winner !== 3) {
          extra += state.winner === app.color ? ' · 你赢了' : ' · 你输了';
        }
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
    ui.board.style.cursor = canPlayNow() ? 'pointer' : 'default';
  }

  function updateAll() {
    updateStatus();
    updatePresence();
    updateRestartButton();
    updateBoardCursor();
    drawBoard();
  }

  /* ============================ 棋盘绘制 ============================ */

  function drawStone(ctx, cx, cy, radius, color, palette) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = color === 1 ? palette.stoneBlack : palette.stoneWhite;
    ctx.fill();
    ctx.lineWidth = Math.max(1, radius * 0.08);
    ctx.strokeStyle = color === 1 ? palette.stoneBlackEdge : palette.stoneWhiteEdge;
    ctx.stroke();
  }

  function drawBoard() {
    var canvas = ui.board;
    if (!canvas || !canvas.getContext) return;

    var rect = canvas.getBoundingClientRect();
    var size = Math.floor(Math.min(rect.width, rect.height));
    if (size < 60) return; // 大厅视图下不可见

    var dpr = window.devicePixelRatio || 1;
    var pixelSize = Math.max(1, Math.round(size * dpr));
    if (canvas.width !== pixelSize || canvas.height !== pixelSize) {
      canvas.width = pixelSize;
      canvas.height = pixelSize;
    }

    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    var palette = getPalette();
    var pad = size * BOARD_PAD_RATIO;
    var step = (size - pad * 2) / (BOARD_SIZE - 1);
    var edge = pad + (BOARD_SIZE - 1) * step;

    // 底色
    ctx.fillStyle = palette.boardBg;
    ctx.fillRect(0, 0, size, size);

    // 网格
    ctx.strokeStyle = palette.line;
    ctx.lineWidth = 1;
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
    ctx.lineWidth = 2;
    ctx.strokeRect(pad - 0.5, pad - 0.5, edge - pad + 1, edge - pad + 1);

    // 星位（天元 + 四星）
    var stars = [[3, 3], [3, 11], [7, 7], [11, 3], [11, 11]];
    ctx.fillStyle = palette.lineStrong;
    for (var s = 0; s < stars.length; s++) {
      ctx.beginPath();
      ctx.arc(pad + stars[s][0] * step, pad + stars[s][1] * step, Math.max(2, step * 0.08), 0, Math.PI * 2);
      ctx.fill();
    }

    var state = app.state;
    var board = state && Array.isArray(state.board) ? state.board : null;
    var radius = step * 0.42;

    // 胜利连线（画在棋子下方）
    if (state && Array.isArray(state.winLine) && state.winLine.length >= 2) {
      var first = state.winLine[0];
      var last = state.winLine[state.winLine.length - 1];
      if (Array.isArray(first) && Array.isArray(last)) {
        ctx.strokeStyle = palette.winLine;
        ctx.lineWidth = Math.max(4, step * 0.5);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(pad + first[0] * step, pad + first[1] * step);
        ctx.lineTo(pad + last[0] * step, pad + last[1] * step);
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

    // 胜利棋子描圈
    if (state && Array.isArray(state.winLine)) {
      ctx.strokeStyle = palette.winRing;
      ctx.lineWidth = Math.max(2, step * 0.09);
      for (var w = 0; w < state.winLine.length; w++) {
        var point = state.winLine[w];
        if (!Array.isArray(point)) continue;
        ctx.beginPath();
        ctx.arc(pad + point[0] * step, pad + point[1] * step, radius + Math.max(2, step * 0.1), 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // 最后一手标记
    if (state && state.lastMove && board) {
      var lm = state.lastMove;
      var lx = Number(lm.x);
      var ly = Number(lm.y);
      if (lx >= 0 && lx < BOARD_SIZE && ly >= 0 && ly < BOARD_SIZE) {
        var lv = board[ly * BOARD_SIZE + lx];
        if (lv === 1 || lv === 2) {
          ctx.fillStyle = lv === 1 ? palette.markOnBlack : palette.markOnWhite;
          ctx.beginPath();
          ctx.arc(pad + lx * step, pad + ly * step, Math.max(2, radius * 0.22), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  function eventToPoint(ev) {
    var rect = ui.board.getBoundingClientRect();
    var size = Math.floor(Math.min(rect.width, rect.height));
    if (size < 60) return null;
    var pad = size * BOARD_PAD_RATIO;
    var step = (size - pad * 2) / (BOARD_SIZE - 1);

    // 画布为正方形；若存在 1px 级差异，按显示尺寸归一化
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
    if (dist > step * 0.5) return null; // 点击容差：半格

    return { x: ix, y: iy };
  }

  /* ============================ 交互 ============================ */

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
    if (state.turn !== app.color) return; // 未轮到自己，静默忽略
    if (app.movePending) return;

    // 对手还没加入时先别落子，避免出现「一个人下满棋盘」
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
    sendMove(point.x, point.y);
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
    // 等待 SSE 推送新的 state；若迟迟未到则恢复按钮可点
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
    if (copied) {
      toast('邀请链接已复制');
    } else {
      toast('复制失败，请从地址栏复制链接', 'error');
    }
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

  /* ============================ 初始化 ============================ */

  function setupResize() {
    var redraw = function () {
      drawBoard();
    };
    if (typeof ResizeObserver !== 'undefined' && ui.board.parentElement) {
      var observer = new ResizeObserver(redraw);
      observer.observe(ui.board.parentElement);
    }
    var timer = null;
    window.addEventListener('resize', function () {
      clearTimeout(timer);
      timer = setTimeout(redraw, 80);
    });
    window.addEventListener('orientationchange', function () {
      setTimeout(redraw, 150);
    });
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
  }

  function init() {
    initTheme();
    bindEvents();
    setupResize();
    showLobby();

    var roomFromUrl = getRoomFromUrl();
    if (roomFromUrl) {
      autoJoinFromUrl(roomFromUrl);
    }
  }

  init();
})();
