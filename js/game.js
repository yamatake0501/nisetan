// ===== 設定 =====
const GAME_SECONDS = 50;      // 1プレイの制限時間
const PREVIEW_COUNT = 20;     // 予習画面に表示する単語数
const LANE_STAGGER = 1200;    // 開始直後にレーンごとに落下をずらす時間差(ms)
const FALL_DURATION = 9000;   // 上から地面まで落ちる時間(ms)
const LANES = [16.67, 50, 83.33]; // レーンのx位置(%)

const SCORE_CORRECT = 100;
const SCORE_WRONG = -50;
const SCORE_MISSED = -50;
const SPEED_BONUS_MAX = 100;    // 即答した場合に上乗せされる最大ボーナス
const COMBO_STEP = 0.1;         // 連続正解1つにつき倍率+10%
const COMBO_MAX_MULTIPLIER = 3; // コンボ倍率の上限

// ===== 学習データ (localStorage) =====
const STORAGE_KEYS = {
  review: "nisetan_review",       // 復習待ち(不正解・落下)の単語id
  mastered: "nisetan_mastered",   // 習得済みの単語id
  highscore: "nisetan_highscore", // レベルごとのハイスコア {level: score}
  level: "nisetan_level",         // 最後に選んだレベル
  ranking: "nisetan_ranking",     // レベルごとの上位スコア履歴 {level: [{score, date}]}
  misscount: "nisetan_misscount", // 単語ごとのミス回数 {単語id: ミス回数}
};
const SOUND_KEY = "nisetan_sound"; // 効果音のオン・オフ設定（学習データリセットの対象外）
const RANKING_SIZE = 5;

function loadIds(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function saveIds(key, set) {
  localStorage.setItem(key, JSON.stringify([...set]));
}

function loadHighscores() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.highscore)) || {};
  } catch {
    return {};
  }
}

function loadRankings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.ranking)) || {};
  } catch {
    return {};
  }
}

function loadMissCounts() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.misscount)) || {};
  } catch {
    return {};
  }
}

let reviewSet = loadIds(STORAGE_KEYS.review);
let masteredSet = loadIds(STORAGE_KEYS.mastered);
let highscores = loadHighscores();
let rankings = loadRankings();
let missCounts = loadMissCounts();
let soundEnabled = localStorage.getItem(SOUND_KEY) !== "off";
let selectedLevel =
  localStorage.getItem(STORAGE_KEYS.level) ||
  (typeof LEVELS !== "undefined" ? LEVELS[0].id : "univ");

// 今回のプレイでランキングに入った順位を記録する（1位から数える。圏外なら-1）
function recordRanking(level, score) {
  const list = rankings[level] || [];
  const entry = { score, date: new Date().toISOString() };
  list.push(entry);
  list.sort((a, b) => b.score - a.score);
  rankings[level] = list.slice(0, RANKING_SIZE);
  localStorage.setItem(STORAGE_KEYS.ranking, JSON.stringify(rankings));
  return rankings[level].indexOf(entry);
}

// ===== ユーティリティ =====
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const $ = (sel) => document.querySelector(sel);

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $(id).classList.add("active");
}

// ===== 効果音（Web Audio APIで合成、音声ファイル不要） =====
let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function playToneAt(freq, startTime, duration, type, gainStart) {
  const ctx = getAudioCtx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(gainStart, startTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration + 0.02);
}

function playCorrectSound() {
  if (!soundEnabled) return;
  const t = getAudioCtx().currentTime;
  [660, 990].forEach((freq, i) => playToneAt(freq, t + i * 0.05, 0.12, "sine", 0.14));
}

function playWrongSound() {
  if (!soundEnabled) return;
  playToneAt(200, getAudioCtx().currentTime, 0.22, "sawtooth", 0.1);
}

function playMissedSound() {
  if (!soundEnabled) return;
  playToneAt(140, getAudioCtx().currentTime, 0.3, "square", 0.08);
}

function playComboSound(combo) {
  if (!soundEnabled) return;
  playToneAt(700 + Math.min(combo, 15) * 35, getAudioCtx().currentTime, 0.1, "triangle", 0.09);
}

function playStartSound() {
  if (!soundEnabled) return;
  const t = getAudioCtx().currentTime;
  [440, 554, 659].forEach((freq, i) => playToneAt(freq, t + i * 0.08, 0.12, "sine", 0.12));
}

