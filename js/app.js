/**
 * timu-card UI制御
 * - 打刻データは localStorage に保存（端末ごと）
 * - GAS_URL を設定するとスプレッドシートにも送信（未設定なら送信スキップ）
 */

// ===== 設定 =====
// Google Apps Script Web App のURL（スプレッドシート連携時に設定する）
const GAS_URL = "";

// QRゲート: QR読み取り後に打刻を許可する時間（ミリ秒）
const QR_VALID_MS = 5 * 60 * 1000;

// ===== ストレージ =====
const KEY_NAME = "timu_name";
const KEY_RECORDS = "timu_records"; // { "YYYY-MM-DD": { in: ISO, out: ISO } }
const KEY_PENDING = "timu_pending"; // GAS送信待ちキュー
const KEY_QR_UNTIL = "timu_qr_until"; // QR認証の有効期限（sessionStorage）

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
    qr: true, // QRゲート通過済みの打刻（ゲートなしでは打刻ボタンが押せない）
  });
  flushPending();
}

// ===== QRゲート =====
// 会社に掲示したワンタイムQR（display.html）を読み取らないと打刻できない
function qrVerified() {
  return Number(sessionStorage.getItem(KEY_QR_UNTIL) || 0) > Date.now();
}

async function initQrGate() {
  const token = new URLSearchParams(location.search).get("t");
  if (!token) return;

  const ok = await isValidToken(TIMU_SECRET, token, Date.now());
  if (ok) {
    sessionStorage.setItem(KEY_QR_UNTIL, String(Date.now() + QR_VALID_MS));
  } else {
    showMessage("QRコードの有効期限が切れています。最新のQRを読み取り直してください");
  }
  // トークン付きURLをブックマークさせないため、アドレスバーから消す
  history.replaceState(null, "", location.pathname);
}

// ===== DOM =====
const $ = (id) => document.getElementById(id);

const els = {
  date: $("date"),
  clock: $("clock"),
  qrNotice: $("qr-notice"),
  qrRemain: $("qr-remain"),
  nameEdit: $("name-edit"),
  nameView: $("name-view"),
  nameInput: $("name-input"),
  nameText: $("name-text"),
  saveName: $("save-name"),
  changeName: $("change-name"),
  punchBtn: $("punch-btn"),
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

/** 今日の状態から次の打刻種別を判定: "in"=出勤待ち / "out"=退勤待ち / "done"=完了 */
function nextPunchMode() {
  const rec = loadRecords()[todayKey()] || {};
  if (!rec.in) return "in";
  if (!rec.out) return "out";
  return "done";
}

function renderPunchButtons() {
  const hasName = !!getName() && els.nameView.classList.contains("hidden") === false;
  const verified = qrVerified();
  const mode = nextPunchMode();

  els.punchBtn.classList.remove("in", "out", "done");
  els.punchBtn.classList.add(mode);
  els.punchBtn.textContent = mode === "in" ? "出勤" : mode === "out" ? "退勤" : "退勤済";
  els.punchBtn.disabled = mode === "done" || !hasName || !verified;
}

// QRゲートの案内表示（認証済みなら残り時間、未認証なら読み取り案内）
function renderQrNotice() {
  const verified = qrVerified();
  els.qrNotice.classList.toggle("verified", verified);
  if (verified) {
    const remainSec = Math.ceil((Number(sessionStorage.getItem(KEY_QR_UNTIL)) - Date.now()) / 1000);
    const mm = Math.floor(remainSec / 60);
    const ss = String(remainSec % 60).padStart(2, "0");
    els.qrRemain.textContent = `✅ QR認証済み（あと ${mm}:${ss} 打刻できます）`;
  } else {
    els.qrRemain.textContent = "🔒 会社のQRコードを読み取ると打刻できます";
  }
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

// 1ボタン自動判定: 未出勤なら出勤、出勤済みなら退勤として記録
els.punchBtn.addEventListener("click", () => {
  const now = new Date();
  const records = loadRecords();
  const key = todayKey(now);
  const mode = nextPunchMode();

  if (mode === "in") {
    records[key] = records[key] || {};
    records[key].in = now.toISOString();
    saveRecords(records);
    sendPunch(getName(), "in", now);
    showMessage(`おはようございます。${timeLabel(records[key].in)} 出勤を記録しました`);
  } else if (mode === "out") {
    records[key].out = now.toISOString();
    saveRecords(records);
    sendPunch(getName(), "out", now);
    const r = calcDay(toMinutes(new Date(records[key].in)), toMinutes(now));
    let text = `お疲れさまでした。実働 ${formatMinutes(r.work)}`;
    if (r.overtime > 0) text += `（残業 ${formatMinutes(r.overtime)}）`;
    showMessage(text);
  }
  renderAll();
});

// ===== 初期化 =====
function renderAll() {
  renderName();
  renderStatus();
  renderHistory();
  renderQrNotice();
}

(async () => {
  tickClock();
  setInterval(tickClock, 1000);
  await initQrGate();
  renderAll();
  // QR認証の期限切れを即時反映する（残り時間表示とボタン状態）
  setInterval(() => {
    renderQrNotice();
    renderPunchButtons();
  }, 1000);
  flushPending();
})();
