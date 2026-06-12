/**
 * timu-card バックエンド（Google Apps Script）
 *
 * セットアップ手順は リポジトリの README.md を参照。
 *
 * スプレッドシート「タイムカード記録」1冊にすべて集約:
 * - カレンダー型シート（月ごと） … 打刻が日付×氏名のセルに記入される
 * - 打刻ログ … 生ログ（QR検証○×つき・監査用）
 * - 月次集計 … 毎月1日トリガーで前月分を自動出力
 *   ※集計はカレンダー型シートを読むので、管理者がセルを直接修正すればそのまま反映される
 * - setupMonthlyTrigger: 月次トリガーの登録（最初に1回だけ実行する）
 */

// ===== 設定（js/config.js・js/token.js と一致させること） =====
const SECRET = "323a470aa3d2c6166a7aa6325941548f";
const TOKEN_LEN = 10;
const WINDOW_SEC = 60;
const TOKEN_GRACE = 8; // QR読取→打刻まで最大5分+余裕を見て8分前の窓まで許容
const TZ = "Asia/Tokyo";

// 運用スプレッドシート（カレンダー型タイムカード）のID
const TIMECARD_SS_ID = "1SlY9CX7vSD6Rog0q9CyEM39WN9-LHi1ezFTkDer61Co";

// カレンダー型シートのレイアウト
const GRID = {
  TITLE_CELL_ROW: 1,   // 「タイムカード記録 (YYYY年M月)」の行
  NAME_ROW: 2,         // 従業員名の行（出勤列に名前、退勤列は結合で空）
  TYPE_ROW: 3,         // 出勤/退勤 の行
  FIRST_DAY_ROW: 4,    // 1日の行
  DATE_COL: 1,         // A列 = 日付
  WEEKDAY_COL: 2,      // B列 = 曜日
  FIRST_NAME_COL: 3,   // C列 = 最初の従業員の出勤列
};

const WEEKDAYS_JP = ["日", "月", "火", "水", "木", "金", "土"];

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
const LOG_HEADERS = ["日付", "氏名", "種別", "時刻", "ISO時刻", "QR検証", "受信日時", "備考"];
const MONTHLY_HEADERS = ["対象月", "氏名", "出勤日数", "実働合計(h)", "早出合計(h)", "残業合計(h)", "打刻不備日数", "集計日時"];

// ===== Webアプリ入口 =====

function doGet(e) {
  const p = (e && e.parameter) || {};
  // /exec?setup=1 にアクセスすると月次トリガーを登録（セットアップ用）
  if (p.setup === "1") {
    setupMonthlyTrigger();
    return ContentService.createTextOutput("monthly trigger OK");
  }
  // /exec?aggregate=YYYY-MM&key=SECRET で指定月を手動再集計（シート修正後に使う）
  if (p.aggregate && p.key === SECRET) {
    const m = String(p.aggregate).match(/^(\d{4})-(\d{1,2})$/);
    if (!m) return ContentService.createTextOutput("aggregate は YYYY-MM 形式で指定してください");
    aggregateMonth(Number(m[1]), Number(m[2]));
    return ContentService.createTextOutput("aggregate OK: " + p.aggregate);
  }
  return ContentService.createTextOutput("timu-card API OK");
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const verified = isValidToken_(String(data.token || ""), Date.now());
    const t = new Date(data.time);

    // 1. 運用シート（カレンダー型）へ記入
    let gridNote = "";
    try {
      gridNote = writeToGrid_(data);
    } catch (err) {
      gridNote = "グリッド記入エラー: " + String(err);
    }

    // 2. 生ログ（監査用・同じスプレッドシートの「打刻ログ」タブ）
    const sheet = getOrCreateSheet_(openTimecard_(), SHEET_LOG, LOG_HEADERS);
    sheet.appendRow([
      data.date,
      data.name,
      data.type === "in" ? "出勤" : "退勤",
      Utilities.formatDate(t, TZ, "HH:mm:ss"),
      data.time,
      verified ? "○" : "×", // ×はQR検証に通らなかった打刻（要確認）
      new Date(),
      gridNote,
    ]);

    return json_({ ok: true, verified: verified, grid: gridNote });
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

// ===== カレンダー型シートへの記入 =====

/**
 * 打刻をカレンダー型シートの該当セルに記入する
 * @returns {string} 結果メモ（"記入OK" / 氏名不一致などの注意）
 */
function writeToGrid_(data) {
  const parts = String(data.date).split("-"); // "YYYY-MM-DD"
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);

  const ss = openTimecard_();
  const sheet = findMonthSheet_(ss, year, month) || createMonthSheet_(ss, year, month);

  // 氏名 → 列（NAME_ROW の値と完全一致。出勤列に名前が入っている前提）
  const lastCol = sheet.getLastColumn();
  const names = sheet.getRange(GRID.NAME_ROW, 1, 1, lastCol).getDisplayValues()[0];
  let nameCol = -1;
  for (let c = GRID.FIRST_NAME_COL - 1; c < names.length; c++) {
    if (names[c].trim() === String(data.name).trim()) {
      nameCol = c + 1;
      break;
    }
  }
  if (nameCol === -1) {
    return "氏名「" + data.name + "」がシート" + GRID.NAME_ROW + "行目に見つかりません（生ログのみ記録）";
  }

  const col = data.type === "in" ? nameCol : nameCol + 1;
  const row = GRID.FIRST_DAY_ROW + day - 1;
  const newTime = Utilities.formatDate(new Date(data.time), TZ, "HH:mm");
  const cell = sheet.getRange(row, col);
  const existing = cell.getDisplayValue().trim();

  // 同じ日に複数打刻された場合: 出勤=早い方 / 退勤=遅い方 を採用
  if (existing) {
    const keepExisting =
      data.type === "in" ? compareTime_(existing, newTime) <= 0 : compareTime_(existing, newTime) >= 0;
    if (keepExisting) return "既存値" + existing + "を維持";
  }
  cell.setNumberFormat("@").setValue(newTime);
  return "記入OK";
}

