/* ==========================================================================
   连连看（Lianliankan）前端模块 —— web/llk.js
   --------------------------------------------------------------------------
   对外契约（由 app.js 调用，DOM 全部自建在 #llk-root 内）：
     window.LLK = {
       init(bridge),      // 只调用一次；bridge={getRoom,getToken,getColor,apiPost,toast}
       render(state,color),// 每次 SSE state 到达时调用；color: 1 黑 / 2 白 / 0 观战
       reset()            // 离开房间时调用
     };
   依赖：web/style.css 里的 CSS 变量（--text/--glass/--border/...），llk.css 中带兜底值。
   本文件不引入任何外域资源。
   ========================================================================== */
(function () {
  'use strict';

  /* ============================ 常量 ============================ */

  var EMOJIS = [
    '\uD83C\uDF4E', /* 🍎 */ '\uD83C\uDF4A', /* 🍊 */ '\uD83C\uDF4B', /* 🍋 */ '\uD83C\uDF47', /* 🍇 */
    '\uD83C\uDF49', /* 🍉 */ '\uD83C\uDF53', /* 🍓 */ '\uD83C\uDF52', /* 🍒 */ '\uD83E\uDD5D', /* 🥝 */
    '\uD83C\uDF51', /* 🍑 */ '\uD83C\uDF4D', /* 🍍 */ '\uD83E\uDD65', /* 🥥 */ '\uD83C\uDF4C', /* 🍌 */
    '\uD83C\uDF30', /* 🌰 */ '\uD83C\uDF44', /* 🍄 */ '\uD83D\uDC1F', /* 🐟 */ '\uD83E\uDD8B'  /* 🦋 */
  ];
  var DEFAULT_SIZE = 8;
  var API_MATCH = './api/match';
  var API_HINT = './api/hint';
  var API_SHUFFLE = './api/shuffle';
  var CLEAR_MS = 300;   /* 与 llk.css 的消除动画时长保持一致 */
  var HINT_MS = 3000;   /* 提示高亮 3 秒 */
  var FLASH_MS = 720;
  var PENDING_MS = 6000;
  var FLASH_CLEAR_SIG = '';

  /* ============================ 模块状态 ============================ */

  var bridge = null;
  var rootEl = null;
  var dom = null;
  var model = createModel();

  function createModel() {
    return {
      state: null,
      color: 0,
      mode: 'play',
      size: DEFAULT_SIZE,
      shown: { self: null, opp: null },     /* 上一帧已绘制的棋盘（用于消除动画 diff） */
      shownCleared: { black: 0, white: 0 }, /* 上一帧已消对数（用于判断我方 match 是否成功） */
      selected: null,                       /* 第一枚已选格子 {x,y} */
      pending: null,                        /* 已提交的配对 {x1,y1,x2,y2} */
      busy: false,
      hint: null,                           /* 当前提示高亮 {x1,y1,x2,y2} */
      hintTimer: null,
      hintBusy: false,
      shuffleBusy: false,
      pendingTimer: null,
      lastClearSig: FLASH_CLEAR_SIG,
      ensureTimer: null
    };
  }

  /* ============================ 小工具 ============================ */

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value == null) return;
        if (key === 'class') node.className = String(value);
        else if (key === 'text') node.textContent = String(value);
        else node.setAttribute(key, String(value));
      });
    }
    if (children) {
      for (var i = 0; i < children.length; i++) {
        if (children[i]) node.appendChild(children[i]);
      }
    }
    return node;
  }

  function bridgeGet(name) {
    if (!bridge || typeof bridge[name] !== 'function') return '';
    try {
      var value = bridge[name]();
      return value == null ? '' : String(value);
    } catch (err) {
      return '';
    }
  }

  function bridgeColor() {
    if (!bridge || typeof bridge.getColor !== 'function') return null;
    var raw;
    try {
      raw = bridge.getColor();
    } catch (err) {
      return null;
    }
    if (raw === 1 || raw === 2) return raw;
    raw = Number(raw);
    return raw === 1 || raw === 2 ? raw : null;
  }

  function bridgeToast(message, kind) {
    if (!bridge || typeof bridge.toast !== 'function') return;
    try {
      bridge.toast(message, kind);
    } catch (err) {
      /* 忽略 toast 实现异常，避免阻断棋局 */
    }
  }

  function makeError(code, message) {
    var error = new Error(message || code || 'llk_error');
    error.code = code || '';
    return error;
  }

  function errorCode(err) {
    if (!err) return '';
    if (err.code) return String(err.code);
    if (err.error) return String(err.error);
    return '';
  }

  function apiPost(path, body) {
    return new Promise(function (resolve, reject) {
      if (!bridge || typeof bridge.apiPost !== 'function') {
        reject(makeError('no_bridge', '网络接口不可用'));
        return;
      }
      var request;
      try {
        request = bridge.apiPost(path, body);
      } catch (err) {
        reject(err);
        return;
      }
      Promise.resolve(request).then(function (res) {
        /* 兼容“不抛错、返回 error 字段”的 bridge 实现 */
        if (res && res.error) {
          reject(makeError(String(res.error), String(res.error)));
          return;
        }
        if (res && res.ok === false) {
          reject(makeError('failed', '操作失败'));
          return;
        }
        resolve(res || {});
      }, reject);
    });
  }

  function colorKey(color) {
    return color === 2 ? 'white' : 'black';
  }

  function otherKey(key) {
    return key === 'black' ? 'white' : 'black';
  }

  function clampCount(value, max) {
    var n = Number(value);
    if (!isFinite(n) || n < 0) n = 0;
    n = Math.floor(n);
    return n > max ? max : n;
  }

  function clearTimer(holder, key) {
    if (holder && holder[key]) {
      clearTimeout(holder[key]);
      holder[key] = null;
    }
  }

  function clearPendingTimer() {
    clearTimer(model, 'pendingTimer');
  }

  function clearHintTimer() {
    clearTimer(model, 'hintTimer');
  }

  /* ============================ 状态归一化 ============================ */

  function normalizeBoard(raw, size) {
    var total = size * size;
    var out = new Array(total);
    var source = Array.isArray(raw) ? raw : [];
    for (var i = 0; i < total; i++) {
      var type = Number(source[i]);
      if (!isFinite(type) || type < 1 || type > EMOJIS.length) type = 0;
      else type = Math.floor(type);
      out[i] = type;
    }
    return out;
  }

  function normalizeLastClear(raw, size) {
    if (!raw || typeof raw !== 'object') return null;
    var color = Number(raw.color);
    var x1 = Number(raw.x1);
    var y1 = Number(raw.y1);
    var x2 = Number(raw.x2);
    var y2 = Number(raw.y2);
    if (color !== 1 && color !== 2) return null;
    var values = [x1, y1, x2, y2];
    for (var i = 0; i < values.length; i++) {
      if (!isFinite(values[i]) || Math.floor(values[i]) !== values[i]) return null;
      if (values[i] < 0 || values[i] >= size) return null;
    }
    return { color: color, x1: x1, y1: y1, x2: x2, y2: y2 };
  }

  function normalizePlayer(raw) {
    return {
      connected: !!(raw && raw.connected),
      ready: !!(raw && raw.ready)
    };
  }

  function normalizeState(raw) {
    var size = Number(raw.size);
    if (!isFinite(size) || size < 2) size = DEFAULT_SIZE;
    size = Math.min(Math.max(Math.floor(size), 2), 16);

    var boards = raw.boards && typeof raw.boards === 'object' ? raw.boards : {};
    var clearedRaw = raw.cleared && typeof raw.cleared === 'object' ? raw.cleared : {};
    var playersRaw = raw.players && typeof raw.players === 'object' ? raw.players : {};

    var totalPairs = Number(raw.totalPairs);
    if (!isFinite(totalPairs) || totalPairs <= 0) totalPairs = Math.floor(size * size / 2);
    totalPairs = Math.floor(totalPairs);

    return {
      room: raw.room ? String(raw.room) : '',
      size: size,
      boards: {
        black: normalizeBoard(boards.black, size),
        white: normalizeBoard(boards.white, size)
      },
      cleared: {
        black: clampCount(clearedRaw.black, totalPairs),
        white: clampCount(clearedRaw.white, totalPairs)
      },
      totalPairs: totalPairs,
      winner: raw.winner === 1 || raw.winner === 2 ? raw.winner : 0,
      lastClear: normalizeLastClear(raw.lastClear, size),
      players: {
        black: normalizePlayer(playersRaw.black),
        white: normalizePlayer(playersRaw.white)
      },
      spectators: Number(raw.spectators) || 0
    };
  }

  /* ============================ DOM 构建 ============================ */

  function ensureUI() {
    var root = document.getElementById('llk-root');
    if (!root) return false;
    if (dom && dom.container && dom.container.parentNode === root) {
      rootEl = root;
      return true;
    }
    buildUI(root);
    return true;
  }

  function buildUI(root) {
    if (dom && dom.container && dom.container.parentNode) {
      dom.container.parentNode.removeChild(dom.container);
    }

    var status = el('p', {
      id: 'llk-status',
      class: 'llk-status is-muted',
      role: 'status',
      'aria-live': 'polite',
      text: '正在同步…'
    });

    var selfCount = el('b', { id: 'llk-self-count', text: '0' });
    var oppCount = el('b', { id: 'llk-opp-count', text: '0' });
    var selfTotal = el('span', { class: 'llk-total', text: '/32' });
    var oppTotal = el('span', { class: 'llk-total', text: '/32' });
    var selfScoreLabel = el('span', { id: 'llk-self-score-label', class: 'llk-score-label', text: '你' });
    var oppScoreLabel = el('span', { id: 'llk-opp-score-label', class: 'llk-score-label', text: '对手' });
    var selfScoreItem = el('span', { id: 'llk-self-score-item', class: 'llk-score-item' }, [selfScoreLabel, selfCount, selfTotal]);
    var oppScoreItem = el('span', { id: 'llk-opp-score-item', class: 'llk-score-item' }, [oppScoreLabel, oppCount, oppTotal]);

    var score = el('div', { class: 'llk-score', id: 'llk-score' }, [
      selfScoreItem,
      el('span', { class: 'llk-score-sep', 'aria-hidden': 'true', text: '·' }),
      oppScoreItem
    ]);

    var oppBar = el('i', { id: 'llk-opp-bar', class: 'llk-bar-fill' });
    var oppBarWrap = el('span', {
      class: 'llk-bar',
      role: 'progressbar',
      'aria-label': '对手进度',
      'aria-valuemin': '0',
      'aria-valuemax': '32',
      'aria-valuenow': '0'
    }, [oppBar]);
    var oppCaption = el('span', { id: 'llk-opp-caption', class: 'llk-bar-caption', text: '对手 0/32' });
    var oppProgress = el('div', { class: 'llk-opp-progress', id: 'llk-opp-progress' }, [oppBarWrap, oppCaption]);

    var hintBtn = el('button', { id: 'llk-hint', class: 'llk-btn', type: 'button', text: '提示' });
    var shuffleBtn = el('button', { id: 'llk-shuffle', class: 'llk-btn', type: 'button', text: '重排' });
    var tools = el('div', { class: 'llk-tools', id: 'llk-tools' }, [
      hintBtn,
      shuffleBtn,
      el('span', { class: 'llk-tip', id: 'llk-tip', text: '选两张相同图案，直线或一次拐弯相连即可消除' })
    ]);

    var meta = el('div', { class: 'llk-meta', id: 'llk-meta' }, [score, oppProgress]);
    var head = el('header', { class: 'llk-head' }, [
      el('div', { class: 'llk-topline' }, [
        el('p', { class: 'llk-eyebrow', text: 'LIANLIANKAN · 实时竞速' }),
        status
      ]),
      meta,
      tools
    ]);

    var selfLabel = el('span', { id: 'llk-self-label', class: 'llk-pane-label', text: '黑方' });
    var selfState = el('span', { id: 'llk-self-state', class: 'llk-pane-state', text: '在线' });
    var selfPane = el('section', { id: 'llk-self-pane', class: 'llk-pane llk-pane-self' }, [
      el('div', { class: 'llk-pane-head' }, [selfLabel, selfState]),
      el('div', {
        id: 'llk-self-board',
        class: 'llk-board',
        role: 'group',
        'aria-label': '我的棋盘'
      })
    ]);

    var oppLabel = el('span', { id: 'llk-opp-label', class: 'llk-pane-label', text: '白方' });
    var oppState = el('span', { id: 'llk-opp-state', class: 'llk-pane-state', text: '离线' });
    var oppPane = el('section', { id: 'llk-opp-pane', class: 'llk-pane llk-pane-opp' }, [
      el('div', { class: 'llk-pane-head' }, [oppLabel, oppState]),
      el('div', {
        id: 'llk-opp-board',
        class: 'llk-board',
        role: 'group',
        'aria-label': '对方棋盘'
      })
    ]);

    var boards = el('div', { class: 'llk-boards', id: 'llk-boards' }, [selfPane, oppPane]);
    var container = el('div', { class: 'llk', 'data-mode': 'play' }, [head, boards]);

    root.appendChild(container);

    rootEl = root;
    var selfBoard = container.querySelector('#llk-self-board');
    var oppBoard = container.querySelector('#llk-opp-board');

    dom = {
      container: container,
      status: status,
      selfCount: selfCount,
      oppCount: oppCount,
      totals: [selfTotal, oppTotal],
      selfScoreItem: selfScoreItem,
      oppScoreItem: oppScoreItem,
      selfScoreLabel: selfScoreLabel,
      oppScoreLabel: oppScoreLabel,
      oppBar: oppBar,
      oppBarWrap: oppBarWrap,
      oppCaption: oppCaption,
      oppProgress: oppProgress,
      hintBtn: hintBtn,
      shuffleBtn: shuffleBtn,
      tools: tools,
      selfBoard: selfBoard,
      oppBoard: oppBoard,
      selfPane: selfPane,
      oppPane: oppPane,
      selfLabel: selfLabel,
      oppLabel: oppLabel,
      selfState: selfState,
      oppState: oppState,
      selfTiles: buildBoard(selfBoard, model.size, 'self'),
      oppTiles: buildBoard(oppBoard, model.size, 'opp')
    };

    hintBtn.addEventListener('click', onHintClick);
    shuffleBtn.addEventListener('click', onShuffleClick);
    refreshControls();
    rootEl.removeAttribute('hidden');
  }

  function buildBoard(boardEl, size, kind) {
    boardEl.textContent = '';
    boardEl.style.setProperty('--llk-size', String(size));
    var tiles = [];
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var tile = el('button', {
          type: 'button',
          class: 'llk-tile is-empty',
          'data-x': x,
          'data-y': y,
          'data-type': '0',
          'aria-label': '第' + (y + 1) + '行第' + (x + 1) + '列，空格'
        });
        tile.disabled = true;
        tile._llkX = x;
        tile._llkY = y;
        tile._llkKind = kind;
        tile.addEventListener('click', onTileClick);
        boardEl.appendChild(tile);
        tiles.push(tile);
      }
    }
    return tiles;
  }

  /* ============================ 渲染 ============================ */

  function render(rawState, rawColor) {
    if (!rawState || typeof rawState !== 'object') return;
    if (rawState.game && rawState.game !== 'lianliankan') return;
    if (!ensureUI()) return;

    var color = rawColor;
    if (color !== 0 && color !== 1 && color !== 2) color = bridgeColor();
    if (color !== 0 && color !== 1 && color !== 2) color = 0;

    var state = normalizeState(rawState);
    var previous = model.state;

    model.state = state;
    model.color = color;
    model.mode = color === 0 ? 'spectate' : 'play';

    /* 棋盘尺寸变化（换房间/重开）时重建格子 */
    if (!dom.selfTiles || dom.selfTiles.length !== state.size * state.size) {
      model.size = state.size;
      dom.selfTiles = buildBoard(dom.selfBoard, state.size, 'self');
      dom.oppTiles = buildBoard(dom.oppBoard, state.size, 'opp');
      model.shown = { self: null, opp: null };
      resetInteraction();
    }

    /* 我方上一次 match 是否已被服务器 state 确认 */
    if (model.pending && pendingSucceeded(state)) {
      resolvePending();
      model.selected = null;
    }

    updateBoard('self', boardFor(state, 'self'), state.size);
    updateBoard('opp', boardFor(state, 'opp'), state.size);
    model.shownCleared = {
      black: state.cleared.black,
      white: state.cleared.white
    };

    validateSelection();
    validateHint();
    paintSelection();
    paintHint();
    updateHeader(state);
    updateMode(state);
    updateFlash(state);

    var previousWinner = previous ? previous.winner : 0;
    if (state.winner && !previousWinner) {
      bridgeToast(winnerToast(state), 'info');
    }
    if (!state.winner && previousWinner) {
      /* 重开：允许下一次胜利再次提示 */
      model.lastClearSig = FLASH_CLEAR_SIG;
    }
  }

  function boardFor(state, role) {
    if (model.mode === 'spectate') {
      return role === 'self' ? state.boards.black : state.boards.white;
    }
    var mine = colorKey(model.color);
    var theirs = otherKey(mine);
    return role === 'self' ? state.boards[mine] : state.boards[theirs];
  }

  function pendingSucceeded(state) {
    var mine = colorKey(model.color);
    if ((state.cleared[mine] || 0) > (model.shownCleared[mine] || 0)) return true;
    var pending = model.pending;
    var before = model.shown.self;
    var after = boardFor(state, 'self');
    var size = state.size;
    var i1 = pending.y1 * size + pending.x1;
    var i2 = pending.y2 * size + pending.x2;
    if (!before || !after) return false;
    return (before[i1] | 0) !== (after[i1] | 0) || (before[i2] | 0) !== (after[i2] | 0);
  }

  function updateBoard(kind, data, size) {
    var tiles = kind === 'self' ? dom.selfTiles : dom.oppTiles;
    if (!tiles) return;
    var prev = model.shown[kind];
    var interactive = kind === 'self' && model.mode === 'play' && !model.state.winner;

    for (var i = 0; i < tiles.length && i < data.length; i++) {
      var tile = tiles[i];
      var type = data[i] | 0;
      var old = prev ? (prev[i] | 0) : 0;

      if (type === 0 && old > 0) {
        paintClearing(tile, old, i % size, Math.floor(i / size));
      } else if (type === 0 && tile.classList.contains('is-clearing')) {
        /* 正在播放消除动画，等计时器收尾，避免下一帧提前打断 */
        continue;
      } else if (type === 0) {
        paintEmpty(tile, i % size, Math.floor(i / size));
      } else {
        paintTile(tile, type, i % size, Math.floor(i / size), interactive);
      }
    }
    model.shown[kind] = data.slice();
  }

  function paintTile(tile, type, x, y, interactive) {
    stopClearing(tile);
    tile.dataset.type = String(type);
    tile.textContent = EMOJIS[type - 1] || '?';
    tile.classList.remove('is-empty', 'is-clearing');
    tile.classList.toggle('is-locked', !interactive);
    tile.disabled = !interactive;
    tile.setAttribute('aria-label', '第' + (y + 1) + '行第' + (x + 1) + '列，' + (EMOJIS[type - 1] || '') + '图案');
  }

  function paintEmpty(tile, x, y) {
    stopClearing(tile);
    tile.dataset.type = '0';
    tile.textContent = '';
    tile.classList.add('is-empty');
    tile.classList.remove('is-clearing', 'is-locked', 'is-selected', 'is-pending');
    tile.disabled = true;
    tile.setAttribute('aria-pressed', 'false');
    tile.setAttribute('aria-label', '第' + (y + 1) + '行第' + (x + 1) + '列，空格');
  }

  function paintClearing(tile, oldType, x, y) {
    stopClearing(tile);
    tile.dataset.type = '0';
    tile.textContent = EMOJIS[oldType - 1] || '';
    tile.classList.remove('is-empty', 'is-locked', 'is-selected', 'is-pending');
    tile.classList.add('is-clearing');
    tile.disabled = true;
    tile.setAttribute('aria-pressed', 'false');
    tile.setAttribute('aria-label', '第' + (y + 1) + '行第' + (x + 1) + '列，已消除');
    tile._llkTimer = setTimeout(function () {
      tile._llkTimer = null;
      if (tile.classList.contains('is-clearing')) {
        paintEmpty(tile, x, y);
      }
    }, CLEAR_MS + 40);
  }

  function stopClearing(tile) {
    if (tile._llkTimer) {
      clearTimeout(tile._llkTimer);
      tile._llkTimer = null;
    }
    tile.classList.remove('is-clearing');
  }

  function validateSelection() {
    var selected = model.selected;
    if (!selected) return;
    if (model.mode !== 'play' || !model.state || model.state.winner) {
      model.selected = null;
      return;
    }
    var board = boardFor(model.state, 'self');
    var index = selected.y * model.state.size + selected.x;
    if (!board[index]) model.selected = null;
  }

  function validateHint() {
    var hint = model.hint;
    if (!hint) return;
    if (model.mode !== 'play' || !model.state || model.state.winner) {
      model.hint = null;
      clearHintTimer();
      return;
    }
    var board = boardFor(model.state, 'self');
    var size = model.state.size;
    var i1 = hint.y1 * size + hint.x1;
    var i2 = hint.y2 * size + hint.x2;
    /* 棋盘可能因服务端“自动重排”而刷新：坐标若已不是一对同图案则丢弃高亮 */
    if (!board[i1] || !board[i2] || board[i1] !== board[i2]) {
      model.hint = null;
      clearHintTimer();
    }
  }

  function paintSelection() {
    if (!dom) return;
    var selected = model.selected;
    var pending = model.pending;
    for (var i = 0; i < dom.selfTiles.length; i++) {
      var tile = dom.selfTiles[i];
      var x = tile._llkX;
      var y = tile._llkY;
      var isSelected = !!selected && selected.x === x && selected.y === y;
      var isPending = !!pending && (
        (pending.x1 === x && pending.y1 === y) ||
        (pending.x2 === x && pending.y2 === y)
      );
      if (isPending) isSelected = true;
      tile.classList.toggle('is-selected', isSelected);
      tile.classList.toggle('is-pending', isPending);
      if (!tile.classList.contains('is-empty')) {
        tile.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
      }
    }
  }

  function paintHint() {
    if (!dom) return;
    var hint = model.hint;
    for (var i = 0; i < dom.selfTiles.length; i++) {
      var tile = dom.selfTiles[i];
      var on = !!hint && (
        (hint.x1 === tile._llkX && hint.y1 === tile._llkY) ||
        (hint.x2 === tile._llkX && hint.y2 === tile._llkY)
      );
      tile.classList.toggle('is-hint', on && !tile.classList.contains('is-empty'));
    }
  }

  function updateHeader(state) {
    if (!dom) return;
    var mine = colorKey(model.color);
    var theirs = otherKey(mine);
    var selfCleared = model.mode === 'spectate' ? state.cleared.black : state.cleared[mine];
    var oppCleared = model.mode === 'spectate' ? state.cleared.white : state.cleared[theirs];
    var total = state.totalPairs;

    dom.selfCount.textContent = String(selfCleared);
    dom.oppCount.textContent = String(oppCleared);
    for (var i = 0; i < dom.totals.length; i++) {
      dom.totals[i].textContent = '/' + total;
    }

    var percent = total > 0 ? Math.min(100, Math.max(0, oppCleared / total * 100)) : 0;
    dom.oppBar.style.width = percent.toFixed(1) + '%';
    dom.oppBarWrap.setAttribute('aria-valuemax', String(total));
    dom.oppBarWrap.setAttribute('aria-valuenow', String(oppCleared));
    dom.oppCaption.textContent = '对手 ' + oppCleared + '/' + total;

    dom.selfScoreItem.classList.toggle('is-leading', selfCleared > oppCleared);
    dom.oppScoreItem.classList.toggle('is-leading', oppCleared > selfCleared);

    refreshControls();

    if (model.mode === 'spectate') {
      dom.selfLabel.textContent = '黑方';
      dom.oppLabel.textContent = '白方';
      dom.selfScoreLabel.textContent = '黑方';
      dom.oppScoreLabel.textContent = '白方';
      dom.selfBoard.setAttribute('aria-label', '黑方棋盘');
      dom.oppBoard.setAttribute('aria-label', '白方棋盘');
      setPaneState(dom.selfState, state.players.black.connected);
      setPaneState(dom.oppState, state.players.white.connected);
    } else {
      dom.selfLabel.textContent = '我';
      dom.oppLabel.textContent = '对手';
      dom.selfScoreLabel.textContent = '你';
      dom.oppScoreLabel.textContent = '对手';
      dom.selfBoard.setAttribute('aria-label', '我的棋盘');
      dom.oppBoard.setAttribute('aria-label', '对方棋盘');
      setPaneState(dom.selfState, state.players[mine].connected);
      setPaneState(dom.oppState, state.players[theirs].connected);
    }

    var info = statusInfo(state);
    dom.status.textContent = info.text;
    dom.status.classList.toggle('is-muted', info.tone === 'muted');
    dom.status.classList.toggle('is-over', info.tone === 'over' || info.tone === 'win');
    dom.status.classList.toggle('is-win', info.tone === 'win');
  }

  function setPaneState(node, connected) {
    if (!node) return;
    node.textContent = connected ? '在线' : '离线';
    node.classList.toggle('is-online', !!connected);
  }

  function statusInfo(state) {
    var total = state.totalPairs;
    if (state.winner) {
      if (model.mode === 'spectate') {
        return {
          text: state.winner === 1 ? '观战：黑方获胜' : '观战：白方获胜',
          tone: 'over'
        };
      }
      var win = state.winner === model.color;
      return {
        text: win ? '你赢了！' : '对手先清空了',
        tone: win ? 'win' : 'over'
      };
    }
    if (model.mode === 'spectate') {
      var both = state.players.black.connected && state.players.white.connected;
      return {
        text: both ? '实时观战 · 双方竞速中' : '实时观战 · 等待玩家加入…',
        tone: both ? 'live' : 'muted'
      };
    }
    var mine = colorKey(model.color);
    var theirs = otherKey(mine);
    if (!state.players[theirs].connected) {
      return { text: '等待对手加入…', tone: 'muted' };
    }
    return { text: '同步竞速中 · 先清空 ' + total + ' 对者获胜', tone: 'live' };
  }

  function winnerToast(state) {
    if (model.mode === 'spectate') {
      return state.winner === 1 ? '黑方获胜' : '白方获胜';
    }
    return state.winner === model.color ? '你赢了！' : '对手先清空了';
  }

  function updateMode(state) {
    if (!dom) return;
    var mode = model.mode;
    if (dom.container.dataset.mode !== mode) dom.container.dataset.mode = mode;
    if (rootEl) {
      if (rootEl.dataset.mode !== mode) rootEl.dataset.mode = mode;
      rootEl.dataset.game = 'lianliankan';
    }
    var over = !!state.winner;
    dom.container.classList.toggle('is-over', over);
    dom.selfBoard.classList.toggle('is-locked', mode !== 'play' || over);
    dom.oppBoard.classList.add('is-locked');
    refreshControls();
  }

  /* 提示 / 重排按钮的统一可用状态 */
  function refreshControls() {
    if (!dom) return;
    var locked = model.mode !== 'play' || !model.state || !!model.state.winner;
    var hintDisabled = locked || model.hintBusy || model.busy;
    var shuffleDisabled = locked || model.shuffleBusy || model.busy;
    dom.hintBtn.disabled = hintDisabled;
    dom.hintBtn.setAttribute('aria-disabled', hintDisabled ? 'true' : 'false');
    dom.shuffleBtn.disabled = shuffleDisabled;
    dom.shuffleBtn.setAttribute('aria-disabled', shuffleDisabled ? 'true' : 'false');
  }

  function updateFlash(state) {
    var last = state.lastClear;
    if (!last) {
      model.lastClearSig = FLASH_CLEAR_SIG;
      return;
    }
    var sig = [last.color, last.x1, last.y1, last.x2, last.y2].join(':');
    if (sig === model.lastClearSig) return;
    model.lastClearSig = sig;

    if (model.mode === 'spectate') {
      flashCells(last.color === 1 ? 'self' : 'opp', last, state.size);
    } else if (last.color !== model.color) {
      bumpOppBar();
    }
  }

  function flashCells(kind, last, size) {
    var tiles = kind === 'self' ? dom.selfTiles : dom.oppTiles;
    if (!tiles) return;
    var indexes = [last.y1 * size + last.x1, last.y2 * size + last.x2];
    indexes.forEach(function (index) {
      var tile = tiles[index];
      if (!tile) return;
      if (tile._llkFlashTimer) clearTimeout(tile._llkFlashTimer);
      tile.classList.remove('is-flash');
      /* 强制回流以重启动画 */
      void tile.offsetWidth;
      tile.classList.add('is-flash');
      tile._llkFlashTimer = setTimeout(function () {
        tile._llkFlashTimer = null;
        tile.classList.remove('is-flash');
      }, FLASH_MS);
    });
  }

  function bumpOppBar() {
    if (!dom || !dom.oppBar) return;
    dom.oppBar.classList.remove('is-bump');
    void dom.oppBar.offsetWidth;
    dom.oppBar.classList.add('is-bump');
    clearTimer(dom, '_bumpTimer');
    dom._bumpTimer = setTimeout(function () {
      dom._bumpTimer = null;
      if (dom.oppBar) dom.oppBar.classList.remove('is-bump');
    }, 560);
  }

  /* ============================ 交互 ============================ */

  function onTileClick(event) {
    var tile = event && event.currentTarget;
    if (!tile || !dom) return;
    if (tile._llkKind !== 'self' || !model.state) return;

    if (model.mode !== 'play') {
      bridgeToast('观战中，无法操作棋盘', 'info');
      return;
    }
    if (model.busy) return;
    if (model.state.winner) {
      bridgeToast('对局已结束，等待重开', 'info');
      return;
    }

    var x = tile._llkX;
    var y = tile._llkY;
    var board = boardFor(model.state, 'self');
    var size = model.state.size;
    var type = board[y * size + x] | 0;
    if (!type) return;

    var selected = model.selected;
    if (!selected) {
      model.selected = { x: x, y: y };
      paintSelection();
      return;
    }
    if (selected.x === x && selected.y === y) {
      model.selected = null;
      paintSelection();
      return;
    }

    var selectedType = board[selected.y * size + selected.x] | 0;
    if (!selectedType) {
      model.selected = { x: x, y: y };
      paintSelection();
      return;
    }
    if (selectedType !== type) {
      bridgeToast('图案不同，请选两张相同的图案', 'info');
      model.selected = { x: x, y: y };
      paintSelection();
      return;
    }

    submitMatch(selected.x, selected.y, x, y);
  }

  function submitMatch(x1, y1, x2, y2) {
    var token = bridgeGet('getToken');
    if (!token) {
      model.selected = null;
      paintSelection();
      bridgeToast('登录状态已失效，请刷新页面重试', 'error');
      return;
    }

    var roomId = bridgeGet('getRoom') || (model.state ? model.state.room : '');
    model.pending = { x1: x1, y1: y1, x2: x2, y2: y2 };
    model.busy = true;
    paintSelection();
    refreshControls();
    clearPendingTimer();
    model.pendingTimer = setTimeout(function () {
      if (!model.pending) return;
      resolvePending();
      bridgeToast('操作超时，请重试', 'error');
    }, PENDING_MS);

    apiPost(API_MATCH, {
      roomId: roomId,
      token: token,
      x1: x1,
      y1: y1,
      x2: x2,
      y2: y2
    }).then(function () {
      /* 成功：以 SSE 推来的 state 为准，等 render 再落 UI */
    }, function (err) {
      if (!model.pending) return;
      resolvePending();
      var code = errorCode(err);
      if (code === 'game_over' || code === 'not_player') model.selected = null;
      paintSelection();
      bridgeToast(matchErrorText(err), 'error');
    });
  }

  function matchErrorText(err) {
    var code = errorCode(err);
    if (code === 'no_match' || code === 'invalid_move') {
      return '这两张连不上，换个位置试试';
    }
    if (code === 'not_player') return '你不是本局玩家，无法操作';
    if (code === 'game_over') return '对局已结束';
    if (err && err.name === 'AbortError') return '请求超时，请重试';
    return '操作失败，请稍后重试';
  }

  function onHintClick() {
    if (model.hintBusy || model.shuffleBusy || model.busy) return;
    if (!model.state || model.mode !== 'play') return;
    if (model.state.winner) {
      bridgeToast('对局已结束', 'info');
      return;
    }
    var token = bridgeGet('getToken');
    if (!token) {
      bridgeToast('登录状态已失效，请刷新页面重试', 'error');
      return;
    }
    var roomId = bridgeGet('getRoom') || model.state.room;
    model.hintBusy = true;
    refreshControls();

    apiPost(API_HINT, { roomId: roomId, token: token }).then(function (res) {
      if (!dom || !model.state) return;
      /*
       * 服务端可能在无解时先重排再返回坐标（并广播新 state）。
       * 因此这里不能在请求发出前缓存棋盘：拿到 response 后按当前 DOM/state 高亮，
       * paintHint() 会按坐标读取当前格子，state 先到也仍然有效。
       */
      var hint = normalizeHint(res, model.state.size);
      if (!hint) {
        bridgeToast('当前没有可消除的配对', 'info');
        return;
      }
      showHint(hint);
    }, function (err) {
      if (!dom || !model.state) return;
      var code = errorCode(err);
      if (code === 'no_hint') bridgeToast('当前没有可消除的配对，再找找看', 'info');
      else if (code === 'game_over') bridgeToast('对局已结束', 'error');
      else if (code === 'not_player') bridgeToast('你不是本局玩家，无法操作', 'error');
      else if (err && err.name === 'AbortError') bridgeToast('请求超时，请重试', 'error');
      else bridgeToast('提示获取失败，请稍后重试', 'error');
    }).then(function () {
      model.hintBusy = false;
      refreshControls();
    });
  }

  /* 重排：把该玩家剩余图案重新随机排布（服务端保证仍有可消对） */
  function onShuffleClick() {
    if (model.shuffleBusy || model.hintBusy || model.busy) return;
    if (!model.state || model.mode !== 'play') return;
    if (model.state.winner) {
      bridgeToast('对局已结束', 'info');
      return;
    }
    var token = bridgeGet('getToken');
    if (!token) {
      bridgeToast('登录状态已失效，请刷新页面重试', 'error');
      return;
    }
    var roomId = bridgeGet('getRoom') || model.state.room;

    /* 重排会让当前选中/提示失效，先就地清掉，避免指向旧图案 */
    model.selected = null;
    model.hint = null;
    clearHintTimer();
    paintSelection();
    paintHint();

    model.shuffleBusy = true;
    refreshControls();

    apiPost(API_SHUFFLE, { roomId: roomId, token: token }).then(function () {
      if (!dom || !model.state) return;
      bridgeToast('已重排剩余图案', 'info');
    }, function (err) {
      if (!dom || !model.state) return;
      var code = errorCode(err);
      if (code === 'not_player') bridgeToast('你不是本局玩家，无法操作', 'error');
      else if (code === 'game_over') bridgeToast('对局已结束', 'error');
      else if (code === 'no_hint') bridgeToast('没有可重排的图案', 'info');
      else if (err && err.name === 'AbortError') bridgeToast('请求超时，请重试', 'error');
      else bridgeToast('重排失败，请稍后重试', 'error');
    }).then(function () {
      model.shuffleBusy = false;
      refreshControls();
    });
  }

  function normalizeHint(res, size) {
    if (!res || typeof res !== 'object') return null;
    var x1 = Number(res.x1);
    var y1 = Number(res.y1);
    var x2 = Number(res.x2);
    var y2 = Number(res.y2);
    var values = [x1, y1, x2, y2];
    for (var i = 0; i < values.length; i++) {
      if (!isFinite(values[i]) || Math.floor(values[i]) !== values[i]) return null;
      if (values[i] < 0 || values[i] >= size) return null;
    }
    return { x1: x1, y1: y1, x2: x2, y2: y2 };
  }

  function showHint(hint) {
    model.hint = hint;
    clearHintTimer();
    paintHint();
    model.hintTimer = setTimeout(function () {
      model.hintTimer = null;
      model.hint = null;
      paintHint();
    }, HINT_MS);
  }

  /* ============================ 生命周期 ============================ */

  function init(nextBridge) {
    if (model.ensureTimer) {
      clearTimeout(model.ensureTimer);
      model.ensureTimer = null;
    }
    bridge = nextBridge || null;
    if (ensureUI()) return;

    /* #llk-root 可能比脚本稍晚出现（app.js 切视图后挂载），做有限重试 */
    var tries = 0;
    (function retry() {
      model.ensureTimer = null;
      if (!bridge) return;
      if (ensureUI()) return;
      tries += 1;
      if (tries > 60) return;
      model.ensureTimer = setTimeout(retry, 50);
    })();
  }

  function reset() {
    if (model.ensureTimer) {
      clearTimeout(model.ensureTimer);
      model.ensureTimer = null;
    }
    clearPendingTimer();
    clearHintTimer();

    if (dom) {
      if (dom._bumpTimer) {
        clearTimeout(dom._bumpTimer);
        dom._bumpTimer = null;
      }
      if (dom.container && dom.container.parentNode) {
        dom.container.parentNode.removeChild(dom.container);
      }
    }
    if (rootEl) {
      rootEl.removeAttribute('data-mode');
      rootEl.removeAttribute('data-game');
    }
    rootEl = null;
    dom = null;
    model = createModel();
  }

  function resolvePending() {
    model.pending = null;
    model.busy = false;
    clearPendingTimer();
    refreshControls();
  }

  function resetInteraction() {
    model.selected = null;
    resolvePending();
    model.hint = null;
    model.hintBusy = false;
    model.shuffleBusy = false;
    clearHintTimer();
  }

  /* ============================ 导出 ============================ */

  window.LLK = {
    init: init,
    render: render,
    reset: reset
  };
})();
