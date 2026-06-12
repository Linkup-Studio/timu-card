/**
 * timu-card 勤怠計算ロジック（純粋関数のみ・UI非依存）
 *
 * 勤務ルール:
 * - 定時: 8:00〜17:00
 * - 休憩: 12:00〜13:00（1時間）
 * - 早出: 8:00より前の出勤分（15分単位・切り捨て）
 * - 残業: 17:00以降の退勤分（15分単位・切り捨て）
 * - 打刻は実時刻を記録し、計算時に丸める
 */

const RULES = {
  START_MIN: 8 * 60,    // 定時開始 8:00
  END_MIN: 17 * 60,     // 定時終了 17:00
  LUNCH_START: 12 * 60, // 休憩開始 12:00
  LUNCH_END: 13 * 60,   // 休憩終了 13:00
  ROUND_UNIT: 15,       // 丸め単位（分）
};

/** Date → その日の0:00からの経過分 */
function toMinutes(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/** 分 → "H:MM" 表記 */
function formatMinutes(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

/** 早出時間（分）: 8:00前の出勤分を15分単位で切り捨て */
function calcEarly(inMin) {
  if (inMin >= RULES.START_MIN) return 0;
  const raw = RULES.START_MIN - inMin;
  return Math.floor(raw / RULES.ROUND_UNIT) * RULES.ROUND_UNIT;
}

/** 残業時間（分）: 17:00以降の退勤分を15分単位で切り捨て */
function calcOvertime(outMin) {
  if (outMin <= RULES.END_MIN) return 0;
  const raw = outMin - RULES.END_MIN;
  return Math.floor(raw / RULES.ROUND_UNIT) * RULES.ROUND_UNIT;
}

/** 休憩（12:00〜13:00）と勤務時間帯の重なり（分） */
function calcLunchOverlap(inMin, outMin) {
  const start = Math.max(inMin, RULES.LUNCH_START);
  const end = Math.min(outMin, RULES.LUNCH_END);
  return Math.max(0, end - start);
}

/**
 * 1日分の勤怠を計算
 * @param {number} inMin  出勤時刻（0:00からの分）
 * @param {number} outMin 退勤時刻（0:00からの分）
 * @param {boolean} isEarly 早出打刻か。falseの場合、8:00前の出勤は8:00から勤務扱い・早出なし
 * @returns {{ work: number, early: number, overtime: number, lunch: number }}
 *          work=実働（休憩控除後・分）, early=早出（分）, overtime=残業（分）
 */
function calcDay(inMin, outMin, isEarly = false) {
  if (outMin < inMin) {
    throw new Error("退勤時刻が出勤時刻より前です");
  }
  // 早出でなければ8:00より前は勤務に含めない（8:00前退勤の場合の逆転も防ぐ）
  const effIn = isEarly ? inMin : Math.min(Math.max(inMin, RULES.START_MIN), outMin);
  const lunch = calcLunchOverlap(effIn, outMin);
  return {
    work: outMin - effIn - lunch,
    early: isEarly ? calcEarly(inMin) : 0,
    overtime: calcOvertime(outMin),
    lunch,
  };
}

// Node.js（テスト実行時）用エクスポート。ブラウザではグローバル定義のまま使う
if (typeof module !== "undefined" && module.exports) {
  module.exports = { RULES, toMinutes, formatMinutes, calcEarly, calcOvertime, calcLunchOverlap, calcDay };
}