/** "H:mm"/"HH:mm" 同士の比較（-1: aが早い, 0: 同じ, 1: aが遅い） */
function compareTime_(a, b) {
  const am = parseTimeStr_(a);
  const bm = parseTimeStr_(b);
  if (am === null || bm === null) return 0;
  return am === bm ? 0 : am < bm ? -1 : 1;
}

/** "H:mm" → 0:00からの分。解釈できなければ null */
function parseTimeStr_(s) {
  const m = String(s).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 運用スプレッドシートを開く（タイムゾーンが日本時間でなければ修正） */
function openTimecard_() {
  const ss = SpreadsheetApp.openById(TIMECARD_SS_ID);
  if (ss.getSpreadsheetTimeZone() !== TZ) ss.setSpreadsheetTimeZone(TZ);
  return ss;
}

/** カレンダー型シート（1行目に「タイムカード記録」がある）だけを対象にする */
function isGridSheet_(sheet) {
  if (sheet.getLastRow() < GRID.FIRST_DAY_ROW) return false;
  const titleRow = sheet
    .getRange(GRID.TITLE_CELL_ROW, 1, 1, Math.max(1, sheet.getLastColumn()))
    .getDisplayValues()[0]
    .join("");
  return titleRow.indexOf("タイムカード記録") !== -1;
}

/** 「タイムカード記録 (YYYY年M月)」のタイトルを持つシートを探す */
function findMonthSheet_(ss, year, month) {
  const label = year + "年" + month + "月";
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    const titleRow = sheets[i]
      .getRange(GRID.TITLE_CELL_ROW, 1, 1, Math.max(1, sheets[i].getLastColumn()))
      .getDisplayValues()[0]
      .join("");
    if (titleRow.indexOf(label) !== -1) return sheets[i];
  }
  return null;
}

/**
 * 月のシートがなければ、既存の最初のカレンダー型シートを複製して作る
 * （日付・曜日・タイトルを新しい月に書き換え、打刻セルはクリア）
 */
function createMonthSheet_(ss, year, month) {
  // カレンダー型のシートをテンプレートにする（月次集計などが先頭に来ても壊れないように）
  const template = ss.getSheets().filter(isGridSheet_)[0];
  if (!template) throw new Error("テンプレートになるカレンダー型シートが見つかりません");
  const sheet = template.copyTo(ss);
  sheet.setName(year + "年" + month + "月");
  ss.setActiveSheet(sheet);
  ss.moveActiveSheet(ss.getNumSheets());

  const daysInMonth = new Date(year, month, 0).getDate();
  const lastCol = sheet.getLastColumn();

  // タイトル書き換え（1行目のどこかにある「(YYYY年M月)」を更新）
  const titleRange = sheet.getRange(GRID.TITLE_CELL_ROW, 1, 1, lastCol);
  const titleVals = titleRange.getDisplayValues()[0];
  for (let c = 0; c < titleVals.length; c++) {
    if (titleVals[c].indexOf("タイムカード記録") !== -1) {
      sheet.getRange(GRID.TITLE_CELL_ROW, c + 1).setValue("タイムカード記録 (" + year + "年" + month + "月)");
      break;
    }
  }

  // テンプレートの日数（FIRST_DAY_ROW以降でA列に「n日」がある行数）
  const colA = sheet.getRange(GRID.FIRST_DAY_ROW, GRID.DATE_COL, sheet.getLastRow() - GRID.FIRST_DAY_ROW + 1, 1).getDisplayValues();
  let templateDays = 0;
  for (let r = 0; r < colA.length; r++) {
    if (/^\d{1,2}日$/.test(colA[r][0].trim())) templateDays++;
    else break;
  }

  // 行数調整（31日の月 vs 30日のテンプレート等）
  if (daysInMonth > templateDays) {
    const srcRow = GRID.FIRST_DAY_ROW + templateDays - 1;
    for (let i = 0; i < daysInMonth - templateDays; i++) {
      sheet.insertRowAfter(srcRow + i);
      sheet.getRange(srcRow + i, 1, 1, lastCol).copyTo(sheet.getRange(srcRow + i + 1, 1, 1, lastCol));
    }
  } else if (daysInMonth < templateDays) {
    sheet.deleteRows(GRID.FIRST_DAY_ROW + daysInMonth, templateDays - daysInMonth);
  }

  // 日付・曜日を書き換え、打刻セルをクリア
  for (let d = 1; d <= daysInMonth; d++) {
    const row = GRID.FIRST_DAY_ROW + d - 1;
    sheet.getRange(row, GRID.DATE_COL).setValue(d + "日");
    sheet.getRange(row, GRID.WEEKDAY_COL).setValue(WEEKDAYS_JP[new Date(year, month - 1, d).getDay()]);
  }
  sheet.getRange(GRID.FIRST_DAY_ROW, GRID.FIRST_NAME_COL, daysInMonth, lastCol - GRID.FIRST_NAME_COL + 1).clearContent();

  return sheet;
}