function playEndSound(isRecord) {
  if (!soundEnabled) return;
  const t = getAudioCtx().currentTime;
  const notes = isRecord ? [523, 659, 784, 1047] : [523, 440, 349];
  notes.forEach((freq, i) => playToneAt(freq, t + i * 0.1, 0.18, "sine", 0.12));
}

function updateSoundToggleUI() {
  document.querySelectorAll(".sound-toggle").forEach((b) => {
    b.textContent = soundEnabled ? "🔊" : "🔇";
  });
}

document.querySelectorAll(".sound-toggle").forEach((b) => {
  b.addEventListener("click", () => {
    soundEnabled = !soundEnabled;
    localStorage.setItem(SOUND_KEY, soundEnabled ? "on" : "off");
    updateSoundToggleUI();
    if (soundEnabled) playToneAt(660, getAudioCtx().currentTime, 0.08, "sine", 0.1);
  });
});

// ===== レーンごとの解答パネル =====
// レーンごとに独立したターゲット単語・3択を持たせ、複数レーンを同時に回答できるようにする
let laneEls = [];

function buildLaneAnswers() {
  const container = $("#lane-answers");
  container.innerHTML = "";
  laneEls = LANES.map((_, lane) => {
    const card = document.createElement("div");
    card.className = "lane-card";
    card.dataset.lane = String(lane);

    const targetEl = document.createElement("div");
    targetEl.className = "lane-target";
    targetEl.innerHTML = "&nbsp;";

    const choicesEl = document.createElement("div");
    choicesEl.className = "lane-choices";
    const choiceBtns = [0, 1, 2].map((i) => {
      const btn = document.createElement("button");
      btn.className = "choice-btn";
      btn.dataset.index = String(i);
      btn.disabled = true;
      btn.addEventListener("click", () => onChoice(lane, btn));
      choicesEl.appendChild(btn);
      return btn;
    });

    card.appendChild(targetEl);
    card.appendChild(choicesEl);
    container.appendChild(card);
    return { card, targetEl, choiceBtns };
  });
}

// ===== 出題単語の選定 =====
// 選択中のレベルの単語から、復習待ちを最優先で出題し、
// 残りを未習得→習得済みの順で埋める
function selectRoundWords() {
  const pool = WORDS.filter((w) => w.level === selectedLevel);
  const inLevel = new Set(pool.map((w) => w.id));
  const byId = new Map(pool.map((w) => [w.id, w]));
  const review = shuffle([...reviewSet].filter((id) => inLevel.has(id))).map((id) => byId.get(id));
  const fresh = shuffle(pool.filter((w) => !reviewSet.has(w.id) && !masteredSet.has(w.id)));
  const mastered = shuffle(pool.filter((w) => masteredSet.has(w.id) && !reviewSet.has(w.id)));
  return [...review, ...fresh, ...mastered];
}

// ===== ゲーム状態 =====
let roundWords = [];   // 今回の出題単語
let game = null;       // プレイ中の状態

function newGameState() {
  return {
    running: false,
    startTime: 0,
    score: 0,
    combo: 0,              // 現在の連続正解数
    spawnedCount: 0,
    falling: [],           // { word, el, spawnTime, lane, resolved }
    laneTargets: new Array(LANES.length).fill(null), // レーンごとの回答対象
    results: new Map(),    // id -> "correct" | "wrong" | "missed"
    rafId: 0,
  };
}

// ===== 予習画面 =====
function renderPreview() {
  roundWords = selectRoundWords();
  const levelLabel = LEVELS.find((l) => l.id === selectedLevel)?.label || "";
  $("#preview-title").textContent = `📖 予習 — ${levelLabel}`;
  const list = $("#preview-list");
  list.classList.remove("meanings-hidden");
  $("#btn-hide-meanings").textContent = "意味を隠してテスト";
  list.innerHTML = "";
  for (const w of roundWords.slice(0, PREVIEW_COUNT)) {
    const li = document.createElement("li");
    const badge = reviewSet.has(w.id) ? '<span class="badge badge-review">復習</span>' : "";
    li.innerHTML = `<span class="en">${w.en}</span>${badge}<span class="ja">${w.ja}</span>`;
    li.addEventListener("click", () => li.classList.toggle("revealed"));
    list.appendChild(li);
  }
}

