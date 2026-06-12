/**
 * timu-card バックエンド（Google Apps Script）
 *
 * セットアップ手順は リポジトリの README.md を参照。
 * このファイルをスプレッドシート「タイムカード」の Apps Script に貼り付けて
 * ウェブアプリとしてデプロイする。
 *
 * 機能:
 * - doPost: 打刻を受信して「打刻ログ」シートに記録（QRトークンをサーバー側でも検証）
 * - monthlyAggregate: 前月の就業時間を「月次集計」シートに出力（毎月1日トリガー）
 * - setupMonthlyTrigger: 月次トリガーの登録（最初に1回だけ手動実行する）
 */

// ===== 設定（js/config.js・js/token.js と一致させること） =====
const SECRET = "323a470aa3d2c6166a7aa6325941548f";
const TOKEN_LEN = 10;
const WINDOW_SEC = 60;
const TOKEN_GRACE = 8; // QR読取→打刻まで最大5分+余裕を見て8分前の窓まで許容
const TZ = "Asia/Tokyo";

// ===== 勤務ルール（js/timecard.js と同一） =====
const RULES = {
  START_MIN: 8 * 60,    // 定時開始 8:00
  END_MIN: 17 * 60,     // 定時終了 17:00
  LUNCH_START: 12 * 60, // 休憩開始 12:00
  LUNCH_END: 13 * 60,   // 休憩終了 13:00
  ROUND_UNIT: 15,       // 丸め単位（分）
};

const SHEET_LOG = "打刻ログ";
const SHEET_MONTHLY = "月次集計";
const LOG_HEADERS = ["日付", "氏名", "種別", "時刻", "ISO時刻", "QR検証", "受信日時"];
const MONTHLY_HEADERS = ["対象月", "氏名", "出勤日数", "実働合計(h)", "早出合計(h)", "残業合計(h)", "打刻不備日数", "集計日時"];

// ===== Webアプリ入口 =====

function doGet() {
  return ContentService.createTextOutput("timu-card API OK");
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const verified = isValidToken_(String(data.token || ""), Date.now());
    const t = new Date(data.time);
    const sheet = getOrCreateSheet_(SHEET_LOG, LOG_HEADERS);
    sheet.appendRow([
      data.date,
      data.name,
      data.type === "in" ? "出勤" : "退勤",
      Utilities.formatDate(t, TZ, "HH:mm:ss"),
      data.time,
      verified ? "○" : "×", // ×はQR検証に通らなかった打刻（要確認）
      new Date(),
    ]);
    return json_({ ok: true, verified });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ===== QRトークン検証（js/token.js と同じロジック） =====

function sha256Hex_(text) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(function (b) {
    return ((b + 256) % 256).toString(16).padStart(2, "0");
  }).join("");
}

function isValidToken_(token, epochMs) {
  if (!token) return false;
  for (let off = 0; off >= -TOKEN_GRACE; off--) {
    const win = Math.floor(epochMs / 1000 / WINDOW_SEC) + off;
    if (token === sha256Hex_(SECRET + "|" + win).slice(0, TOKEN_LEN)) return true;
  }
  return false;
}

// ===== シート =====

function getOrCreateSheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  }
  return sh;
}

// ===== 勤怠計算（js/timecard.js と同一ロジック） =====

function calcEarly_(inMin) {
  if (inMin >= RULES.START_MIN) return 0;
  return Math.floor((RULES.START_MIN - inMin) / RULES.ROUND_UNIT) * RULES.ROUND_UNIT;
}

function calcOvertime_(outMin) {
  if (outMin <= RULES.END_MIN) return 0;
  return Math.floor((outMin - RULES.END_MIN) / RULES.ROUND_UNIT) * RULES.ROUND_UNIT;
}

function calcLunchOverlap_(inMin, outMin) {
  const start = Math.max(inMin, RULES.LUNCH_START);
  const end = Math.min(outMin, RULES.LUNCH_END);
  return Math.max(0, end - start);
}

/** ISO文字列 → 日本時間での0:00からの経過分 */
function isoToMinutes_(iso) {
  const parts = Utilities.formatDate(new Date(iso), TZ, "HH:mm").split(":");
  return Number(parts[0]) * 60 + Number(parts[1]);
}

// ===== 月次集計 =====

/** 毎月1日のトリガーから実行: 前月分を集計 */
function monthlyAggregate() {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  aggregateMonth(prev.getFullYear(), prev.getMonth() + 1);
}

/** 指定年月を集計して「月次集計」へ出力（再実行しても同月分は上書き） */
function aggregateMonth(year, month) {
  const prefix = year + "-" + String(month).padStart(2, "0");
  const logSheet = getOrCreateSheet_(SHEET_LOG, LOG_HEADERS);
  const rows = logSheet.getDataRange().getValues().slice(1);

  // (氏名|日付) ごとに 出勤=最早打刻 / 退勤=最遅打刻 を採用
  const days = {};
  rows.forEach(function (r) {
    const dateStr = r[0] instanceof Date ? Utilities.formatDate(r[0], TZ, "yyyy-MM-dd") : String(r[0]);
    if (dateStr.indexOf(prefix) !== 0) return;
    const name = String(r[1]);
    const type = String(r[2]);
    const minutes = isoToMinutes_(String(r[4]));
    const key = name + "|" + dateStr;
    days[key] = days[key] || { name: name, inMin: null, outMin: null };
    if (type === "出勤" && (days[key].inMin === null || minutes < days[key].inMin)) days[key].inMin = minutes;
    if (type === "退勤" && (days[key].outMin === null || minutes > days[key].outMin)) days[key].outMin = minutes;
  });

  // 氏名ごとに合算
  const totals = {};
  Object.keys(days).forEach(function (key) {
    const d = days[key];
    const t = (totals[d.name] = totals[d.name] || { days: 0, work: 0, early: 0, overtime: 0, broken: 0 });
    if (d.inMin === null || d.outMin === null || d.outMin < d.inMin) {
      t.broken++; // 出勤・退勤がそろっていない日（管理者がログを確認して修正）
      return;
    }
    t.days++;
    t.work += d.outMin - d.inMin - calcLunchOverlap_(d.inMin, d.outMin);
    t.early += calcEarly_(d.inMin);
    t.overtime += calcOvertime_(d.outMin);
  });

  // 同月の既存行を消してから書き込み（再実行に対応）
  const outSheet = getOrCreateSheet_(SHEET_MONTHLY, MONTHLY_HEADERS);
  const label = year + "年" + month + "月";
  const existing = outSheet.getDataRange().getValues();
  for (let i = existing.length - 1; i >= 1; i--) {
    if (String(existing[i][0]) === label) outSheet.deleteRow(i + 1);
  }

  const toHours = function (min) { return Math.round((min / 60) * 100) / 100; };
  Object.keys(totals).sort().forEach(function (name) {
    const t = totals[name];
    outSheet.appendRow([label, name, t.days, toHours(t.work), toHours(t.early), toHours(t.overtime), t.broken, new Date()]);
  });
}

// ===== トリガー登録（セットアップ時に1回だけ手動実行） =====

function setupMonthlyTrigger() {
  // 二重登録防止
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "monthlyAggregate") ScriptApp.deleteTrigger(t);
  });
  // 毎月1日 6〜7時に前月分を集計
  ScriptApp.newTrigger("monthlyAggregate").timeBased().onMonthDay(1).atHour(6).create();
}