// ===== シート =====

function getOrCreateSheet_(ss, name, headers) {
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

// ===== 月次集計（カレンダー型シートを読んで計算） =====

/** 毎月1日のトリガーから実行: 前月分を集計 */
function monthlyAggregate() {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  aggregateMonth(prev.getFullYear(), prev.getMonth() + 1);
}

/**
 * 指定年月のカレンダー型シートを集計して「月次集計」へ出力
 * （再実行しても同月分は上書き。シートの手修正もそのまま反映される）
 */
function aggregateMonth(year, month) {
  const ss = openTimecard_();
  const sheet = findMonthSheet_(ss, year, month);
  if (!sheet) throw new Error(year + "年" + month + "月のシートが見つかりません");

  const lastCol = sheet.getLastColumn();
  const daysInMonth = new Date(year, month, 0).getDate();
  const names = sheet.getRange(GRID.NAME_ROW, 1, 1, lastCol).getDisplayValues()[0];
  const grid = sheet.getRange(GRID.FIRST_DAY_ROW, 1, daysInMonth, lastCol).getDisplayValues();

  const results = [];
  for (let c = GRID.FIRST_NAME_COL - 1; c < lastCol; c++) {
    const name = names[c].trim();
    if (!name) continue; // 退勤列（結合の空セル）はスキップ
    const t = { days: 0, work: 0, early: 0, overtime: 0, broken: 0 };
    for (let r = 0; r < daysInMonth; r++) {
      const inMin = parseTimeStr_(grid[r][c]);
      const outMin = parseTimeStr_(grid[r][c + 1]);
      if (inMin === null && outMin === null) continue; // 休み
      if (inMin === null || outMin === null || outMin < inMin) {
        t.broken++; // 出勤・退勤がそろっていない日（シートを修正して再集計）
        continue;
      }
      t.days++;
      t.work += outMin - inMin - calcLunchOverlap_(inMin, outMin);
      t.early += calcEarly_(inMin);
      t.overtime += calcOvertime_(outMin);
    }
    results.push({ name: name, t: t });
  }

  // 同月の既存行を消してから書き込み（再実行に対応）
  // ※「2026年6月」はシートに日付型として解釈されることがあるため、表示値で比較する
  const outSheet = getOrCreateSheet_(ss, SHEET_MONTHLY, MONTHLY_HEADERS);
  const label = year + "年" + month + "月";
  const existing = outSheet.getDataRange().getDisplayValues();
  for (let i = existing.length - 1; i >= 1; i--) {
    if (existing[i][0].trim() === label) outSheet.deleteRow(i + 1);
  }

  const toHours = function (min) { return Math.round((min / 60) * 100) / 100; };
  results.forEach(function (r) {
    outSheet.appendRow([label, r.name, r.t.days, toHours(r.t.work), toHours(r.t.early), toHours(r.t.overtime), r.t.broken, new Date()]);
  });
}

// ===== トリガー登録（セットアップ時に1回だけ実行） =====

function setupMonthlyTrigger() {
  // 二重登録防止
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "monthlyAggregate") ScriptApp.deleteTrigger(t);
  });
  // 毎月1日 6〜7時に前月分を集計
  ScriptApp.newTrigger("monthlyAggregate").timeBased().onMonthDay(1).atHour(6).create();
}