// ===== ゲーム本体 =====
function startGame() {
  game = newGameState();
  game.running = true;
  game.startTime = performance.now();
  $("#score").textContent = "0";
  $("#time-left").textContent = String(GAME_SECONDS);
  $("#words-left").textContent = "0";
  $("#play-area").querySelectorAll(".falling-word, .float-score").forEach((el) => el.remove());
  buildLaneAnswers();
  for (let lane = 0; lane < LANES.length; lane++) renderLaneChoices(lane, null);
  updateComboDisplay();
  showScreen("#screen-game");
  playStartSound();
  game.rafId = requestAnimationFrame(tick);
}

function tick(now) {
  if (!game.running) return;
  const elapsed = now - game.startTime;

  // タイマー
  const left = Math.max(0, Math.ceil(GAME_SECONDS - elapsed / 1000));
  $("#time-left").textContent = String(left);
  if (elapsed >= GAME_SECONDS * 1000) {
    endGame();
    return;
  }

  // 出現: レーンが空いたら即座に次の単語を落とし、問題間の待ち時間をなくす。
  // 開始直後だけはレーンごとに時間差をつけて、横並びで落ちないようにする。
  for (let lane = 0; lane < LANES.length; lane++) {
    if (elapsed < lane * LANE_STAGGER) continue;
    const laneBusy = game.falling.some((f) => f.lane === lane && !f.resolved);
    if (laneBusy) continue;
    // 出題キューが尽きたら、レベル内の全単語をシャッフルして追補し、50秒間出題が途切れないようにする
    if (game.spawnedCount >= roundWords.length) {
      const pool = WORDS.filter((w) => w.level === selectedLevel);
      roundWords = roundWords.concat(shuffle(pool));
    }
    spawnWord(roundWords[game.spawnedCount], lane, now);
    game.spawnedCount++;
  }

  // 落下の更新
  const area = $("#play-area");
  const areaH = area.clientHeight;
  for (const f of game.falling) {
    if (f.resolved) continue;
    const progress = (now - f.spawnTime) / FALL_DURATION;
    if (progress >= 1) {
      resolveMissed(f);
      continue;
    }
    f.el.style.top = `${-40 + progress * (areaH - 6 + 40)}px`;
  }

  updateTargets();

  game.rafId = requestAnimationFrame(tick);
}

function spawnWord(word, lane, now) {
  const el = document.createElement("div");
  el.className = "falling-word";
  el.textContent = word.en;
  el.style.left = `${LANES[lane]}%`;
  el.style.top = "-40px";
  $("#play-area").appendChild(el);
  game.falling.push({ word, el, spawnTime: now, lane, resolved: false });
}

// レーンごとに、一番地面に近い未解決の単語をそのレーンのターゲットにする。
// レーンは互いに独立しているので、最大でレーン数ぶんの単語を同時に回答できる。
function updateTargets() {
  for (let lane = 0; lane < LANES.length; lane++) {
    const active = game.falling.filter((f) => f.lane === lane && !f.resolved);
    const nearest = active.reduce(
      (best, f) => (!best || f.spawnTime < best.spawnTime ? f : best),
      null
    );
    const prev = game.laneTargets[lane];
    if (nearest === prev) continue;

    if (prev && !prev.resolved) prev.el.classList.remove("target");
    game.laneTargets[lane] = nearest;
    renderLaneChoices(lane, nearest);
  }
}

function renderLaneChoices(lane, f) {
  const laneEl = laneEls[lane];
  if (!laneEl) return;

  if (!f) {
    laneEl.targetEl.innerHTML = "&nbsp;";
    laneEl.choiceBtns.forEach((b) => {
      b.textContent = "";
      b.disabled = true;
      b.classList.remove("correct", "wrong");
    });
    return;
  }

  f.el.classList.add("target");
  laneEl.targetEl.textContent = f.word.en;

  // ダミーの選択肢は同じレベルから選び、難易度をそろえる
  let pool = WORDS.filter((w) => w.level === f.word.level && w.id !== f.word.id);
  if (pool.length < 2) pool = WORDS.filter((w) => w.id !== f.word.id);
  const distractors = shuffle(pool).slice(0, 2).map((w) => w.ja);
  const choices = shuffle([f.word.ja, ...distractors]);
  laneEl.choiceBtns.forEach((b, i) => {
    b.textContent = choices[i];
    b.disabled = false;
    b.classList.remove("correct", "wrong");
  });
}

