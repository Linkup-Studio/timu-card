/**
 * timu-card UI制御
 * - 打刻データは localStorage に保存（端末ごと）
 * - GAS_URL を設定するとスプレッドシートにも送信（未設定なら送信スキップ）
 */

// ===== 設定 =====
// Google Apps Script Web App のURL（スプレッドシート連携時に設定する）
const GAS_URL = "";

// ===== ストレージ =====
const KEY_NAME = "timu_name";
const KEY_RECORDS = "timu_records"; // { "YYYY-MM-DD": { in: ISO, out: ISO } }
const KEY_PENDING = "timu_pending"; // GAS送信待ちキュー

function loadRecords() {
  try {
    return JSON.parse(localStorage.getItem(KEY_RECORDS)) || {};
  } catch {
    return {};
  }
}

function saveRecords(records) {
  localStorage.setItem(KEY_RECORDS, JSON.stringify(records));
}

function todayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ===== GAS連携（連携前はキューに溜めるだけ） =====
function queuePending(entry) {
  let queue;
  try {
    queue = JSON.parse(localStorage.getItem(KEY_PENDING)) || [];
  } catch {
    queue = [];
  }
  queue.push(entry);
  localStorage.setItem(KEY_PENDING, JSON.stringify(queue));
}

async function flushPending() {
  if (!GAS_URL) return;
  let queue;
  try {
    queue = JSON.parse(localStorage.getItem(KEY_PENDING)) || [];
  } catch {
    queue = [];
  }
  const remaining = [];
  for (const entry of queue) {
    try {
      await fetch(GAS_URL, {
        method: "POST",
        body: JSON.stringify(entry),
      });
    } catch {
      remaining.push(entry); // 送信失敗分は次回再送
    }
  }
  localStorage.setItem(KEY_PENDING, JSON.stringify(remaining));
}

function sendPunch(name, type, date) {
  queuePending({
    name,
    type, // "in" | "out"
    date: todayKey(date),
    time: date.toISOString(),
  });
  flushPending();
}

// ===== DOM =====
const $ = (id) => document.getElementById(id);

const els = {
  date: $("date"),
  clock: $("clock"),
  nameEdit: $("name-edit"),
  nameView: $("name-view"),
  nameInput: $("name-input"),
  nameText: $("name-text"),
  saveName: $("save-name"),
  changeName: $("change-name"),
  punchIn: $("punch-in"),
  punchOut: $("punch-out"),
  message: $("message"),
  statusIn: $("status-in"),
  statusOut: $("status-out"),
  statusWork: $("status-work"),
  statusExtra: $("status-extra"),
  historyBody: $("history-body"),
  historyEmpty: $("history-empty"),
};

// ===== 時計 =====
function tickClock() {
  const now = new Date();
  const days = ["日", "月", "火", "水", "木", "金", "土"];
  els.date.textContent = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日（${days[now.getDay()]}）`;
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  els.clock.innerHTML = `${hh}:${mm}<span class="sec">:${ss}</span>`;
}

// ===== 名前 =====
function getName() {
  return localStorage.getItem(KEY_NAME) || "";
}

function renderName() {
  const name = getName();
  if (name) {
    els.nameText.textContent = name;
    els.nameEdit.classList.add("hidden");
    els.nameView.classList.remove("hidden");
  } else {
    els.nameEdit.classList.remove("hidden");
    els.nameView.classList.add("hidden");
  }
  renderPunchButtons();
}

els.saveName.addEventListener("click", () => {
  const name = els.nameInput.value.trim();
  if (!name) {
    showMessage("名前を入力してください");
    return;
  }
  localStorage.setItem(KEY_NAME, name);
  renderName();
  showMessage(`${name} さん、登録しました`);
});

els.changeName.addEventListener("click", () => {
  els.nameInput.value = getName();
  els.nameEdit.classList.remove("hidden");
  els.nameView.classList.add("hidden");
  renderPunchButtons();
});

// ===== メッセージ =====
let messageTimer = null;
function showMessage(text) {
  els.message.textContent = text;
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => {
    els.message.textContent = "";
  }, 4000);
}

// ===== 打刻 =====
function timeLabel(iso) {
  if (!iso) return "--:--";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function renderPunchButtons() {
  const hasName = !!getName() && els.nameView.classList.contains("hidden") === false;
  const rec = loadRecords()[todayKey()] || {};
  els.punchIn.disabled = !hasName || !!rec.in;
  els.punchOut.disabled = !hasName || !rec.in || !!rec.out;
}

function renderStatus() {
  const rec = loadRecords()[todayKey()] || {};
  els.statusIn.textContent = timeLabel(rec.in);
  els.statusOut.textContent = timeLabel(rec.out);

  if (rec.in && rec.out) {
    const result = calcDay(toMinutes(new Date(rec.in)), toMinutes(new Date(rec.out)));
    els.statusWork.textContent = formatMinutes(result.work);
    const extras = [];
    if (result.early > 0) extras.push(`早出 ${formatMinutes(result.early)}`);
    if (result.overtime > 0) extras.push(`残業 ${formatMinutes(result.overtime)}`);
    els.statusExtra.textContent = extras.length ? extras.join(" / ") : "なし";
  } else {
    els.statusWork.textContent = "--:--";
    els.statusExtra.textContent = "--";
  }
}

function renderHistory() {
  const records = loadRecords();
  const keys = Object.keys(records).sort().reverse().slice(0, 14);
  els.historyBody.innerHTML = "";

  const rows = keys
    .filter((key) => key !== todayKey() || (records[key].in && records[key].out))
    .map((key) => {
      const rec = records[key];
      let work = "--:--";
      let extra = "";
      if (rec.in && rec.out) {
        const r = calcDay(toMinutes(new Date(rec.in)), toMinutes(new Date(rec.out)));
        work = formatMinutes(r.work);
        const parts = [];
        if (r.early > 0) parts.push(`早${formatMinutes(r.early)}`);
        if (r.overtime > 0) parts.push(`残${formatMinutes(r.overtime)}`);
        extra = parts.join(" ");
      }
      const [, m, d] = key.split("-");
      return `<tr><td>${Number(m)}/${Number(d)}</td><td>${timeLabel(rec.in)}</td><td>${timeLabel(rec.out)}</td><td>${work}</td><td>${extra}</td></tr>`;
    });

  els.historyBody.innerHTML = rows.join("");
  els.historyEmpty.classList.toggle("hidden", rows.length > 0);
}

els.punchIn.addEventListener("click", () => {
  const now = new Date();
  const records = loadRecords();
  const key = todayKey(now);
  records[key] = records[key] || {};
  if (records[key].in) return;
  records[key].in = now.toISOString();
  saveRecords(records);
  sendPunch(getName(), "in", now);
  showMessage(`おはようございます。${timeLabel(records[key].in)} 出勤を記録しました`);
  renderAll();
});

els.punchOut.addEventListener("click", () => {
  const now = new Date();
  const records = loadRecords();
  const key = todayKey(now);
  if (!records[key] || !records[key].in || records[key].out) return;
  records[key].out = now.toISOString();
  saveRecords(records);
  sendPunch(getName(), "out", now);

  const r = calcDay(toMinutes(new Date(records[key].in)), toMinutes(now));
  let text = `お疲れさまでした。実働 ${formatMinutes(r.work)}`;
  if (r.overtime > 0) text += `（残業 ${formatMinutes(r.overtime)}）`;
  showMessage(text);
  renderAll();
});

// ===== 初期化 =====
function renderAll() {
  renderName();
  renderStatus();
  renderHistory();
}

tickClock();
setInterval(tickClock, 1000);
renderAll();
flushPending();
