/* ==========================================================================
   大富翁（Monopoly）前端模块 —— web/monopoly.js
   --------------------------------------------------------------------------
   对外契约（由 app.js 调用，DOM 全部自建在 #monopoly-root 内）：
     window.MONOPOLY = {
       init(bridge),       // 只调用一次；bridge={getRoom,getToken,getColor,apiPost,toast}
       render(state,color),// 每次 SSE state 到达时调用；color: 1 黑 / 2 白 / 0 观战
       reset()             // 离开房间时调用
     };
   依赖：web/style.css 的 CSS 变量（--text/--glass/--border/...）；
         monopoly.css 内所有变量都带兜底值，单独加载也能正常显示。
   本文件不引入任何外域资源。
   ========================================================================== */
(function () {
  'use strict';

  /* ============================ 常量 ============================ */

  var TILE_COUNT = 24;          /* 24 格环形棋盘 */
  var BOARD_DIM = 7;            /* 7 x 7 CSS Grid */
  var GO_INDEX = 0;
  var JAIL_INDEX = 6;
  var FREE_INDEX = 12;
  var GOTOJAIL_INDEX = 18;

  var START_CASH = 1500;        /* 仅用于现金条兜底显示 */
  var JAIL_FINE = 50;
  var TAX_AMOUNT = 100;
  var MAX_LEVEL = 5;            /* 4 栋房屋 + 1 座旅馆 */

  var LOG_LIMIT = 6;            /* 中央日志显示条数（5-8） */
  var LOG_MAX = 10;             /* 服务端最多保留 10 条 */
  var DICE_MIN_MS = 480;        /* 骰子滚动最短时长 */
  var MOVE_STEP_MS = 80;        /* 棋子逐格移动每步时长 */

  var GROUP_COLORS = { A: '#b07a4a', B: '#5b9bd5', C: '#e07aa8', D: '#e0a03c' };
  var GROUP_NAMES = { A: '棕色组', B: '蓝色组', C: '粉色组', D: '橙色组' };
  var TYPE_LIST = ['go', 'jail', 'free', 'gotojail', 'property', 'chance', 'tax'];
  var PHASE_LIST = ['waiting', 'roll', 'buy', 'action', 'over'];
  var SPECIAL_ICONS = { go: 'GO', jail: '牢', free: 'P', gotojail: '捕', chance: '?', tax: '$' };
  var RENT_TABLE = [1, 2, 4, 7, 10, 15];

  /* 骰子点阵：9 宫格中亮起的格子索引 */
  var FACE_DOTS = {
    1: [4],
    2: [0, 8],
    3: [0, 4, 8],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 2, 3, 5, 6, 8]
  };

  var API = {
    roll: './api/roll',
    buy: './api/buy',
    jail: './api/jail',
    build: './api/build',
    mortgage: './api/mortgage',
    endturn: './api/endturn'
  };

  var ERROR_TEXT = {
    not_player: '你不是本局玩家',
    wrong_game: '房间的游戏类型不符',
    game_over: '对局已经结束',
    not_your_turn: '还没轮到你操作',
    invalid_phase: '当前阶段不能执行该操作',
    invalid_move: '该操作无效',
    cannot_afford: '现金不足',
    no_card: '没有出狱许可卡',
    has_houses: '有房屋的地产不能抵押',
    invalid_group: '需要集齐同组地产才能盖房',
    room_not_found: '房间不存在或已过期',
    bad_request: '请求格式有误',
    unauthorized: '身份校验失败',
    no_bridge: '网络接口不可用',
    net_error: '网络异常，请稍后重试'
  };

  /* 机会卡/关键事件的日志关键词：命中时额外 toast 一次 */
  var LOG_KEYWORDS = ['机会', '出狱许可', '彩票', '银行分红', '罚单', '维修', '破产', '获胜'];

  var mqReduce = null;
  if (typeof window !== 'undefined' && window.matchMedia) {
    try {
      mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    } catch (err) {
      mqReduce = null;
    }
  }

  /* ============================ 模块状态 ============================ */

  var bridge = null;
  var rootEl = null;
  var dom = null;
  var model = createModel();
  var keyHandlerBound = false;

  function createModel() {
    return {
      state: null,
      color: 0,
      mode: 'play',
      boardSig: '',
      logEntries: [],
      detailTile: null,
      busy: false,
      cooldownUntil: 0,
      busyTimer: null,
      ensureTimer: null,
      visualPos: { black: null, white: null },
      animTimers: { black: null, white: null },
      lastDice: null,
      shownDiceKey: null,
      spinning: false,
      spinBaseKey: '',
      spinPending: null,
      spinStarted: 0,
      spinMinMs: DICE_MIN_MS,
      diceInterval: null,
      diceStopTimer: null,
      logFlashTimer: null,
      scrollTimer: null
    };
  }

  /* 把面板滚动进视野（棋盘 70dvh 时详情/买地面板可能在首屏下方） */
  function scrollIntoViewSoft(node) {
    if (!node) return;
    var run = function () {
      model.scrollTimer = null;
      try {
        node.scrollIntoView({
          block: 'nearest',
          behavior: prefersReducedMotion() ? 'auto' : 'smooth'
        });
      } catch (err) {
        try {
          node.scrollIntoView(false);
        } catch (ignored) {
          /* 忽略：部分测试环境不支持 scrollIntoView 参数 */
        }
      }
    };
    if (model.scrollTimer && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(model.scrollTimer);
      model.scrollTimer = null;
    }
    if (typeof window.requestAnimationFrame === 'function') {
      model.scrollTimer = window.requestAnimationFrame(run);
    } else {
      setTimeout(run, 0);
    }
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

  function bridgeRawColor() {
    if (!bridge || typeof bridge.getColor !== 'function') return null;
    try {
      return bridge.getColor();
    } catch (err) {
      return null;
    }
  }

  function bridgeToast(message, kind) {
    if (!bridge || typeof bridge.toast !== 'function') return;
    try {
      bridge.toast(message, kind);
    } catch (err) {
      /* 忽略 toast 实现异常，避免阻断对局 */
    }
  }

  function makeError(code) {
    var error = new Error(code || 'mono_error');
    error.code = code || '';
    return error;
  }

  function apiPost(path, body) {
    return new Promise(function (resolve, reject) {
      if (!bridge || typeof bridge.apiPost !== 'function') {
        reject(makeError('no_bridge'));
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
        /* 兼容「不抛错、返回 error 字段」的 bridge 实现 */
        if (res && res.error) {
          reject(makeError(String(res.error)));
          return;
        }
        if (res && res.ok === false) {
          reject(makeError('failed'));
          return;
        }
        resolve(res || {});
      }, reject);
    });
  }

  function errorText(err) {
    var code = '';
    if (err) {
      if (err.code != null && err.code !== '') code = String(err.code);
      else if (err.error != null && err.error !== '') code = String(err.error);
      else if (err.status === 400 && err.message) code = String(err.message);
    }
    if (ERROR_TEXT[code]) return ERROR_TEXT[code];
    if (code) return '操作失败（' + code + '）';
    return '操作失败，请稍后重试';
  }

  function normalizeColor(value) {
    if (value === 0 || value === 1 || value === 2) return value;
    if (value === '0' || value === '1' || value === '2') return Number(value);
    return null;
  }

  function toInt(value, fallback) {
    var n = Number(value);
    if (!isFinite(n)) return fallback;
    return Math.round(n);
  }

  function clampInt(value, min, max, fallback) {
    var n = toInt(value, fallback);
    if (n < min) n = min;
    if (n > max) n = max;
    return n;
  }

  function setText(node, text) {
    if (!node) return;
    var value = text == null ? '' : String(text);
    if (node.textContent !== value) node.textContent = value;
  }

  function money(value) {
    var n = Math.round(Number(value) || 0);
    return '$' + n;
  }

  function prefersReducedMotion() {
    return !!(mqReduce && mqReduce.matches);
  }

  function colorKey(color) {
    return color === 2 ? 'white' : 'black';
  }

  function colorNumber(key) {
    return key === 'white' ? 2 : 1;
  }

  function otherColor(color) {
    return color === 1 ? 2 : 1;
  }

  function diceKey(dice) {
    return Array.isArray(dice) && dice.length === 2 ? dice[0] + '+' + dice[1] : '';
  }

  /* ============================ 状态归一化 ============================ */

  function normalizeBoard(raw) {
    if (!Array.isArray(raw) || raw.length < TILE_COUNT) return null;
    var out = [];
    for (var i = 0; i < TILE_COUNT; i++) {
      var source = raw[i] && typeof raw[i] === 'object' ? raw[i] : {};
      var type = String(source.type || '');
      if (TYPE_LIST.indexOf(type) < 0) type = 'unknown';
      out.push({
        type: type,
        name: typeof source.name === 'string' ? source.name : '',
        price: toInt(source.price, 0),
        group: typeof source.group === 'string' ? source.group : '',
        color: typeof source.color === 'string' ? source.color : '',
        rents: Array.isArray(source.rents) ? source.rents : null,
        houseCost: source.houseCost == null ? null : toInt(source.houseCost, 0),
        mortgage: source.mortgage == null ? null : toInt(source.mortgage, 0),
        unmortgage: source.unmortgage == null ? null : toInt(source.unmortgage, 0)
      });
    }
    return out;
  }

  function normalizeIntArray(raw, fallback, isValid) {
    var out = new Array(TILE_COUNT);
    var source = Array.isArray(raw) ? raw : [];
    for (var i = 0; i < TILE_COUNT; i++) {
      var value = source[i];
      out[i] = isValid ? isValid(value) : toInt(value, fallback);
    }
    return out;
  }

  function normalizeDice(raw) {
    if (!Array.isArray(raw) || raw.length < 2) return null;
    var d1 = toInt(raw[0], 0);
    var d2 = toInt(raw[1], 0);
    if (d1 < 1 || d1 > 6 || d2 < 1 || d2 > 6) return null;
    return [d1, d2];
  }

  function normalizePending(raw, board) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.type !== 'buy') return null;
    var tile = clampInt(raw.tile, 0, TILE_COUNT - 1, -1);
    if (tile < 0) return null;
    var price = toInt(raw.price, 0);
    if (!price && board && board[tile]) price = board[tile].price;
    return { type: 'buy', tile: tile, price: price };
  }

  function normalizeState(raw) {
    var phase = typeof raw.phase === 'string' ? raw.phase : '';
    var winner = toInt(raw.winner, 0);
    if (winner !== 1 && winner !== 2) winner = 0;
    if (PHASE_LIST.indexOf(phase) < 0) phase = winner ? 'over' : 'roll';
    if (winner && phase !== 'over') phase = 'over';

    var turn = toInt(raw.turn, 1);
    if (turn !== 1 && turn !== 2) turn = 1;

    var board = normalizeBoard(raw.board);
    var cashRaw = raw.cash && typeof raw.cash === 'object' ? raw.cash : {};
    var posRaw = raw.pos && typeof raw.pos === 'object' ? raw.pos : {};
    var jailRaw = raw.jail && typeof raw.jail === 'object' ? raw.jail : {};
    var turnsRaw = raw.jailTurns && typeof raw.jailTurns === 'object' ? raw.jailTurns : {};
    var cardsRaw = raw.jailCards && typeof raw.jailCards === 'object' ? raw.jailCards : {};

    var owners = normalizeIntArray(raw.owners, 0, function (value) {
      var n = toInt(value, 0);
      return n === 1 || n === 2 ? n : 0;
    });
    var houses = normalizeIntArray(raw.houses, 0, function (value) {
      return clampInt(value, 0, MAX_LEVEL, 0);
    });
    var mortgaged = normalizeIntArray(raw.mortgaged, false, function (value) {
      return !!value;
    });

    var log = [];
    if (Array.isArray(raw.log)) {
      for (var i = 0; i < raw.log.length; i++) {
        if (typeof raw.log[i] === 'string') log.push(raw.log[i]);
      }
    }
    log = log.slice(-LOG_MAX);

    return {
      room: raw.room ? String(raw.room) : '',
      game: raw.game ? String(raw.game) : 'monopoly',
      winner: winner,
      turn: turn,
      phase: phase,
      dice: normalizeDice(raw.dice),
      doubles: clampInt(raw.doubles, 0, 3, 0),
      pending: phase === 'buy' ? normalizePending(raw.pending, board) : normalizePending(raw.pending, board),
      cash: {
        black: toInt(cashRaw.black, START_CASH),
        white: toInt(cashRaw.white, START_CASH)
      },
      pos: {
        black: clampInt(posRaw.black, 0, TILE_COUNT - 1, 0),
        white: clampInt(posRaw.white, 0, TILE_COUNT - 1, 0)
      },
      jail: {
        black: !!jailRaw.black,
        white: !!jailRaw.white
      },
      jailTurns: {
        black: clampInt(turnsRaw.black, 0, 3, 0),
        white: clampInt(turnsRaw.white, 0, 3, 0)
      },
      jailCards: {
        black: Math.max(0, toInt(cardsRaw.black, 0)),
        white: Math.max(0, toInt(cardsRaw.white, 0))
      },
      owners: owners,
      houses: houses,
      mortgaged: mortgaged,
      board: board,
      canEndTurn: !!raw.canEndTurn,
      log: log
    };
  }

  /* ============================ 价格 / 租金计算 ============================ */
  /* 与服务端 mono_house_cost / mono_mortgage_value / mono_unmortgage_cost /
     mono_rent 完全一致；若服务端未来在 board 里下发这些字段则优先使用。 */

  function houseCostFor(tile) {
    if (!tile) return 0;
    if (typeof tile.houseCost === 'number' && tile.houseCost > 0) return tile.houseCost;
    var price = Number(tile.price) || 0;
    return Math.max(50, Math.floor(price / 2 / 10) * 10);
  }

  function mortgageValueFor(tile) {
    if (!tile) return 0;
    if (typeof tile.mortgage === 'number' && tile.mortgage > 0) return tile.mortgage;
    return Math.floor((Number(tile.price) || 0) / 2);
  }

  function unmortgageCostFor(tile) {
    if (!tile) return 0;
    if (typeof tile.unmortgage === 'number' && tile.unmortgage > 0) return tile.unmortgage;
    var price = Number(tile.price) || 0;
    return Math.floor((price * 55 + 99) / 100);
  }

  function rentFor(tile, level) {
    if (!tile) return 0;
    var lv = clampInt(level, 0, MAX_LEVEL, 0);
    if (Array.isArray(tile.rents) && tile.rents.length > lv) {
      var custom = Number(tile.rents[lv]);
      if (isFinite(custom)) return Math.round(custom);
    }
    var base = Math.max(10, Math.floor((Number(tile.price) || 0) / 10));
    return base * RENT_TABLE[lv];
  }

  function groupIndices(state, group) {
    var out = [];
    if (!state || !state.board) return out;
    for (var i = 0; i < TILE_COUNT; i++) {
      var tile = state.board[i];
      if (tile && tile.type === 'property' && tile.group === group) out.push(i);
    }
    return out;
  }

  function groupFullyOwned(state, group, color) {
    var indices = groupIndices(state, group);
    if (!indices.length) return false;
    for (var i = 0; i < indices.length; i++) {
      if (state.owners[indices[i]] !== color) return false;
    }
    return true;
  }

  function tileColor(tile) {
    if (!tile) return '';
    if (tile.color) return tile.color;
    if (tile.group && GROUP_COLORS[tile.group]) return GROUP_COLORS[tile.group];
    return '';
  }

  /* ============================ 棋盘定位 ============================ */

  function tileRow(index) {
    if (index <= 6) return BOARD_DIM;                 /* 底边：0 → 6 */
    if (index <= 12) return BOARD_DIM - (index - 6);  /* 右边：7 → 12 */
    if (index <= 18) return 1;                        /* 顶边：13 → 18 */
    return index - 18 + 1;                            /* 左边：19 → 23 */
  }

  function tileCol(index) {
    if (index <= 6) return index + 1;                 /* 底边 */
    if (index <= 12) return BOARD_DIM;                /* 右边 */
    if (index <= 18) return BOARD_DIM - (index - 12); /* 顶边：13 → 18 */
    return 1;                                         /* 左边 */
  }

  function isCorner(index) {
    return index === GO_INDEX || index === JAIL_INDEX ||
      index === FREE_INDEX || index === GOTOJAIL_INDEX;
  }

  /* ============================ 构建 DOM ============================ */

  function ensureUI() {
    var root = document.getElementById('monopoly-root');
    if (!root) return false;
    if (dom && dom.container && dom.container.parentNode === root) {
      rootEl = root;
      return true;
    }
    buildUI(root);
    return true;
  }

  function buildUI(root) {
    clearUiTimers();
    if (dom && dom.container && dom.container.parentNode) {
      dom.container.parentNode.removeChild(dom.container);
    }
    root.textContent = '';
    rootEl = root;

    var container = el('div', { class: 'mono', 'data-mode': 'play', 'data-phase': 'roll' });

    /* ---------- 棋盘 ---------- */
    var board = el('div', { class: 'mono-board', role: 'grid', 'aria-label': '大富翁棋盘' });
    var center = buildCenter();
    var tiles = [];
    for (var i = 0; i < TILE_COUNT; i++) {
      var tile = buildTile(i);
      tiles.push(tile);
      board.appendChild(tile);
    }
    board.appendChild(center);
    var stage = el('div', { class: 'mono-stage' }, [board]);

    /* ---------- 买地面板 ---------- */
    var buyTag = el('span', { class: 'mono-buy-tag', text: '可购买' });
    var buyName = el('strong', { id: 'mono-buy-name', class: 'mono-buy-name', text: '—' });
    var buyPrice = el('span', { id: 'mono-buy-price', class: 'mono-buy-price', text: '' });
    var buyNote = el('p', { id: 'mono-buy-note', class: 'mono-buy-note', text: '' });
    var buyBtn = el('button', { id: 'mono-buy', class: 'mono-btn mono-btn--primary', type: 'button', text: '购买' });
    var passBtn = el('button', { id: 'mono-pass', class: 'mono-btn', type: 'button', text: '放弃' });
    var buyPanel = el('div', {
      id: 'mono-buy-panel',
      class: 'mono-buy',
      hidden: '',
      role: 'group',
      'aria-label': '购买地产'
    }, [
      el('div', { class: 'mono-buy-main' }, [buyTag, buyName, buyPrice]),
      buyNote,
      el('div', { class: 'mono-buy-actions' }, [buyBtn, passBtn])
    ]);

    /* ---------- 操作区 ---------- */
    var rollBtn = el('button', { id: 'mono-roll', class: 'mono-btn mono-btn--primary', type: 'button', text: '掷骰子' });
    var jailPayBtn = el('button', { id: 'mono-jail-pay', class: 'mono-btn', type: 'button', hidden: '', text: '缴纳保释 $50' });
    var jailCardBtn = el('button', { id: 'mono-jail-card', class: 'mono-btn', type: 'button', hidden: '', text: '使用出狱卡' });
    var endTurnBtn = el('button', { id: 'mono-end-turn', class: 'mono-btn', type: 'button', hidden: '', text: '结束回合' });
    var hint = el('p', { id: 'mono-hint', class: 'mono-hint', hidden: '', role: 'status' });
    var actions = el('div', { id: 'mono-actions', class: 'mono-actions' }, [
      rollBtn, jailPayBtn, jailCardBtn, endTurnBtn, hint
    ]);

    /* ---------- 地产详情面板 ---------- */
    var detailName = el('strong', { id: 'mono-detail-name', class: 'mono-detail-name', text: '—' });
    var detailGroup = el('span', { id: 'mono-detail-group', class: 'mono-detail-group', text: '' });
    var detailClose = el('button', {
      id: 'mono-detail-close',
      class: 'mono-detail-close',
      type: 'button',
      'aria-label': '关闭地产详情',
      text: '×'
    });
    var detailMeta = el('p', { id: 'mono-detail-meta', class: 'mono-detail-meta', text: '' });
    var detailRent = el('p', { id: 'mono-detail-rent', class: 'mono-detail-rent', text: '' });
    var buildBtn = el('button', { id: 'mono-build', class: 'mono-btn mono-btn--primary', type: 'button', text: '盖房' });
    var mortgageBtn = el('button', { id: 'mono-mortgage', class: 'mono-btn', type: 'button', text: '抵押' });
    var unmortgageBtn = el('button', { id: 'mono-unmortgage', class: 'mono-btn', type: 'button', text: '赎回' });
    var detailHint = el('p', { id: 'mono-detail-hint', class: 'mono-detail-hint', text: '' });
    var detailPanel = el('div', {
      id: 'mono-detail-panel',
      class: 'mono-detail',
      hidden: '',
      role: 'group',
      'aria-label': '地产详情'
    }, [
      el('div', { class: 'mono-detail-head' }, [
        el('div', { class: 'mono-detail-title' }, [detailName, detailGroup]),
        detailClose
      ]),
      detailMeta,
      detailRent,
      el('div', { class: 'mono-detail-actions' }, [buildBtn, mortgageBtn, unmortgageBtn]),
      detailHint
    ]);

    container.appendChild(stage);
    container.appendChild(buyPanel);
    container.appendChild(actions);
    container.appendChild(detailPanel);
    root.appendChild(container);

    /* ---------- 棋子 ---------- */
    var tokenBlack = el('span', { class: 'mono-token mono-token--black', 'aria-hidden': 'true' });
    var tokenWhite = el('span', { class: 'mono-token mono-token--white', 'aria-hidden': 'true' });
    tokenBlack.hidden = true;
    tokenWhite.hidden = true;

    dom = {
      container: container,
      stage: stage,
      board: board,
      center: center,
      tiles: tiles,
      turnMain: center._monoTurnMain,
      turnSub: center._monoTurnSub,
      diceEl: center._monoDice,
      diceEls: center._monoDiceEls,
      diceSum: center._monoDiceSum,
      cash: {
        black: center._monoCashBlack,
        white: center._monoCashWhite
      },
      logBox: center._monoLog,
      buyPanel: buyPanel,
      buyName: buyName,
      buyPrice: buyPrice,
      buyNote: buyNote,
      buyBtn: buyBtn,
      passBtn: passBtn,
      actions: actions,
      rollBtn: rollBtn,
      jailPayBtn: jailPayBtn,
      jailCardBtn: jailCardBtn,
      endTurnBtn: endTurnBtn,
      hint: hint,
      detailPanel: detailPanel,
      detailName: detailName,
      detailGroup: detailGroup,
      detailMeta: detailMeta,
      detailRent: detailRent,
      detailHint: detailHint,
      detailClose: detailClose,
      buildBtn: buildBtn,
      mortgageBtn: mortgageBtn,
      unmortgageBtn: unmortgageBtn,
      tokenBlack: tokenBlack,
      tokenWhite: tokenWhite
    };

    /* ---------- 事件 ---------- */
    for (var t = 0; t < tiles.length; t++) {
      tiles[t].addEventListener('click', onTileClick);
    }
    rollBtn.addEventListener('click', onRollClick);
    jailPayBtn.addEventListener('click', function () { submit(API.jail, { action: 'pay' }); });
    jailCardBtn.addEventListener('click', function () { submit(API.jail, { action: 'card' }); });
    endTurnBtn.addEventListener('click', function () { submit(API.endturn, {}); });
    buyBtn.addEventListener('click', function () { submit(API.buy, { action: 'buy' }); });
    passBtn.addEventListener('click', function () { submit(API.buy, { action: 'pass' }); });
    buildBtn.addEventListener('click', onBuildClick);
    mortgageBtn.addEventListener('click', function () { submitDetail(API.mortgage, 'mortgage'); });
    unmortgageBtn.addEventListener('click', function () { submitDetail(API.mortgage, 'unmortgage'); });
    detailClose.addEventListener('click', closeDetail);
    bindGlobalKeys();

    /* ---------- 重置派生状态 ---------- */
    model.boardSig = '';
    model.visualPos = { black: null, white: null };
    model.logEntries = [];
    model.detailTile = null;
    model.shownDiceKey = null;
    model.lastDice = null;
    setDiceIdle();
  }

  function buildTile(index) {
    var tile = el('button', {
      type: 'button',
      class: 'mono-tile',
      'data-index': index
    });
    tile.style.gridRow = String(tileRow(index));
    tile.style.gridColumn = String(tileCol(index));

    var groupBar = el('span', { class: 'mono-tile-group', 'aria-hidden': 'true' });
    var icon = el('span', { class: 'mono-tile-icon', 'aria-hidden': 'true' });
    var name = el('span', { class: 'mono-tile-name' });
    var price = el('span', { class: 'mono-tile-price' });
    var houses = el('span', { class: 'mono-tile-houses', 'aria-hidden': 'true' });
    var owner = el('span', { class: 'mono-tile-owner', 'aria-hidden': 'true' });
    var mortgage = el('span', { class: 'mono-tile-mortgage', text: '押', 'aria-hidden': 'true' });
    var badges = el('span', { class: 'mono-tile-badges' }, [houses, owner, mortgage]);
    var tokens = el('span', { class: 'mono-tile-tokens' });

    tile.appendChild(groupBar);
    tile.appendChild(icon);
    tile.appendChild(name);
    tile.appendChild(price);
    tile.appendChild(badges);
    tile.appendChild(tokens);

    tile._monoTokens = tokens;
    tile._monoRefs = {
      groupBar: groupBar,
      icon: icon,
      name: name,
      price: price,
      houses: houses,
      owner: owner,
      mortgage: mortgage
    };
    tile._monoFlashTimer = null;
    return tile;
  }

  function buildCash(key) {
    var root = el('div', { id: 'mono-cash-' + key, class: 'mono-cash mono-cash--' + key });
    var dot = el('i', { class: 'mono-dot mono-dot--' + key, 'aria-hidden': 'true' });
    var name = el('span', { class: 'mono-cash-name', text: key === 'black' ? '黑方' : '白方' });
    var head = el('div', { class: 'mono-cash-head' }, [dot, name]);
    var amount = el('div', { class: 'mono-cash-amount', text: '$0' });
    var jail = el('span', { class: 'mono-cash-jail', text: '狱中' });
    var card = el('span', { class: 'mono-cash-card', text: '' });
    var win = el('span', { class: 'mono-cash-win', text: '胜' });
    jail.hidden = true;
    card.hidden = true;
    win.hidden = true;
    var meta = el('div', { class: 'mono-cash-meta' }, [jail, card, win]);
    root.appendChild(head);
    root.appendChild(amount);
    root.appendChild(meta);
    return {
      root: root,
      name: name,
      amount: amount,
      jail: jail,
      card: card,
      win: win
    };
  }

  function buildCenter() {
    var turnMain = el('p', {
      id: 'mono-turn-text',
      class: 'mono-turn-main',
      role: 'status',
      'aria-live': 'polite',
      text: '正在同步对局…'
    });
    var turnSub = el('p', { id: 'mono-turn-sub', class: 'mono-turn-sub', text: '' });

    var dice = el('div', { id: 'mono-dice', class: 'mono-dice is-idle', 'aria-label': '骰子' });
    var diceEls = [];
    for (var d = 0; d < 2; d++) {
      var die = el('div', { class: 'mono-die', 'data-face': '0' });
      var dots = [];
      for (var k = 0; k < 9; k++) {
        var dot = el('i', { class: 'mono-die-dot' });
        die.appendChild(dot);
        dots.push(dot);
      }
      dice.appendChild(die);
      diceEls.push({ el: die, dots: dots });
    }
    var diceSum = el('p', { id: 'mono-dice-sum', class: 'mono-dice-sum', text: '' });
    var diceWrap = el('div', { class: 'mono-dice-wrap' }, [dice, diceSum]);

    var cashBlack = buildCash('black');
    var cashWhite = buildCash('white');
    var cashRow = el('div', { class: 'mono-cash-row' }, [cashBlack.root, cashWhite.root]);

    var logBox = el('ol', {
      id: 'mono-log',
      class: 'mono-log',
      role: 'log',
      'aria-live': 'polite',
      'aria-relevant': 'additions'
    });
    var logWrap = el('div', { class: 'mono-log-wrap' }, [
      el('p', { class: 'mono-log-title', text: '对局动态' }),
      logBox
    ]);

    var center = el('div', { class: 'mono-center' }, [
      turnMain, turnSub, diceWrap, cashRow, logWrap
    ]);
    center._monoTurnMain = turnMain;
    center._monoTurnSub = turnSub;
    center._monoDice = dice;
    center._monoDiceEls = diceEls;
    center._monoDiceSum = diceSum;
    center._monoCashBlack = cashBlack;
    center._monoCashWhite = cashWhite;
    center._monoLog = logBox;
    return center;
  }

  function bindGlobalKeys() {
    if (keyHandlerBound) return;
    keyHandlerBound = true;
    document.addEventListener('keydown', function (ev) {
      if ((ev.key === 'Escape' || ev.key === 'Esc') && model.detailTile != null) {
        closeDetail();
      }
    });
  }

  /* ============================ 渲染入口 ============================ */

  function render(rawState, rawColor) {
    if (!rawState || typeof rawState !== 'object') return;
    if (rawState.game && rawState.game !== 'monopoly') return;
    if (!ensureUI()) return;

    var color = normalizeColor(rawColor);
    if (color == null) color = normalizeColor(bridgeRawColor());
    if (color == null) color = 0;

    var prev = model.state;
    var state = normalizeState(rawState);
    model.state = state;
    model.color = color;
    model.mode = color === 0 ? 'spectate' : 'play';

    /* 棋盘结构变化时重建格子（名字/价格/类型变化） */
    var sig = boardSignature(state);
    if (sig !== model.boardSig) {
      rebuildTiles();
      model.boardSig = sig;
    }

    renderBoard(state);
    syncTokens(state);
    renderCenter(state, prev);
    renderCash(state);
    renderDice(state);
    renderLog(state, prev);
    renderActions(state);
    renderBuyPanel(state);
    renderDetailPanel(state);
    updateContainer(state);
    refreshBusyClass();
  }

  function boardSignature(state) {
    if (!state.board) return 'none';
    var parts = [];
    for (var i = 0; i < state.board.length; i++) {
      var tile = state.board[i];
      parts.push(tile.type + '|' + tile.name + '|' + tile.price + '|' + tile.group);
    }
    return parts.join(';');
  }

  function rebuildTiles() {
    if (!dom || !dom.board) return;
    for (var i = 0; i < dom.tiles.length; i++) {
      var old = dom.tiles[i];
      if (old._monoFlashTimer) {
        clearTimeout(old._monoFlashTimer);
        old._monoFlashTimer = null;
      }
      if (old.parentNode === dom.board) dom.board.removeChild(old);
    }
    var next = [];
    for (var j = 0; j < TILE_COUNT; j++) {
      var tile = buildTile(j);
      tile.addEventListener('click', onTileClick);
      dom.board.insertBefore(tile, dom.center || null);
      next.push(tile);
    }
    dom.tiles = next;
    model.visualPos = { black: null, white: null };
  }

  /* ============================ 棋盘渲染 ============================ */

  function renderBoard(state) {
    if (!dom || !dom.tiles) return;
    var myColor = model.color;
    var currentKey = state.turn === 1 ? 'black' : 'white';

    for (var i = 0; i < TILE_COUNT; i++) {
      var tileEl = dom.tiles[i];
      if (!tileEl) continue;
      var tile = state.board ? state.board[i] : null;
      var type = tile ? tile.type : 'unknown';
      var owner = state.owners[i];
      var houses = state.houses[i];
      var mortgaged = !!state.mortgaged[i];
      var isMine = myColor !== 0 && owner === myColor;

      /* 静态类 */
      tileEl.className = 'mono-tile mono-tile--' + type +
        (isCorner(i) ? ' is-corner' : '') +
        (tile && tile.name && tile.name.length >= 4 ? ' is-long-name' : '');

      /* 动态类 */
      if (owner) tileEl.classList.add('is-owned-' + (owner === 1 ? 'black' : 'white'));
      if (mortgaged) tileEl.classList.add('is-mortgaged');
      if (isMine) tileEl.classList.add('is-mine');
      if (myColor !== 0 && state.pos[currentKey] === i) tileEl.classList.add('is-current');
      if (model.detailTile === i) tileEl.classList.add('is-selected');
      if (tile && tile.type === 'property' && owner === 0 && !mortgaged) {
        tileEl.classList.add('is-open');
      }

      var refs = tileEl._monoRefs;
      var color = tileColor(tile);
      if (color) {
        refs.groupBar.style.background = color;
        refs.groupBar.hidden = false;
      } else {
        refs.groupBar.style.background = '';
        refs.groupBar.hidden = true;
      }

      /* 名称 / 图标 */
      if (type === 'property') {
        refs.icon.hidden = true;
        refs.icon.textContent = '';
        setText(refs.name, tile && tile.name ? tile.name : '地产');
      } else {
        refs.icon.hidden = false;
        setText(refs.icon, SPECIAL_ICONS[type] || '?');
        setText(refs.name, tile && tile.name ? tile.name : '');
      }

      /* 价格：地产显示售价；税显示固定税额；其余留空 */
      var priceText = '';
      if (type === 'property' && tile) priceText = money(tile.price);
      else if (type === 'tax') priceText = money(TAX_AMOUNT);
      setText(refs.price, priceText);
      refs.price.hidden = !priceText;

      /* 房屋 / 旅馆 */
      refs.houses.textContent = '';
      if (type === 'property' && houses > 0) {
        if (houses >= MAX_LEVEL) {
          refs.houses.appendChild(el('i', { class: 'mono-house is-hotel' }));
        } else {
          for (var h = 0; h < houses; h++) {
            refs.houses.appendChild(el('i', { class: 'mono-house' }));
          }
        }
      }

      /* 归属点 */
      refs.owner.hidden = !owner;
      refs.owner.className = 'mono-tile-owner' + (owner === 1 ? ' is-black' : owner === 2 ? ' is-white' : '');

      /* 抵押标记 */
      refs.mortgage.hidden = !mortgaged;

      /* 可点击（自己的地产才能打开详情） */
      tileEl.disabled = !isMine;
      tileEl.classList.toggle('is-selectable', isMine);
      tileEl.setAttribute('aria-pressed', model.detailTile === i ? 'true' : 'false');
      tileEl.setAttribute('aria-label', tileAriaLabel(tile, i, state, type, owner, houses, mortgaged));

      /* 棋子所在格说明 */
      var occupants = [];
      if (state.pos.black === i) occupants.push('黑方棋子');
      if (state.pos.white === i) occupants.push('白方棋子');
      if (occupants.length) {
        tileEl.setAttribute('aria-label', tileAriaLabel(tile, i, state, type, owner, houses, mortgaged) + '，' + occupants.join('、'));
      }
    }
  }

  function tileAriaLabel(tile, index, state, type, owner, houses, mortgaged) {
    var label = (tile && tile.name) || '第 ' + (index + 1) + ' 格';
    if (type === 'property') {
      label += '，价格 ' + money(tile ? tile.price : 0);
      if (owner) label += '，' + (owner === 1 ? '黑方' : '白方') + '所有';
      else label += '，无人拥有';
      if (houses > 0) label += '，' + (houses >= MAX_LEVEL ? '已建旅馆' : houses + ' 栋房屋');
      if (mortgaged) label += '，已抵押';
    } else if (type === 'tax') {
      label += '，缴税 ' + money(TAX_AMOUNT);
    }
    return label;
  }

  /* ============================ 棋子渲染 / 移动动画 ============================ */

  function placeToken(key, index) {
    if (!dom || !dom.tiles) return;
    var tile = dom.tiles[index];
    if (!tile || !tile._monoTokens) return;
    var token = key === 'black' ? dom.tokenBlack : dom.tokenWhite;
    if (!token) return;
    if (token.parentNode !== tile._monoTokens) {
      tile._monoTokens.appendChild(token);
      if (!prefersReducedMotion()) {
        token.classList.remove('is-hopping');
        /* 强制重排，确保逐格移动时动画能重新触发 */
        void token.offsetWidth;
        token.classList.add('is-hopping');
        if (token._monoHopTimer) clearTimeout(token._monoHopTimer);
        token._monoHopTimer = setTimeout(function () {
          token.classList.remove('is-hopping');
          token._monoHopTimer = null;
        }, 160);
      }
    }
  }

  function stopTokenAnim(key) {
    if (model.animTimers[key]) {
      clearTimeout(model.animTimers[key]);
      model.animTimers[key] = null;
    }
  }

  function animateTokenMove(key, from, to) {
    var steps = (to - from + TILE_COUNT) % TILE_COUNT;
    if (!steps) {
      model.visualPos[key] = to;
      placeToken(key, to);
      return;
    }
    stopTokenAnim(key);
    var stepMs = steps > 8 ? Math.max(45, Math.round(720 / steps)) : MOVE_STEP_MS;
    var done = 0;
    function tick() {
      done += 1;
      var index = (from + done) % TILE_COUNT;
      model.visualPos[key] = index;
      placeToken(key, index);
      if (index === GO_INDEX) flashTile(GO_INDEX);
      if (done < steps) {
        model.animTimers[key] = setTimeout(tick, stepMs);
      } else {
        model.animTimers[key] = null;
      }
    }
    model.animTimers[key] = setTimeout(tick, stepMs);
  }

  function syncTokens(state) {
    if (!dom) return;
    var keys = ['black', 'white'];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var token = key === 'black' ? dom.tokenBlack : dom.tokenWhite;
      if (!token) continue;
      token.classList.toggle('is-mine', model.color === colorNumber(key));
      var target = state.pos ? state.pos[key] : null;
      if (target == null) {
        token.hidden = true;
        model.visualPos[key] = null;
        stopTokenAnim(key);
        continue;
      }
      token.hidden = false;
      var from = model.visualPos[key];
      if (from == null) {
        model.visualPos[key] = target;
        placeToken(key, target);
      } else if (from === target) {
        placeToken(key, target);
      } else if (prefersReducedMotion()) {
        stopTokenAnim(key);
        model.visualPos[key] = target;
        placeToken(key, target);
      } else {
        animateTokenMove(key, from, target);
      }
    }
  }

  function flashTile(index) {
    if (!dom || !dom.tiles) return;
    var tile = dom.tiles[index];
    if (!tile) return;
    tile.classList.remove('is-flash');
    void tile.offsetWidth;
    tile.classList.add('is-flash');
    if (tile._monoFlashTimer) clearTimeout(tile._monoFlashTimer);
    tile._monoFlashTimer = setTimeout(function () {
      tile.classList.remove('is-flash');
      tile._monoFlashTimer = null;
    }, 800);
  }

  /* ============================ 中央信息 ============================ */

  function renderCenter(state, prev) {
    if (!dom) return;
    setText(dom.turnMain, turnText(state));

    var parts = [];
    if (state.phase === 'waiting') {
      parts.push('等待第二位玩家加入');
    } else if (state.phase === 'over') {
      parts.push('本局结束');
    } else {
      parts.push(state.turn === 1 ? '黑方行动' : '白方行动');
      if (state.doubles > 0) parts.push('双数 ×' + state.doubles);
    }
    if (state.dice) {
      parts.push('点数 ' + state.dice[0] + ' + ' + state.dice[1] + ' = ' + (state.dice[0] + state.dice[1]));
    }
    if (model.color !== 0 && state.jail[colorKey(model.color)] && state.phase !== 'over') {
      parts.push('狱中第 ' + (state.jailTurns[colorKey(model.color)] + 1) + ' 次尝试');
    }
    setText(dom.turnSub, parts.join(' · '));
  }

  function turnText(state) {
    var me = model.color;
    if (state.phase === 'waiting') return '等待对手加入…';
    if (state.phase === 'over' || state.winner) {
      var winner = state.winner || 0;
      if (!winner) return '对局结束';
      if (me === 0) return '对局结束 · ' + (winner === 1 ? '黑方' : '白方') + '获胜';
      return winner === me ? '你赢了！' : '你输了…';
    }
    if (me === 0) {
      return '观战中 · ' + (state.turn === 1 ? '黑方' : '白方') + '回合';
    }
    var myTurn = state.turn === me;
    if (state.phase === 'roll') {
      if (!myTurn) return '等待对手掷骰子…';
      return state.jail[colorKey(me)] ? '你在监狱中' : '轮到你掷骰子';
    }
    if (state.phase === 'buy') {
      return myTurn ? '选择是否购买地产' : '对手正在决定是否购买…';
    }
    if (state.phase === 'action') {
      return myTurn ? '可以盖房或抵押地产' : '等待对手操作…';
    }
    return myTurn ? '你的回合' : '等待对手…';
  }

  function renderCash(state) {
    if (!dom || !dom.cash) return;
    var keys = ['black', 'white'];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var refs = dom.cash[key];
      if (!refs) continue;
      var number = colorNumber(key);
      var mine = model.color === number;
      var cash = state.cash[key];
      var jail = !!state.jail[key];
      var cards = state.jailCards[key] || 0;

      setText(refs.name, model.color === 0
        ? (key === 'black' ? '黑方' : '白方')
        : (mine ? '你 · ' : '对手 · ') + (key === 'black' ? '黑' : '白'));
      setText(refs.amount, money(cash));
      refs.jail.hidden = !jail;
      setText(refs.card, cards > 0 ? '出狱卡 ×' + cards : '');
      refs.card.hidden = cards <= 0;
      refs.win.hidden = !(state.winner === number);
      refs.root.classList.toggle('is-mine', mine);
      refs.root.classList.toggle('is-turn', state.turn === number && state.phase !== 'over' && state.phase !== 'waiting');
      refs.root.setAttribute('aria-label', (key === 'black' ? '黑方' : '白方') + '现金 ' + money(cash) +
        (jail ? '，在监狱中' : '') + (cards > 0 ? '，持有出狱卡 ' + cards + ' 张' : ''));
    }
  }

  /* ============================ 骰子 ============================ */

  function setDieFace(entry, face) {
    if (!entry) return;
    var pattern = FACE_DOTS[face] || [];
    for (var i = 0; i < entry.dots.length; i++) {
      entry.dots[i].classList.toggle('is-on', pattern.indexOf(i) >= 0);
    }
    entry.el.setAttribute('data-face', String(face || 0));
  }

  function setDiceValues(dice) {
    if (!dom || !dom.diceEl) return;
    if (!dice) {
      setDiceIdle();
      return;
    }
    dom.diceEl.classList.remove('is-idle');
    setDieFace(dom.diceEls[0], dice[0]);
    setDieFace(dom.diceEls[1], dice[1]);
    var total = dice[0] + dice[1];
    setText(dom.diceSum, dice[0] + ' + ' + dice[1] + ' = ' + total);
    dom.diceEl.setAttribute('aria-label', '骰子：' + dice[0] + ' 和 ' + dice[1] + '，合计 ' + total);
  }

  function setDiceIdle() {
    if (!dom || !dom.diceEl) return;
    setDieFace(dom.diceEls[0], 0);
    setDieFace(dom.diceEls[1], 0);
    dom.diceEl.classList.add('is-idle');
    dom.diceEl.classList.remove('is-rolling');
    setText(dom.diceSum, '');
    dom.diceEl.setAttribute('aria-label', '骰子：尚未掷出');
  }

  function randomFace() {
    return 1 + Math.floor(Math.random() * 6);
  }

  function stopDiceTimers() {
    if (model.diceInterval) {
      clearInterval(model.diceInterval);
      model.diceInterval = null;
    }
    if (model.diceStopTimer) {
      clearTimeout(model.diceStopTimer);
      model.diceStopTimer = null;
    }
    if (dom && dom.diceEl) dom.diceEl.classList.remove('is-rolling');
  }

  function spinDice(targetDice, minMs) {
    if (!dom || !dom.diceEl) return;
    if (prefersReducedMotion()) {
      if (targetDice) {
        setDiceValues(targetDice);
        model.shownDiceKey = diceKey(targetDice);
      }
      return;
    }
    stopDiceTimers();
    model.spinning = true;
    model.spinBaseKey = model.shownDiceKey == null ? '' : model.shownDiceKey;
    model.spinPending = targetDice || null;
    model.spinStarted = Date.now();
    model.spinMinMs = minMs || DICE_MIN_MS;
    dom.diceEl.classList.remove('is-idle');
    dom.diceEl.classList.add('is-rolling');
    model.diceInterval = setInterval(function () {
      setDieFace(dom.diceEls[0], randomFace());
      setDieFace(dom.diceEls[1], randomFace());
    }, 70);
    model.diceStopTimer = setTimeout(function () {
      model.diceStopTimer = null;
      finishDiceSpin(model.spinPending);
    }, model.spinMinMs);
  }

  function finishDiceSpin(dice) {
    stopDiceTimers();
    model.spinning = false;
    model.spinPending = null;
    var finalDice = dice || model.lastDice;
    if (finalDice) {
      setDiceValues(finalDice);
      model.shownDiceKey = diceKey(finalDice);
    } else {
      setDiceIdle();
      model.shownDiceKey = '';
    }
  }

  function renderDice(state) {
    if (!dom || !dom.diceEl) return;
    var dice = state.dice;
    if (dice) model.lastDice = dice;
    var key = diceKey(dice);

    if (model.spinning) {
      if (dice) model.spinPending = dice;
      return;
    }

    if (!dice) {
      if (model.shownDiceKey !== '') {
        setDiceIdle();
        model.shownDiceKey = '';
      }
      return;
    }

    if (model.shownDiceKey == null) {
      setDiceValues(dice);
      model.shownDiceKey = key;
      return;
    }

    if (key !== model.shownDiceKey) {
      if (prefersReducedMotion()) {
        setDiceValues(dice);
        model.shownDiceKey = key;
      } else {
        spinDice(dice, DICE_MIN_MS);
      }
      return;
    }
  }

  /* ============================ 日志 ============================ */

  function renderLog(state, prev) {
    if (!dom || !dom.logBox) return;
    var entries = state.log.slice(-LOG_MAX);
    var prevEntries = model.logEntries || [];
    var newEntries = [];

    if (prev && prevEntries.length) {
      var prevLast = prevEntries[prevEntries.length - 1];
      var pos = -1;
      for (var i = entries.length - 1; i >= 0; i--) {
        if (entries[i] === prevLast) {
          pos = i;
          break;
        }
      }
      if (pos >= 0) newEntries = entries.slice(pos + 1);
      else if (entries.length) newEntries = [entries[entries.length - 1]];
    }
    model.logEntries = entries;

    var shown = entries.slice(-LOG_LIMIT);
    var newCount = Math.min(newEntries.length, shown.length);
    dom.logBox.textContent = '';

    if (!shown.length) {
      dom.logBox.appendChild(el('li', { class: 'mono-log-item is-empty', text: '等待对局开始…' }));
    } else {
      for (var j = 0; j < shown.length; j++) {
        var isNew = j >= shown.length - newCount;
        dom.logBox.appendChild(el('li', {
          class: 'mono-log-item' + (isNew ? ' is-new' : ''),
          text: shown[j]
        }));
      }
      dom.logBox.scrollTop = dom.logBox.scrollHeight;
    }

    if (model.logFlashTimer) clearTimeout(model.logFlashTimer);
    if (newCount > 0) {
      model.logFlashTimer = setTimeout(function () {
        model.logFlashTimer = null;
        if (!dom || !dom.logBox) return;
        var fresh = dom.logBox.querySelectorAll('.is-new');
        for (var k = 0; k < fresh.length; k++) fresh[k].classList.remove('is-new');
      }, 1200);
      maybeToastLog(newEntries);
    }
  }

  function maybeToastLog(newEntries) {
    if (!newEntries || !newEntries.length) return;
    for (var i = newEntries.length - 1; i >= 0; i--) {
      var text = newEntries[i];
      for (var k = 0; k < LOG_KEYWORDS.length; k++) {
        if (text.indexOf(LOG_KEYWORDS[k]) >= 0) {
          bridgeToast(text, 'info');
          return;
        }
      }
    }
  }

  /* ============================ 操作区 ============================ */

  function isBusy() {
    if (model.busy) return true;
    return model.cooldownUntil > 0 && Date.now() < model.cooldownUntil;
  }

  function refreshBusyClass() {
    if (!dom || !dom.container) return;
    dom.container.classList.toggle('is-busy', isBusy());
    dom.container.setAttribute('aria-busy', isBusy() ? 'true' : 'false');
  }

  function refreshControls() {
    if (!dom || !model.state) return;
    renderActions(model.state);
    renderBuyPanel(model.state);
    renderDetailPanel(model.state);
    refreshBusyClass();
  }

  function scheduleRefresh(delay) {
    if (model.busyTimer) clearTimeout(model.busyTimer);
    model.busyTimer = setTimeout(function () {
      model.busyTimer = null;
      refreshControls();
    }, delay || 360);
  }

  function computeControls(state) {
    var color = model.color;
    var meKey = colorKey(color);
    var over = state.winner !== 0 || state.phase === 'over';
    var myTurn = color !== 0 && state.turn === color;
    var busy = isBusy();
    var cash = state.cash[meKey] || 0;
    var controls = {
      myTurn: myTurn,
      over: over,
      meKey: meKey,
      roll: { show: false, disabled: true, text: '掷骰子', reason: '' },
      jailPay: { show: false, disabled: true, text: '缴纳保释 $50', reason: '' },
      jailCard: { show: false, disabled: true, text: '使用出狱卡', reason: '' },
      endTurn: { show: false, disabled: true, text: '结束回合', reason: '' }
    };

    controls.roll.show = myTurn && !over && state.phase === 'roll';
    if (controls.roll.show) {
      controls.roll.text = state.jail[meKey] ? '掷骰子（双数出狱）' : '掷骰子';
      controls.roll.disabled = busy;
      controls.roll.reason = busy ? '操作处理中…' : '';
    }

    if (controls.roll.show && state.jail[meKey]) {
      controls.jailPay.show = true;
      controls.jailPay.disabled = busy || cash < JAIL_FINE;
      controls.jailPay.reason = cash < JAIL_FINE ? '现金不足 $' + JAIL_FINE : busy ? '操作处理中…' : '';

      controls.jailCard.show = (state.jailCards[meKey] || 0) > 0;
      controls.jailCard.disabled = busy;
      controls.jailCard.reason = busy ? '操作处理中…' : '';
      controls.jailCard.text = '使用出狱卡（' + (state.jailCards[meKey] || 0) + '）';
    }

    controls.endTurn.show = myTurn && !over && state.canEndTurn;
    if (controls.endTurn.show) {
      controls.endTurn.disabled = busy;
      controls.endTurn.reason = busy ? '操作处理中…' : '';
    }

    return controls;
  }

  function renderActions(state) {
    if (!dom) return;
    var controls = computeControls(state);

    applyButton(dom.rollBtn, controls.roll);
    applyButton(dom.jailPayBtn, controls.jailPay);
    applyButton(dom.jailCardBtn, controls.jailCard);
    applyButton(dom.endTurnBtn, controls.endTurn);

    var hint = '';
    if (state.phase === 'waiting') {
      hint = '等待对手加入房间后即可开始。';
    } else if (controls.over) {
      hint = state.winner ? (state.winner === 1 ? '黑方' : '白方') + '获胜，可在下方发起「再来一局」。' : '对局已结束。';
    } else if (model.color === 0) {
      hint = '观战模式：你可以查看双方现金、位置与地产，但不能操作。';
    } else if (!controls.myTurn) {
      hint = '等待对手操作…';
    } else if (state.phase === 'roll') {
      hint = state.jail[controls.meKey]
        ? '你在监狱：可缴纳 $50 保释、使用出狱卡，或掷骰子尝试双数出狱。'
        : '点击「掷骰子」开始行动。';
    } else if (state.phase === 'buy') {
      hint = '请决定是否购买该地产。';
    } else if (state.phase === 'action') {
      hint = state.canEndTurn ? '可以点击自己的地产盖房/抵押，完成后结束回合。' : '请继续操作。';
    }

    applyHint(hint);
  }

  function applyButton(button, conf) {
    if (!button) return;
    button.hidden = !conf.show;
    button.disabled = !!conf.disabled;
    setText(button, conf.text);
    if (conf.reason && conf.show) button.title = conf.reason;
    else button.removeAttribute('title');
    button.setAttribute('aria-disabled', conf.disabled ? 'true' : 'false');
  }

  function applyHint(text) {
    if (!dom || !dom.hint) return;
    setText(dom.hint, text);
    dom.hint.hidden = !text;
  }

  /* ============================ 买地面板 ============================ */

  function renderBuyPanel(state) {
    if (!dom || !dom.buyPanel) return;
    var pending = state.pending;
    if (!pending || pending.type !== 'buy' || state.phase !== 'buy') {
      dom.buyPanel.hidden = true;
      return;
    }

    var index = clampInt(pending.tile, 0, TILE_COUNT - 1, 0);
    var tile = state.board ? state.board[index] : null;
    var price = pending.price || (tile ? tile.price : 0);
    var color = model.color;
    var meKey = colorKey(color);
    var myTurn = color !== 0 && state.turn === color;
    var cash = state.cash[meKey] || 0;
    var busy = isBusy();

    if (dom.buyPanel.hidden) {
      dom.buyPanel.hidden = false;
      scrollIntoViewSoft(dom.buyPanel);
    }
    setText(dom.buyName, (tile && tile.name) || '未知地产');
    setText(dom.buyPrice, money(price));

    dom.buyBtn.hidden = !myTurn;
    dom.passBtn.hidden = !myTurn;

    if (myTurn) {
      var afford = cash >= price;
      dom.buyBtn.disabled = busy || !afford;
      dom.passBtn.disabled = busy;
      setText(dom.buyBtn, '购买 ' + money(price));
      setText(dom.passBtn, '放弃');
      if (!afford) dom.buyBtn.title = '现金不足（需 ' + money(price) + '）';
      else if (busy) dom.buyBtn.title = '操作处理中…';
      else dom.buyBtn.removeAttribute('title');
      dom.passBtn.title = busy ? '操作处理中…' : '';
      if (!afford) dom.passBtn.removeAttribute('title');
      setText(dom.buyNote, '现金 ' + money(cash) + ' · 购买后剩余 ' + money(cash - price));
    } else {
      dom.buyNote.textContent = (model.color === 0 ? '观战：' : '') +
        (state.turn === 1 ? '黑方' : '白方') + '正在决定是否购买…';
    }
  }

  /* ============================ 地产详情 ============================ */

  function computeDetail(state) {
    var index = model.detailTile;
    if (index == null || !state.board) return null;
    var tile = state.board[index];
    if (!tile || tile.type !== 'property') return null;
    var owner = state.owners[index];
    if (!owner || model.color === 0 || owner !== model.color) return null;

    var level = state.houses[index] || 0;
    var mortgaged = !!state.mortgaged[index];
    var meKey = colorKey(model.color);
    var cash = state.cash[meKey] || 0;
    var myTurn = state.turn === model.color;
    var over = state.winner !== 0 || state.phase === 'over';
    var canOperate = myTurn && !over && (state.phase === 'action' || state.phase === 'roll');

    var group = tile.group;
    var indices = groupIndices(state, group);
    var fullGroup = groupFullyOwned(state, group, model.color);
    var minLevel = MAX_LEVEL;
    for (var i = 0; i < indices.length; i++) {
      var lv = state.houses[indices[i]] || 0;
      if (lv < minLevel) minLevel = lv;
    }

    var buildCost = houseCostFor(tile);
    var mortgageValue = mortgageValueFor(tile);
    var unmortgageCost = unmortgageCostFor(tile);
    var rentNow = rentFor(tile, level);
    if (level === 0 && fullGroup) rentNow *= 2;
    var rentNext = level < MAX_LEVEL ? rentFor(tile, level + 1) : 0;

    var buildReason = '';
    if (over) buildReason = '对局已结束';
    else if (!myTurn) buildReason = '还没轮到你操作';
    else if (state.phase === 'waiting') buildReason = '等待对手加入';
    else if (state.phase === 'buy') buildReason = '请先决定是否购买地产';
    else if (!canOperate) buildReason = '当前阶段不能操作';
    else if (mortgaged) buildReason = '抵押中的地产不能盖房';
    else if (!fullGroup) buildReason = '需要集齐同组 4 块地产才能盖房';
    else if (level >= MAX_LEVEL) buildReason = '已建成旅馆';
    else if (level > minLevel) buildReason = '需均匀建造：本组还有房屋更少的地产';
    else if (cash < buildCost) buildReason = '现金不足（需 ' + money(buildCost) + '）';

    var mortgageReason = '';
    if (over) mortgageReason = '对局已结束';
    else if (!myTurn) mortgageReason = '还没轮到你操作';
    else if (state.phase === 'waiting') mortgageReason = '等待对手加入';
    else if (state.phase === 'buy') mortgageReason = '请先决定是否购买地产';
    else if (!canOperate) mortgageReason = '当前阶段不能操作';
    else if (mortgaged) mortgageReason = '已抵押';
    else if (level > 0) mortgageReason = '有房屋时不能抵押';

    var unmortgageReason = '';
    if (over) unmortgageReason = '对局已结束';
    else if (!myTurn) unmortgageReason = '还没轮到你操作';
    else if (state.phase === 'waiting') unmortgageReason = '等待对手加入';
    else if (state.phase === 'buy') unmortgageReason = '请先决定是否购买地产';
    else if (!canOperate) unmortgageReason = '当前阶段不能操作';
    else if (!mortgaged) unmortgageReason = '未抵押';
    else if (cash < unmortgageCost) unmortgageReason = '现金不足（需 ' + money(unmortgageCost) + '）';

    return {
      index: index,
      tile: tile,
      level: level,
      mortgaged: mortgaged,
      fullGroup: fullGroup,
      cash: cash,
      buildCost: buildCost,
      mortgageValue: mortgageValue,
      unmortgageCost: unmortgageCost,
      rentNow: rentNow,
      rentNext: rentNext,
      buildable: !buildReason,
      buildReason: buildReason,
      mortgageable: !mortgageReason,
      mortgageReason: mortgageReason,
      unmortgageable: !unmortgageReason,
      unmortgageReason: unmortgageReason
    };
  }

  function renderDetailPanel(state) {
    if (!dom || !dom.detailPanel) return;
    var detail = computeDetail(state);
    if (!detail) {
      dom.detailPanel.hidden = true;
      if (model.detailTile != null && state && state.board) {
        var tile = state.board[model.detailTile];
        var stillMine = tile && tile.type === 'property' &&
          state.owners[model.detailTile] === model.color && model.color !== 0;
        if (!stillMine) model.detailTile = null;
      }
      return;
    }

    dom.detailPanel.hidden = false;
    setText(dom.detailName, detail.tile.name || '地产');
    var groupName = GROUP_NAMES[detail.tile.group] || detail.tile.group || '';
    setText(dom.detailGroup, groupName);
    dom.detailGroup.style.background = tileColor(detail.tile) || 'transparent';
    dom.detailGroup.hidden = !groupName;

    var levelText = detail.level >= MAX_LEVEL ? '旅馆' : detail.level + ' 栋房屋';
    setText(dom.detailMeta,
      '价格 ' + money(detail.tile.price) +
      ' · 房屋 ' + detail.level + '/' + MAX_LEVEL + '（' + levelText + '）' +
      (detail.mortgaged ? ' · 已抵押' : ''));

    var rentText = '当前租金 ' + money(detail.rentNow);
    if (detail.level === 0 && detail.fullGroup) rentText += '（整组无房 ×2）';
    if (detail.level < MAX_LEVEL) rentText += ' · 盖房后 ' + money(detail.rentNext);
    setText(dom.detailRent, rentText);

    var busy = isBusy();
    var buildLabel = detail.level >= MAX_LEVEL ? '已建旅馆' : '盖房 ' + money(detail.buildCost);
    applyDetailButton(dom.buildBtn, true, busy || !detail.buildable, buildLabel, detail.buildReason);
    applyDetailButton(dom.mortgageBtn, !detail.mortgaged, busy || !detail.mortgageable,
      '抵押 +' + money(detail.mortgageValue), detail.mortgageReason);
    applyDetailButton(dom.unmortgageBtn, detail.mortgaged, busy || !detail.unmortgageable,
      '赎回 -' + money(detail.unmortgageCost), detail.unmortgageReason);

    var reasons = [];
    if (!detail.buildable && detail.buildReason) reasons.push(detail.buildReason);
    if (!detail.mortgaged && !detail.mortgageable && detail.mortgageReason) reasons.push(detail.mortgageReason);
    if (detail.mortgaged && !detail.unmortgageable && detail.unmortgageReason) reasons.push(detail.unmortgageReason);
    var unique = [];
    for (var i = 0; i < reasons.length; i++) {
      if (unique.indexOf(reasons[i]) < 0) unique.push(reasons[i]);
    }
    setText(dom.detailHint, unique.length ? '不可操作：' + unique.join('；') : '可执行上方操作。');
  }

  function applyDetailButton(button, show, disabled, label, reason) {
    if (!button) return;
    button.hidden = !show;
    button.disabled = !!disabled;
    setText(button, label);
    if (disabled && reason) button.title = reason;
    else button.removeAttribute('title');
    button.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  }

  function openDetail(index) {
    model.detailTile = index;
    if (model.state) renderDetailPanel(model.state);
    scrollIntoViewSoft(dom && dom.detailPanel);
  }

  function closeDetail() {
    model.detailTile = null;
    if (dom && dom.detailPanel) dom.detailPanel.hidden = true;
    if (model.state) renderBoard(model.state);
  }

  function onTileClick(ev) {
    var tileEl = ev.currentTarget;
    if (!tileEl || !model.state) return;
    var index = Number(tileEl.getAttribute('data-index'));
    if (!isFinite(index) || index < 0 || index >= TILE_COUNT) return;
    if (model.color === 0 || model.state.owners[index] !== model.color) return;
    if (model.detailTile === index) closeDetail();
    else openDetail(index);
  }

  /* ============================ 提交动作 ============================ */

  function submit(path, payload, onError) {
    if (isBusy()) return;
    var room = bridgeGet('getRoom');
    var token = bridgeGet('getToken');
    if (!room || !token) {
      bridgeToast('尚未进入房间，请稍候…', 'error');
      if (onError) onError();
      return;
    }
    var body = { roomId: room, token: token };
    if (payload) {
      Object.keys(payload).forEach(function (key) {
        body[key] = payload[key];
      });
    }

    model.busy = true;
    model.cooldownUntil = 0;
    refreshControls();

    apiPost(path, body).then(function () {
      model.busy = false;
      model.cooldownUntil = Date.now() + 320;
      scheduleRefresh(360);
    }, function (err) {
      model.busy = false;
      model.cooldownUntil = 0;
      bridgeToast(errorText(err), 'error');
      refreshControls();
      if (onError) onError();
    });
  }

  function submitDetail(path, action) {
    if (model.detailTile == null) return;
    var index = model.detailTile;
    submit(path, { tile: index, action: action });
  }

  function onBuildClick() {
    if (model.detailTile == null) return;
    submit(API.build, { tile: model.detailTile });
  }

  function onRollClick() {
    if (isBusy()) return;
    if (!prefersReducedMotion()) {
      spinDice(null, 620);
    }
    submit(API.roll, {}, function () {
      finishDiceSpin(model.lastDice);
    });
  }

  function updateContainer(state) {
    if (!dom || !dom.container) return;
    var over = state.winner !== 0 || state.phase === 'over';
    dom.container.classList.toggle('is-spectate', model.color === 0);
    dom.container.classList.toggle('is-over', over);
    dom.container.classList.toggle('is-waiting', state.phase === 'waiting');
    dom.container.setAttribute('data-phase', state.phase);
    dom.container.setAttribute('data-mode', model.color === 0 ? 'spectate' : 'play');
  }

  /* ============================ 定时器清理 ============================ */

  function clearUiTimers() {
    var keys = ['black', 'white'];
    for (var i = 0; i < keys.length; i++) {
      if (model.animTimers[keys[i]]) {
        clearTimeout(model.animTimers[keys[i]]);
        model.animTimers[keys[i]] = null;
      }
    }
    if (model.diceInterval) {
      clearInterval(model.diceInterval);
      model.diceInterval = null;
    }
    if (model.diceStopTimer) {
      clearTimeout(model.diceStopTimer);
      model.diceStopTimer = null;
    }
    if (model.logFlashTimer) {
      clearTimeout(model.logFlashTimer);
      model.logFlashTimer = null;
    }
    if (model.busyTimer) {
      clearTimeout(model.busyTimer);
      model.busyTimer = null;
    }
    if (model.scrollTimer && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(model.scrollTimer);
      model.scrollTimer = null;
    }
    model.spinning = false;
    model.spinPending = null;
  }

  /* ============================ 生命周期 ============================ */

  function init(nextBridge) {
    bridge = nextBridge || null;
    if (model.ensureTimer) {
      clearTimeout(model.ensureTimer);
      model.ensureTimer = null;
    }
    if (ensureUI()) return;

    /* #monopoly-root 可能比脚本稍晚出现（app.js 切视图后挂载），做有限重试 */
    var tries = 0;
    (function retry() {
      model.ensureTimer = null;
      if (ensureUI()) return;
      tries += 1;
      if (tries > 80) return;
      model.ensureTimer = setTimeout(retry, 50);
    })();
  }

  function reset() {
    if (model.ensureTimer) {
      clearTimeout(model.ensureTimer);
      model.ensureTimer = null;
    }
    clearUiTimers();
    if (dom && dom.container && dom.container.parentNode) {
      dom.container.parentNode.removeChild(dom.container);
    }
    if (rootEl) {
      rootEl.removeAttribute('data-mode');
      rootEl.removeAttribute('data-phase');
    }
    rootEl = null;
    dom = null;
    model = createModel();
  }

  /* ============================ 导出 ============================ */

  window.MONOPOLY = {
    init: init,
    render: render,
    reset: reset
  };
})();