function onChoice(lane, btn) {
  if (!game || !game.running) return;
  const t = game.laneTargets[lane];
  if (!t || t.resolved) return;

  if (btn.textContent === t.word.ja) {
    btn.classList.add("correct");
    // 一度でも間違えた単語は「不正解」のまま(復習に回す)
    if (!game.results.has(t.word.id)) game.results.set(t.word.id, "correct");

    // 早く答えるほどスピードボーナス、連続正解が続くほどコンボ倍率が上がる
    const now = performance.now();
    const progress = Math.min(1, Math.max(0, (now - t.spawnTime) / FALL_DURATION));
    const speedBonus = Math.round(SPEED_BONUS_MAX * (1 - progress));
    game.combo += 1;
    const multiplier = Math.min(1 + (game.combo - 1) * COMBO_STEP, COMBO_MAX_MULTIPLIER);
    const total = Math.round((SCORE_CORRECT + speedBonus) * multiplier);

    addScore(total, t.el, { speedBonus, multiplier });
    updateComboDisplay();
    spawnBurst(t.el);
    if (game.combo >= 2) playComboSound(game.combo);
    else playCorrectSound();

    t.resolved = true;
    t.el.classList.remove("target");
    t.el.classList.add("pop");
    setTimeout(() => t.el.remove(), 300);
    updateCorrectCount();
  } else {
    btn.classList.add("wrong");
    btn.disabled = true;
    game.results.set(t.word.id, "wrong");
    game.combo = 0;
    updateComboDisplay();
    addScore(SCORE_WRONG, t.el);
    playWrongSound();
    shakeLane(lane);
  }
}

function resolveMissed(f) {
  f.resolved = true;
  game.results.set(f.word.id, "missed");
  game.combo = 0;
  updateComboDisplay();
  addScore(SCORE_MISSED, f.el);
  playMissedSound();
  flashGround();
  f.el.classList.remove("target");
  f.el.classList.add("crash");
  setTimeout(() => f.el.remove(), 350);
}

// ===== 演出ヘルパー =====
function spawnBurst(nearEl) {
  const burst = document.createElement("div");
  burst.className = "burst-ring";
  burst.style.left = nearEl.style.left;
  burst.style.top = nearEl.style.top;
  $("#play-area").appendChild(burst);
  setTimeout(() => burst.remove(), 500);
}

function shakeLane(lane) {
  const card = laneEls[lane]?.card;
  if (!card) return;
  card.classList.remove("shake");
  void card.offsetWidth; // アニメーションを再トリガーするための強制リフロー
  card.classList.add("shake");
}

function flashGround() {
  const ground = $("#ground");
  ground.classList.remove("flash");
  void ground.offsetWidth;
  ground.classList.add("flash");
}

function updateComboDisplay() {
  const el = $("#combo-info");
  if (game.combo >= 2) {
    el.hidden = false;
    $("#combo-count").textContent = String(game.combo);
    el.classList.remove("pulse");
    void el.offsetWidth; // アニメーションを再トリガーするための強制リフロー
    el.classList.add("pulse");
  } else {
    el.hidden = true;
    el.classList.remove("pulse");
  }
}

function updateCorrectCount() {
  let correct = 0;
  for (const r of game.results.values()) if (r === "correct") correct++;
  $("#words-left").textContent = String(correct);
}

function addScore(delta, nearEl, bonus) {
  game.score += delta;
  $("#score").textContent = String(game.score);
  const scoreEl = $(".game-info.score");
  scoreEl.classList.remove("bump");
  void scoreEl.offsetWidth; // アニメーションを再トリガーするための強制リフロー
  scoreEl.classList.add("bump");
  // 単語の近くに +100 / -50 と、スピード・コンボボーナスの内訳をふわっと表示
  const float = document.createElement("div");
  float.className = `float-score ${delta > 0 ? "plus" : "minus"}`;
  let html = delta > 0 ? `+${delta}` : String(delta);
  if (bonus) {
    const parts = [];
    if (bonus.speedBonus > 0) parts.push(`SPEED+${bonus.speedBonus}`);
    if (bonus.multiplier > 1) parts.push(`COMBO×${bonus.multiplier.toFixed(1)}`);
    if (parts.length) html += `<span class="float-sub">${parts.join(" ")}</span>`;
  }
  float.innerHTML = html;
  float.style.left = nearEl.style.left;
  float.style.top = nearEl.style.top;
  $("#play-area").appendChild(float);
  setTimeout(() => float.remove(), 800);
}

