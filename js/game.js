// ===== 設定 =====
const GAME_SECONDS = 50;      // 1プレイの制限時間
const ROUND_WORD_COUNT = 12;  // 1プレイの出題数
const SPAWN_INTERVAL = 3500;  // 出現間隔(ms)
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
};

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

let reviewSet = loadIds(STORAGE_KEYS.review);
let masteredSet = loadIds(STORAGE_KEYS.mastered);
let highscores = loadHighscores();
let selectedLevel =
  localStorage.getItem(STORAGE_KEYS.level) ||
  (typeof LEVELS !== "undefined" ? LEVELS[0].id : "univ");

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
  return [...review, ...fresh, ...mastered].slice(0, ROUND_WORD_COUNT);
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
  for (const w of roundWords) {
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
  $("#words-left").textContent = String(roundWords.length);
  $("#play-area").querySelectorAll(".falling-word, .float-score").forEach((el) => el.remove());
  buildLaneAnswers();
  for (let lane = 0; lane < LANES.length; lane++) renderLaneChoices(lane, null);
  updateComboDisplay();
  showScreen("#screen-game");
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

  // 出現(レーンを順番に回して時間差で落とす)
  while (
    game.spawnedCount < roundWords.length &&
    elapsed >= game.spawnedCount * SPAWN_INTERVAL
  ) {
    spawnWord(roundWords[game.spawnedCount], game.spawnedCount % LANES.length, now);
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

  // 全単語を処理し終えたら終了
  if (
    game.spawnedCount >= roundWords.length &&
    game.falling.every((f) => f.resolved)
  ) {
    endGame();
    return;
  }

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

    t.resolved = true;
    t.el.classList.remove("target");
    t.el.classList.add("pop");
    setTimeout(() => t.el.remove(), 300);
    updateWordsLeft();
  } else {
    btn.classList.add("wrong");
    btn.disabled = true;
    game.results.set(t.word.id, "wrong");
    game.combo = 0;
    updateComboDisplay();
    addScore(SCORE_WRONG, t.el);
  }
}

function resolveMissed(f) {
  f.resolved = true;
  game.results.set(f.word.id, "missed");
  game.combo = 0;
  updateComboDisplay();
  addScore(SCORE_MISSED, f.el);
  f.el.classList.remove("target");
  f.el.classList.add("crash");
  setTimeout(() => f.el.remove(), 350);
  updateWordsLeft();
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

function updateWordsLeft() {
  const done = game.falling.filter((f) => f.resolved).length;
  $("#words-left").textContent = String(roundWords.length - done);
}

function addScore(delta, nearEl, bonus) {
  game.score += delta;
  $("#score").textContent = String(game.score);
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
    } else {
      reviewSet.add(id);
      masteredSet.delete(id);
    }
  }
  saveIds(STORAGE_KEYS.review, reviewSet);
  saveIds(STORAGE_KEYS.mastered, masteredSet);

  const prevBest = highscores[selectedLevel] || 0;
  const isRecord = game.score > prevBest;
  if (isRecord) {
    highscores[selectedLevel] = game.score;
    localStorage.setItem(STORAGE_KEYS.highscore, JSON.stringify(highscores));
  }

  renderResult(isRecord);
  showScreen("#screen-result");
}

function renderResult(isRecord) {
  $("#result-score").textContent = String(game.score);

  const counts = { correct: 0, wrong: 0, missed: 0 };
  for (const r of game.results.values()) counts[r]++;
  $("#result-detail").innerHTML =
    `正解 ${counts.correct} / 不正解 ${counts.wrong} / 落下 ${counts.missed}` +
    (isRecord ? ' <span class="new-record">🎉 ハイスコア更新！</span>' : "");

  const labels = {
    correct: '<span class="badge badge-correct">正解</span>',
    wrong: '<span class="badge badge-wrong">不正解</span>',
    missed: '<span class="badge badge-missed">落下</span>',
  };
  const list = $("#result-list");
  list.innerHTML = "";
  // 間違えた単語を上に表示して復習しやすくする
  const order = { wrong: 0, missed: 1, correct: 2 };
  const entries = roundWords
    .filter((w) => game.results.has(w.id))
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
function renderLevelSelect() {
  const container = $("#level-select");
  container.innerHTML = "";
  for (const lv of LEVELS) {
    const btn = document.createElement("button");
    btn.className = "level-btn" + (lv.id === selectedLevel ? " active" : "");
    btn.dataset.level = lv.id;
    btn.innerHTML = `<span class="level-name">${lv.label}</span><span class="level-desc">${lv.desc}</span>`;
    btn.addEventListener("click", () => {
      selectedLevel = lv.id;
      localStorage.setItem(STORAGE_KEYS.level, selectedLevel);
      renderHome();
    });
    container.appendChild(btn);
  }
}

function renderHome() {
  renderLevelSelect();
  // 選択中レベルの単語だけで集計する
  const levelIds = WORDS.filter((w) => w.level === selectedLevel).map((w) => w.id);
  const total = levelIds.length;
  const mastered = levelIds.filter((id) => masteredSet.has(id)).length;
  const review = levelIds.filter((id) => reviewSet.has(id)).length;
  $("#stat-mastered").textContent = `${mastered}/${total}`;
  $("#stat-review").textContent = String(review);
  $("#stat-highscore").textContent = String(highscores[selectedLevel] || 0);
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
  if (!confirm("習得済み・復習待ち・ハイスコアの記録をすべて消します。よろしいですか？")) return;
  reviewSet = new Set();
  masteredSet = new Set();
  highscores = {};
  Object.values(STORAGE_KEYS).forEach((k) => localStorage.removeItem(k));
  renderHome();
});

renderHome();
