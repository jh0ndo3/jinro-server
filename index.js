// 人狼 中継サーバー(Cloudflare Workers + Durable Objects)
// ・1つのルーム(4文字のルームID)ごとに、Durable Object「Room」が1つ動く。
// ・ルームの状態と、全員の役職・夜の行動・投票先は、このサーバーだけが持つ(正本)。
//   各プレイヤーには「公開情報+その人だけの秘密」だけを送る。観戦はない。
// ・クライアントは「誰を選んだか」だけを送る。サーバーがルールで検査してから反映し、全員に配る。
// ・プレイヤーの端末どうしは直接つながらないので、相手にIPアドレスは見えない。
// ・本人の見分けには、各端末が作るランダムな合言葉(tok)を使う。tok はほかの人に絶対に送らない。
import { DurableObject } from "cloudflare:workers";

/* =========================================================
   1. ルール
   index.html のゲーム本体(rec / validate / checkWin / canAttack / canDivine /
   computeNightRes / commitNight / resolveNight / finishVote / newTimer など)と同じ内容。
   ルールを変える時は、index.html と このファイルの両方を同じように直すこと。
   ========================================================= */
const ROLE_KEYS = ['wolf', 'madman', 'seer', 'knight', 'medium', 'villager'];   // index.html の UI_ORDER と同じ
const MIN_P = 4, MAX_P = 20;
// 人数ごとのおすすめ配分(村人=残り)。index.html の REC と同じ
const REC = {
  4: {wolf: 1, seer: 1, villager: 2},
  5: {wolf: 1, seer: 1, knight: 1, villager: 2},
  6: {wolf: 1, madman: 1, seer: 1, knight: 1, villager: 2},
  7: {wolf: 2, seer: 1, knight: 1, villager: 3},
  8: {wolf: 2, seer: 1, knight: 1, medium: 1, villager: 3},
  9: {wolf: 2, madman: 1, seer: 1, knight: 1, medium: 1, villager: 3},
  10: {wolf: 2, madman: 1, seer: 1, knight: 1, medium: 1, villager: 4},
  11: {wolf: 2, madman: 1, seer: 1, knight: 1, medium: 1, villager: 5},
  12: {wolf: 3, madman: 1, seer: 1, knight: 1, medium: 1, villager: 5},
  13: {wolf: 3, madman: 1, seer: 1, knight: 1, medium: 1, villager: 6},
  14: {wolf: 3, madman: 1, seer: 1, knight: 1, medium: 1, villager: 7},
  15: {wolf: 3, madman: 1, seer: 1, knight: 1, medium: 1, villager: 8},
  16: {wolf: 4, madman: 1, seer: 1, knight: 1, medium: 1, villager: 8},
  17: {wolf: 4, madman: 1, seer: 1, knight: 1, medium: 1, villager: 9},
  18: {wolf: 4, madman: 1, seer: 1, knight: 1, medium: 1, villager: 10},
  19: {wolf: 4, madman: 1, seer: 1, knight: 1, medium: 1, villager: 11},
  20: {wolf: 5, madman: 1, seer: 1, knight: 1, medium: 1, villager: 11},
};
const rec = n => Object.assign({wolf: 0, madman: 0, seer: 0, knight: 0, medium: 0, villager: 0}, REC[Math.min(MAX_P, Math.max(MIN_P, n))]);
const sumC = c => ROLE_KEYS.reduce((a, k) => a + c[k], 0);
// 開始できない理由(空文字なら開始できる)。index.html の validate と同じ条件
function cfgError(n, c) {
  if (n < MIN_P || n > MAX_P) return 'count';
  if (sumC(c) !== n) return 'sum';
  if (c.wolf < 1) return 'nowolf';
  if (c.wolf >= n - c.wolf) return 'manywolf';
  return '';
}
const canAttack = g => !(g.day === 1 && !g.settings.firstAttack);
const canDivine = g => g.day > 1 || g.settings.firstSeer === 'free';
// 勝利判定:人狼全滅→村人陣営/人狼の数がそれ以外(狂人を含む)以上→人狼陣営
function checkWin(g) {
  const alive = g.players.filter(p => p.alive);
  const w = alive.filter(p => p.role === 'wolf').length;
  if (w === 0) return 'village';
  if (w >= alive.length - w) return 'wolf';
  return null;
}
const aliveIdx = g => g.players.map((p, i) => i).filter(i => g.players[i].alive);
const rint = n => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };
const pick = a => a[rint(a.length)];
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = rint(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// 役職を配ってゲームを始める
function newGame(names, settings, counts) {
  const roles = [];
  ROLE_KEYS.forEach(k => { for (let i = 0; i < counts[k]; i++) roles.push(k); });
  shuffle(roles);
  const players = names.map((n, i) => ({name: n, role: roles[i], alive: true}));
  const g = {players, settings: {...settings}, counts: {...counts}, day: 1, phase: 'reveal', seq: 1, done: {},
    na: {wolfVotes: {}, guards: {}}, acts: {}, lastGuard: {}, seerHist: {}, medHist: {}, seerHint: {},
    execToday: null, morningVictim: null, votes: {}, runoff: null, voteRes: null, timer: null, want: {}, winner: null, ev: []};
  // 初日お告げ:人狼ではない人を占い師ごとにランダムで決めておく
  if (g.settings.firstSeer === 'random') {
    players.forEach((p, i) => {
      if (p.role !== 'seer') return;
      const cand = players.map((q, j) => j).filter(j => j !== i && players[j].role !== 'wolf');
      if (cand.length) g.seerHint[i] = pick(cand);
    });
  }
  return g;
}
// フェーズを切り替える(seq が変わるので、古い画面からの操作は無視される)
function setPhase(g, ph) { g.phase = ph; g.seq++; g.done = {}; }

// 夜に選べる相手か(index.html の vNight の選択肢と同じ条件)
function nightChoiceOk(g, pi, t) {
  if (!Number.isInteger(t) || t < 0 || t >= g.players.length || t === pi || !g.players[t].alive) return false;
  const role = g.players[pi].role;
  if (role === 'wolf' && g.players[t].role === 'wolf') return false;                                     // 仲間は選べない
  if (role === 'knight' && !g.settings.consecGuard && g.lastGuard[pi] === t) return false;               // 連続護衛の禁止
  return true;
}
// 夜の「決定」の結果(index.html の computeNightRes と同じ)
function nightRes(g, pi, t) {
  const p = g.players[pi];
  switch (p.role) {
    case 'seer':
      if (canDivine(g)) return {kind: 'divine', t, wolf: g.players[t].role === 'wolf'};
      if (g.settings.firstSeer === 'random' && g.seerHint[pi] != null) return {kind: 'hint', t: g.seerHint[pi], wolf: false};
      return {kind: 'seerNone'};
    case 'medium':
      return g.execToday == null ? {kind: 'medNone'} : {kind: 'med', t: g.execToday, wolf: g.players[g.execToday].role === 'wolf'};
    case 'wolf': return canAttack(g) ? {kind: 'attack'} : {kind: 'noAttack'};
    case 'knight': return {kind: 'guard'};
    default: return {kind: 'dummy'};
  }
}
// 夜の行動を確定する(index.html の commitNight と同じ。記録の文章はクライアントが ev から作る)
function commitNight(g, pi, t, r) {
  const p = g.players[pi];
  if (p.role === 'wolf' && r.kind === 'attack') g.na.wolfVotes[pi] = t;
  if (p.role === 'seer' && (r.kind === 'divine' || r.kind === 'hint')) (g.seerHist[pi] = g.seerHist[pi] || []).push({day: g.day, t: r.t, wolf: r.wolf});
  if (p.role === 'knight') { g.na.guards[pi] = t; g.lastGuard[pi] = t; }
  if (p.role === 'medium' && r.kind === 'med') (g.medHist[pi] = g.medHist[pi] || []).push({day: g.day, t: r.t, wolf: r.wolf});
  g.acts[pi] = {t, r};
}
// 全員の夜の行動が終わったら襲撃を解決して朝へ(index.html の resolveNight と同じ)
function resolveNight(g) {
  let victim = null, target = null, guarded = false;
  const att = canAttack(g);
  if (att) {
    const tally = {};
    Object.values(g.na.wolfVotes).forEach(t => { tally[t] = (tally[t] || 0) + 1; });
    const vals = Object.values(tally);
    if (vals.length) {
      const max = Math.max(...vals);
      target = pick(Object.keys(tally).filter(k => tally[k] === max).map(Number));   // 同数はランダム
      if (Object.values(g.na.guards).includes(target)) guarded = true;
      else { victim = target; g.players[target].alive = false; }
    }
  }
  g.ev.push({k: 'night', day: g.day, att, acts: g.acts, target, guarded, victim});
  // 最後に操作した人は結果を見る前に朝になるので、その夜の自分の結果を朝以降も本人に送る
  g.lastActs = g.acts; g.lastNight = g.day;
  g.acts = {}; g.na = {wolfVotes: {}, guards: {}};
  g.morningVictim = victim; g.day++; g.execToday = null; setPhase(g, 'morning'); g.winner = checkWin(g);
}
const voteCands = (g, pi) => (g.runoff || aliveIdx(g)).filter(j => j !== pi && g.players[j].alive);
// 全員の投票が集まったら集計(同数なら決選投票、決選でも同数なら処刑なし。index.html の finishVote と同じ)
function finishVote(g) {
  const tally = {};
  Object.values(g.votes).forEach(t => { tally[t] = (tally[t] || 0) + 1; });
  const vals = Object.values(tally), max = vals.length ? Math.max(...vals) : 0;
  const tops = Object.keys(tally).filter(k => tally[k] === max).map(Number);
  const res = {tally, tops, votes: {...g.votes}, runoff: !!g.runoff || !tops.length, exec: null};
  if (tops.length === 1) { res.exec = tops[0]; g.players[tops[0]].alive = false; g.execToday = tops[0]; g.winner = checkWin(g); }
  g.ev.push({k: 'vote', day: g.day, runoff: !!g.runoff, votes: {...g.votes}, exec: res.exec});
  g.voteRes = res; g.votes = {}; setPhase(g, 'voteResult');
}
// この場面で操作が必要な人(役職確認・夜・投票)
function required(g) {
  if (g.phase === 'vote') return aliveIdx(g).filter(i => voteCands(g, i).length > 0);
  return aliveIdx(g);
}
// 必要な人が全員操作したら次へ進める
function progress(g) {
  if (!['reveal', 'night', 'vote'].includes(g.phase)) return;
  if (!required(g).every(i => g.done[i])) return;
  if (g.phase === 'reveal') setPhase(g, 'nightIntro');
  else if (g.phase === 'night') resolveNight(g);
  else finishVote(g);
}

/* ---------- 議論タイマー(サーバーの時計で持つ。index.html の newTimer / pause / plus と同じ動き) ---------- */
function newTimer(sec, now) {
  return sec === 0 ? {free: true, running: true, startAt: now, base: 0, endAt: 0, remain: 0}
    : {free: false, running: true, endAt: now + sec * 1000, remain: sec, startAt: 0, base: 0};
}
const tRemain = (t, now) => (t.running ? Math.max(0, Math.ceil((t.endAt - now) / 1000)) : t.remain);
const tElapsed = (t, now) => (t.running ? t.base + Math.floor((now - t.startAt) / 1000) : t.base);
const timeUp = (t, now) => !!t && !t.free && tRemain(t, now) === 0;
function timerOp(t, op, now) {
  if (!t) return false;
  if (op === 'pause') {
    if (t.free) { if (t.running) { t.base = tElapsed(t, now); t.running = false; } else { t.startAt = now; t.running = true; } return true; }
    if (timeUp(t, now)) return false;
    if (t.running) { t.remain = tRemain(t, now); t.running = false; } else { t.endAt = now + t.remain * 1000; t.running = true; }
    return true;
  }
  if (op === 'plus') {
    if (t.free) return false;
    const r = Math.min(3600, tRemain(t, now) + 60);
    if (tRemain(t, now) === 0) t.running = true;
    if (t.running) t.endAt = now + r * 1000; else t.remain = r;
    return true;
  }
  return false;
}
function goVoteIntro(g) { setPhase(g, 'voteIntro'); g.runoff = null; g.timer = null; g.want = {}; }

// 投了(突然死):その人は死亡になる。役職は終局まで伏せる
function resign(g, s) {
  g.players[s].alive = false;
  delete g.want[s];
  g.ev.push({k: 'resign', day: g.day, s, ph: g.phase});
  if (g.phase === 'night') {
    delete g.na.wolfVotes[s]; delete g.na.guards[s];
    for (const [k, v] of Object.entries(g.na.wolfVotes)) if (v === s) { delete g.na.wolfVotes[k]; delete g.acts[k]; delete g.done[k]; }   // 襲撃先が抜けた人狼は選び直し
  }
  if (g.phase === 'vote') {
    delete g.votes[s];
    for (const [k, v] of Object.entries(g.votes)) if (v === s) { delete g.votes[k]; delete g.done[k]; }   // 投票先が抜けた人は投票し直し
  }
  if (g.runoff && (g.phase === 'vote' || g.phase === 'voteIntro')) {
    g.runoff = g.runoff.filter(i => g.players[i].alive);
    if (g.runoff.length < 2) g.runoff = null;
  }
  g.winner = checkWin(g);
  if (g.winner) setPhase(g, 'end');
  else progress(g);
}

// 受け取り手ごとに、見てよい形にする(公開情報+その人だけの秘密)
function gameView(g, seat) {
  const me = seat >= 0 ? g.players[seat] : null;
  const end = g.phase === 'end';
  const seeAll = end || (!!me && !me.alive && g.settings.deadView === 'all');   // 死亡後に全員の役職を見る設定
  const isWolf = !!me && me.role === 'wolf';
  const players = g.players.map((p, i) => ({name: p.name, alive: p.alive,
    role: seeAll || i === seat || (isWolf && p.role === 'wolf') ? p.role : null}));
  const vr = g.voteRes ? {tally: g.voteRes.tally, tops: g.voteRes.tops, exec: g.voteRes.exec, runoff: g.voteRes.runoff,
    votes: g.settings.voteReveal === 'open' || end ? g.voteRes.votes : {}} : null;
  const pub = {players, settings: g.settings, counts: g.counts, day: g.day, phase: g.phase, seq: g.seq,
    done: Object.keys(g.done).map(Number), want: Object.keys(g.want).map(Number),
    execToday: g.execToday, morningVictim: g.morningVictim, runoff: g.runoff, voteRes: vr, timer: g.timer, winner: g.winner};
  let priv = null;
  if (me) {
    const wv = {};
    if (isWolf && g.phase === 'night') for (const [k, v] of Object.entries(g.na.wolfVotes)) if (Number(k) !== seat) wv[k] = v;
    priv = {done: !!g.done[seat], act: g.phase === 'night' && g.acts[seat] ? g.acts[seat] : null,
      vote: g.phase === 'vote' && g.votes[seat] != null ? g.votes[seat] : null,
      lastGuard: g.lastGuard[seat] != null ? g.lastGuard[seat] : null,
      seerHist: g.seerHist[seat] || [], medHist: g.medHist[seat] || [], wolfVotes: wv,
      lastAct: g.lastActs && g.lastActs[seat] ? {day: g.lastNight, t: g.lastActs[seat].t, r: g.lastActs[seat].r} : null};
  }
  const final = end ? {ev: g.ev, seerHint: g.seerHint} : null;   // 終局後は隠していた情報を全部公開する
  return {pub, priv, final};
}

/* =========================================================
   2. 入力の検査
   ========================================================= */
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const cleanName = v => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>&"'`\\]/g, '').trim().slice(0, 10) : '');
const PALETTE_N = 10;
const clampCol = v => (isInt(v, 0, PALETTE_N - 1) ? v : 0);
const CODE_CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 見間違えやすい I・O・0・1 は使わない(index.html と同じ)
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;
const SETTING_OK = {
  talk: v => [180, 300, 420, 0].includes(v),
  firstSeer: v => ['free', 'none', 'random'].includes(v),
  consecGuard: v => typeof v === 'boolean',
  firstAttack: v => typeof v === 'boolean',
  voteReveal: v => ['count', 'open'].includes(v),
  deadView: v => ['all', 'public'].includes(v),
};
const defSettings = () => ({talk: 300, firstSeer: 'random', consecGuard: true, firstAttack: false, voteReveal: 'open', deadView: 'all'});
function cleanCounts(c) {
  if (!c || typeof c !== 'object') return null;
  const o = {};
  for (const k of ROLE_KEYS) { if (!isInt(c[k], 0, MAX_P)) return null; o[k] = c[k]; }
  return o;
}
const ADV = ['startNight', 'toDay', 'startVote', 'toRunoff', 'toNight', 'toEnd'];

/* =========================================================
   3. ルーム(Durable Object)
   ========================================================= */
const MAX_MEMBERS = MAX_P;              // 観戦はないので、部屋に入れるのは席の上限まで
const IDLE_MS = 7 * 24 * 3600 * 1000;   // 7日間 使われなかったルームは消す
const MAX_MSG = 4000, RATE_SOFT = 20, RATE_HARD = 60;

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null;
    this.rate = new WeakMap();
    ctx.blockConcurrencyWhile(async () => { this.room = (await ctx.storage.get('room')) || null; });
    // 「ping」には、ルームを起こさずに「pong」と自動で返す(待機中の費用を抑える)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  async fetch(req) {
    const url = new URL(req.url);
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket で接続してください', {status: 426});
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({code: url.searchParams.get('room') || '', create: url.searchParams.get('create') === '1', ok: false});
    return new Response(null, {status: 101, webSocket: client});
  }
  // ---- 送受信の道具 ----
  send(ws, m) { try { ws.send(JSON.stringify(m)); } catch (e) {} }
  fail(ws, e) { this.send(ws, {t: 'err', e}); try { ws.close(4000, e); } catch (_) {} }
  sockets(except) { return this.ctx.getWebSockets().filter(s => s !== except && (s.readyState === undefined || s.readyState === 1)); }
  att(ws) { try { return ws.deserializeAttachment() || {}; } catch (e) { return {}; } }
  onlineToks(except) { const s = new Set(); for (const w of this.sockets(except)) { const a = this.att(w); if (a.ok) s.add(a.tok); } return s; }
  async save() {
    this.room.at = Date.now();
    await this.ctx.storage.put('room', this.room);
    await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
  }
  // 受け取り手ごとの部屋の状態(合言葉 tok は外に出さない)
  view(a, except) {
    const R = this.room, on = this.onlineToks(except);
    const mem = t => R.members.find(x => x.tok === t);
    const seat = R.seats.indexOf(a.tok);
    const gv = R.game ? gameView(R.game, seat) : null;
    return {
      phase: R.phase, gen: R.gen, nseat: R.nseat, code: R.code,
      seats: R.seats.map(t => { const x = t && mem(t); return x ? {n: x.name, c: x.col, on: on.has(t)} : null; }),
      mem: R.members.map(x => ({n: x.name, c: x.col, on: on.has(x.tok), seat: R.seats.indexOf(x.tok)})),
      me: {seat},
      cfg: R.cfg,
      game: gv ? gv.pub : null, priv: gv ? gv.priv : null, final: gv ? gv.final : null,
      now: Date.now()
    };
  }
  push(except, only) {   // 全員(または1人)に、その人用の部屋の状態を送る
    for (const w of only ? [only] : this.sockets(except)) { const a = this.att(w); if (a.ok) this.send(w, {t: 'room', d: this.view(a, except)}); }
  }
  bad(ws) { this.send(ws, {t: 'err', e: 'bad'}); this.push(null, ws); }   // 正本で上書きしてもらう

  // ---- 受信 ----
  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MSG) { try { ws.close(1009, 'too big'); } catch (e) {} return; }
    const now = Date.now(), r = this.rate.get(ws) || {win: 0, cnt: 0};   // 送信が多すぎる相手は無視し、さらに続けば切断する
    if (now - r.win > 1000) { r.win = now; r.cnt = 0; }
    this.rate.set(ws, r);
    if (++r.cnt > RATE_SOFT) { if (r.cnt > RATE_HARD) { try { ws.close(1008, 'too many'); } catch (e) {} } return; }
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return;
    const a = this.att(ws);
    if (!a.ok) { if (m.t === 'hello') await this.hello(ws, a, m); return; }
    if (!this.room) { this.fail(ws, 'noroom'); return; }
    if (m.t === 'sync') { this.push(null, ws); return; }
    const R = this.room, seat = R.seats.indexOf(a.tok), me = R.members.find(x => x.tok === a.tok);
    if (!me) { this.fail(ws, 'closed'); return; }
    const g = R.game, live = g && seat >= 0 && g.players[seat] && g.players[seat].alive;
    const seqOk = g && m.seq === g.seq;
    switch (m.t) {
      /* ---- 待合室 ---- */
      case 'me':
        if (R.phase !== 'lobby') return;
        if ('name' in m) { const n = cleanName(m.name); if (n) me.name = n; }
        if ('col' in m) me.col = clampCol(m.col);
        break;
      case 'seat': {
        if (R.phase !== 'lobby') return;
        const n = m.n;
        if (n === -1) R.seats = R.seats.map(t => (t === a.tok ? '' : t));
        else if (isInt(n, 0, R.nseat - 1) && (!R.seats[n] || R.seats[n] === a.tok)) { R.seats = R.seats.map(t => (t === a.tok ? '' : t)); R.seats[n] = a.tok; }
        else return this.bad(ws);
        break;
      }
      case 'nseat': {
        if (R.phase !== 'lobby' || seat < 0 || !isInt(m.n, MIN_P, MAX_P)) return this.bad(ws);
        const s = R.seats.slice(0, m.n); while (s.length < m.n) s.push('');
        R.seats = s; R.nseat = m.n;
        break;
      }
      case 'cfg': {
        if (R.phase !== 'lobby' || seat < 0) return this.bad(ws);
        if (m.settings && typeof m.settings === 'object') {
          for (const [k, v] of Object.entries(m.settings)) { if (!SETTING_OK[k] || !SETTING_OK[k](v)) return this.bad(ws); }
          Object.assign(R.cfg.settings, m.settings);
        }
        if ('counts' in m) { const c = cleanCounts(m.counts); if (!c) return this.bad(ws); R.cfg.counts = c; R.cfg.autoRoles = false; }
        if (m.autoRoles === true) R.cfg.autoRoles = true;
        break;
      }
      case 'start':
      case 'again': {
        if (seat < 0 || R.seats.some(t => !t)) return this.bad(ws);
        if (m.t === 'start' ? R.phase !== 'lobby' : R.phase !== 'over') return this.bad(ws);
        const counts = R.cfg.autoRoles || !R.cfg.counts ? rec(R.nseat) : R.cfg.counts;
        if (cfgError(R.nseat, counts)) return this.bad(ws);
        // 同じ名前の人がいれば番号をつけて区別する
        const used = new Set(), names = R.seats.map(t => {
          const x = R.members.find(y => y.tok === t); let n = (x && x.name) || 'プレイヤー', k = 2, b = n;
          while (used.has(n)) n = b.slice(0, 8) + (k++);
          used.add(n); return n;
        });
        R.game = newGame(names, R.cfg.settings, counts); R.phase = 'play'; R.gen++;
        // 席のない人は、ゲームには入れない(観戦はない)
        for (const w of this.sockets()) { const b = this.att(w); if (b.ok && !R.seats.includes(b.tok)) this.fail(w, 'notseated'); }
        R.members = R.members.filter(x => R.seats.includes(x.tok));
        break;
      }
      case 'lobby': {   // 終局後、待合室に戻る(つながっていない人は外す)
        if (R.phase !== 'over' || seat < 0) return this.bad(ws);
        const on = this.onlineToks();
        R.members = R.members.filter(x => on.has(x.tok));
        R.seats = R.seats.map(t => (on.has(t) ? t : ''));
        R.phase = 'lobby'; R.game = null;
        break;
      }
      /* ---- ゲーム中 ---- */
      case 'ok':   // 役職を確認した
        if (R.phase !== 'play' || !seqOk || g.phase !== 'reveal' || !live || g.done[seat]) return this.bad(ws);
        g.done[seat] = true; progress(g);
        break;
      case 'act': {   // 夜の行動
        if (R.phase !== 'play' || !seqOk || g.phase !== 'night' || !live || g.done[seat] || !nightChoiceOk(g, seat, m.sel)) return this.bad(ws);
        commitNight(g, seat, m.sel, nightRes(g, seat, m.sel)); g.done[seat] = true; progress(g);
        break;
      }
      case 'vote': {
        if (R.phase !== 'play' || !seqOk || g.phase !== 'vote' || !live || g.done[seat] || !isInt(m.sel, 0, g.players.length - 1) || !voteCands(g, seat).includes(m.sel)) return this.bad(ws);
        g.votes[seat] = m.sel; g.done[seat] = true; progress(g);
        break;
      }
      case 'adv': {   // 全員で見る画面の「次へ」(席にいる生存者なら誰でも押せる。結果を見るだけは死亡者も可)
        if (R.phase !== 'play' || !seqOk || !ADV.includes(m.to) || seat < 0) return this.bad(ws);
        if (m.to !== 'toEnd' && !live) return this.bad(ws);
        const ph = g.phase, vr = g.voteRes;
        if (m.to === 'startNight' && ph === 'nightIntro') { setPhase(g, 'night'); g.na = {wolfVotes: {}, guards: {}}; g.acts = {}; g.lastActs = {}; }
        else if (m.to === 'toDay' && ph === 'morning' && !g.winner) { setPhase(g, 'day'); g.timer = newTimer(g.settings.talk, now); g.want = {}; }
        else if (m.to === 'startVote' && ph === 'voteIntro') { setPhase(g, 'vote'); g.votes = {}; }
        else if (m.to === 'toRunoff' && ph === 'voteResult' && vr && vr.exec == null && !vr.runoff) { g.runoff = vr.tops.filter(i => g.players[i].alive); setPhase(g, 'voteIntro'); if (g.runoff.length < 2) g.runoff = null; }
        else if (m.to === 'toNight' && ph === 'voteResult' && !g.winner && vr && (vr.exec != null || vr.runoff)) { g.runoff = null; g.voteRes = null; setPhase(g, 'nightIntro'); }
        else if (m.to === 'toEnd' && (ph === 'morning' || ph === 'voteResult') && g.winner) setPhase(g, 'end');
        else return this.bad(ws);
        break;
      }
      case 'want': {   // 「議論を終えて投票へ」:生存者の過半数で進む。時間切れの後は1人で進められる
        if (R.phase !== 'play' || !seqOk || g.phase !== 'day' || !live || typeof m.on !== 'boolean') return this.bad(ws);
        if (m.on) g.want[seat] = true; else delete g.want[seat];
        const alive = aliveIdx(g).length, n = aliveIdx(g).filter(i => g.want[i]).length;
        if ((m.on && timeUp(g.timer, now)) || n > alive / 2) goVoteIntro(g);
        break;
      }
      case 'timer':
        if (R.phase !== 'play' || !seqOk || g.phase !== 'day' || !live || !timerOp(g.timer, m.op, now)) return this.bad(ws);
        break;
      case 'resign':
        if (R.phase !== 'play' || !live || g.phase === 'end') return this.bad(ws);
        resign(g, seat);
        break;
      case 'leave':
        if (R.phase === 'lobby') { R.members = R.members.filter(x => x.tok !== a.tok); R.seats = R.seats.map(t => (t === a.tok ? '' : t)); }
        await this.save(); this.push(ws);
        try { ws.close(1000, 'bye'); } catch (e) {}
        return;
      default: return;
    }
    if (R.game && R.game.phase === 'end') R.phase = 'over';
    await this.save();
    this.push();
  }
  async hello(ws, a, m) {
    const tok = typeof m.tok === 'string' && /^[0-9a-f]{32}$/.test(m.tok) ? m.tok : '';
    if (!tok || !CODE_RE.test(a.code)) { this.fail(ws, 'closed'); return; }
    if (!this.room) {
      if (!a.create) { this.fail(ws, 'noroom'); return; }
      this.room = {code: a.code, phase: 'lobby', gen: 0, nseat: 6, seats: Array(6).fill(''), members: [],
        cfg: {settings: defSettings(), counts: null, autoRoles: true}, game: null, at: Date.now()};
    } else if (a.create) { this.fail(ws, 'exists'); return; }   // 同じIDのルームがもうある(作る側で別のIDを選び直す)
    const R = this.room;
    let me = R.members.find(x => x.tok === tok);
    if (!me) {
      if (R.phase !== 'lobby') { this.fail(ws, 'playing'); return; }
      if (R.members.length >= MAX_MEMBERS) { this.fail(ws, 'full'); return; }
      me = {tok, name: cleanName(m.name) || 'プレイヤー', col: clampCol(m.col)};
      // 色がほかの人と同じなら、空いている色に替える(全色使われていればそのまま)
      const used = new Set(R.members.map(x => x.col));
      if (used.has(me.col)) for (let k = 1; k < PALETTE_N; k++) { const c = (me.col + k) % PALETTE_N; if (!used.has(c)) { me.col = c; break; } }
      R.members.push(me);
    }
    for (const w of this.sockets(ws)) { const b = this.att(w); if (b.ok && b.tok === tok) { try { w.close(4001, 'replaced'); } catch (e) {} } }   // 同じ人が入り直した:古い接続を切る
    ws.serializeAttachment({code: a.code, ok: true, tok});
    this.send(ws, {t: 'welcome'});
    await this.save();
    this.push();
  }
  async dropped(ws) {
    const a = this.att(ws);
    if (!a.ok || !this.room) return;
    const R = this.room;
    if (R.phase === 'lobby' && !this.onlineToks(ws).has(a.tok)) {   // 待合室で接続が切れた人は、一覧と席から外す
      R.members = R.members.filter(x => x.tok !== a.tok); R.seats = R.seats.map(t => (t === a.tok ? '' : t));
      await this.save();
    }
    this.push(ws);
  }
  async webSocketClose(ws, code) { try { ws.close(1000, 'bye'); } catch (e) {} await this.dropped(ws); }
  async webSocketError(ws) { await this.dropped(ws); }
  async alarm() {   // 長く使われていないルームを消す
    if (!this.room) return;
    if (Date.now() - (this.room.at || 0) > IDLE_MS && this.sockets().length === 0) { await this.ctx.storage.deleteAll(); this.room = null; }
    else await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
  }
}

/* =========================================================
   4. 入口(Worker)
   ========================================================= */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // ALLOWED_ORIGINS(カンマ区切り)を設定すると、そのサイトから開いたページだけが使える
    const allow = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const origin = req.headers.get('Origin') || '';
    if (allow.length && origin && !allow.includes(origin)) return new Response('このサイトからは使えません', {status: 403});
    if (url.pathname === '/ws') {
      const code = url.searchParams.get('room') || '';
      if (!CODE_RE.test(code)) return new Response('ルームIDが正しくありません', {status: 400});
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket で接続してください', {status: 426});
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(req);
    }
    if (url.pathname === '/') return new Response('人狼 中継サーバー:動作中', {headers: {'content-type': 'text/plain; charset=utf-8'}});
    return new Response('見つかりません', {status: 404});
  }
};