// ===== 終了・復習 =====
function endGame() {
  game.running = false;
  cancelAnimationFrame(game.rafId);

  // 出題されなかった/落下中のままの単語は「落下」扱いにはせず未出題として無視、
  // ただし画面に出て未回答のまま時間切れになったものは復習に回す
  for (const f of game.falling) {
    if (!f.resolved && !game.results.has(f.word.id)) {
      game.results.set(f.word.id, "missed");
    }
  }

  // 学習データを更新
  for (const [id, result] of game.results) {
    if (result === "correct") {
      reviewSet.delete(id);
      masteredSet.add(id);
      // 正解できたらミス回数を1減らし、0になったら苦手単語から外す
      const next = (missCounts[id] || 0) - 1;
      if (next > 0) missCounts[id] = next;
      else delete missCounts[id];
    } else {
      reviewSet.add(id);
      masteredSet.delete(id);
      // 不正解・落下はミス回数を1増やす
      missCounts[id] = (missCounts[id] || 0) + 1;
    }
  }
  saveIds(STORAGE_KEYS.review, reviewSet);
  saveIds(STORAGE_KEYS.mastered, masteredSet);
  localStorage.setItem(STORAGE_KEYS.misscount, JSON.stringify(missCounts));

  const prevBest = highscores[selectedLevel] || 0;
  const isRecord = game.score > prevBest;
  if (isRecord) {
    highscores[selectedLevel] = game.score;
    localStorage.setItem(STORAGE_KEYS.highscore, JSON.stringify(highscores));
  }
  const rankIndex = recordRanking(selectedLevel, game.score);

  playEndSound(isRecord);
  renderResult(isRecord, rankIndex);
  showScreen("#screen-result");
}

function renderResult(isRecord, rankIndex) {
  $("#result-score").textContent = String(game.score);

  const counts = { correct: 0, wrong: 0, missed: 0 };
  for (const r of game.results.values()) counts[r]++;
  const badges = [];
  if (isRecord) badges.push('<span class="new-record">🎉 ハイスコア更新！</span>');
  if (rankIndex >= 0) badges.push(`<span class="new-record">🏆 ランキング${rankIndex + 1}位！</span>`);
  $("#result-detail").innerHTML =
    `正解 ${counts.correct} / 不正解 ${counts.wrong} / 落下 ${counts.missed}` +
    (badges.length ? ` ${badges.join(" ")}` : "");

  const labels = {
    correct: '<span class="badge badge-correct">正解</span>',
    wrong: '<span class="badge badge-wrong">不正解</span>',
    missed: '<span class="badge badge-missed">落下</span>',
  };
  const list = $("#result-list");
  list.innerHTML = "";
  // 間違えた単語を上に表示して復習しやすくする
  // 出題キューの追補で同じ単語が複数回入っていることがあるので、単語IDで重複を除く
  const order = { wrong: 0, missed: 1, correct: 2 };
  const seen = new Set();
  const entries = roundWords
    .filter((w) => game.results.has(w.id) && !seen.has(w.id) && seen.add(w.id))
    .sort((a, b) => order[game.results.get(a.id)] - order[game.results.get(b.id)]);
  for (const w of entries) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="en">${w.en}</span>${labels[game.results.get(w.id)]}<span class="ja">${w.ja}</span>`;
    list.appendChild(li);
  }

  const requeue = entries.filter((w) => game.results.get(w.id) !== "correct").length;
  $("#requeue-note").textContent = requeue
    ? `⚠️ 間違えた${requeue}語は次回のプレイで優先的に再出題されます。`
    : "🎉 全問正解！すべて習得済みになりました。";
}

// ===== ホーム =====
// レベル選択UIはホーム画面・ランキング画面の両方で使うので共通化する
function buildLevelSelect(container, onChange) {
  container.innerHTML = "";
  for (const lv of LEVELS) {
    const btn = document.createElement("button");
    btn.className = "level-btn" + (lv.id === selectedLevel ? " active" : "");
    btn.dataset.level = lv.id;
    btn.innerHTML = `<span class="level-name">${lv.label}</span><span class="level-desc">${lv.desc}</span>`;
    btn.addEventListener("click", () => {
      selectedLevel = lv.id;
      localStorage.setItem(STORAGE_KEYS.level, selectedLevel);
      onChange();
    });
    container.appendChild(btn);
  }
}

function renderHome() {
  buildLevelSelect($("#level-select"), renderHome);
  // 選択中レベルの単語だけで集計する
  const levelIds = WORDS.filter((w) => w.level === selectedLevel).map((w) => w.id);
  const total = levelIds.length;
  const mastered = levelIds.filter((id) => masteredSet.has(id)).length;
  const review = levelIds.filter((id) => reviewSet.has(id)).length;
  $("#stat-mastered").textContent = `${mastered}/${total}`;
  $("#stat-review").textContent = String(review);
  $("#stat-highscore").textContent = String(highscores[selectedLevel] || 0);
}

// ===== ランキング =====
const RANK_MEDALS = ["🥇", "🥈", "🥉"];

function renderRanking() {
  buildLevelSelect($("#ranking-level-select"), renderRanking);
  const list = $("#ranking-list");
  list.innerHTML = "";
  const entries = rankings[selectedLevel] || [];
  if (!entries.length) {
    const li = document.createElement("li");
    li.className = "ranking-empty";
    li.textContent = "まだ記録がありません。プレイしてランキング入りを目指そう！";
    list.appendChild(li);
    return;
  }
  entries.forEach((entry, i) => {
    const li = document.createElement("li");
    const rankLabel = RANK_MEDALS[i] || `${i + 1}位`;
    const date = new Date(entry.date);
    const dateStr = `${date.getMonth() + 1}/${date.getDate()}`;
    li.innerHTML = `<span class="rank-badge">${rankLabel}</span><span class="rank-score">${entry.score}pt</span><span class="rank-date">${dateStr}</span>`;
    list.appendChild(li);
  });
}

// ===== 苦手単語 =====
function renderWeak() {
  buildLevelSelect($("#weak-level-select"), renderWeak);
  const list = $("#weak-list");
  list.innerHTML = "";
  // 選択中レベルのうち、ミス回数が残っている単語をミス回数の多い順に並べる
  const entries = WORDS.filter((w) => w.level === selectedLevel && (missCounts[w.id] || 0) > 0).sort(
    (a, b) => missCounts[b.id] - missCounts[a.id]
  );
  if (!entries.length) {
    const li = document.createElement("li");
    li.className = "ranking-empty";
    li.textContent = "苦手単語はありません。";
    list.appendChild(li);
    return;
  }
  for (const w of entries) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="en">${w.en}</span><span class="badge badge-wrong">×${missCounts[w.id]}</span><span class="ja">${w.ja}</span>`;
    list.appendChild(li);
  }
}

// ===== イベント =====
$("#btn-to-preview").addEventListener("click", () => {
  renderPreview();
  showScreen("#screen-preview");
});

$("#btn-back-home").addEventListener("click", () => {
  renderHome();
  showScreen("#screen-home");
});

$("#btn-hide-meanings").addEventListener("click", () => {
  const list = $("#preview-list");
  const hidden = list.classList.toggle("meanings-hidden");
  list.querySelectorAll("li").forEach((li) => li.classList.remove("revealed"));
  $("#btn-hide-meanings").textContent = hidden ? "意味を表示する" : "意味を隠してテスト";
});

$("#btn-start").addEventListener("click", startGame);

$("#btn-retry").addEventListener("click", () => {
  renderPreview();
  showScreen("#screen-preview");
});

$("#btn-result-home").addEventListener("click", () => {
  renderHome();
  showScreen("#screen-home");
});

$("#btn-reset").addEventListener("click", () => {
  if (!confirm("習得済み・復習待ち・ハイスコア・ランキングの記録をすべて消します。よろしいですか？")) return;
  reviewSet = new Set();
  masteredSet = new Set();
  highscores = {};
  rankings = {};
  missCounts = {};
  Object.values(STORAGE_KEYS).forEach((k) => localStorage.removeItem(k));
  renderHome();
});

$("#btn-to-ranking").addEventListener("click", () => {
  renderRanking();
  showScreen("#screen-ranking");
});

$("#btn-ranking-home").addEventListener("click", () => {
  renderHome();
  showScreen("#screen-home");
});

$("#btn-to-weak").addEventListener("click", () => {
  renderWeak();
  showScreen("#screen-weak");
});

$("#btn-weak-home").addEventListener("click", () => {
  renderHome();
  showScreen("#screen-home");
});

updateSoundToggleUI();
renderHome();
