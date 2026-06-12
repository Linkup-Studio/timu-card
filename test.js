/**
 * 勤怠計算ロジックのテスト
 * 実行: node test.js
 */
const { calcEarly, calcOvertime, calcLunchOverlap, calcDay, formatMinutes } = require("./js/timecard.js");

let passed = 0;
let failed = 0;

function eq(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const min = (h, m = 0) => h * 60 + m;

console.log("【早出】8:00前の出勤分・15分単位切り捨て");
eq("8:00ちょうど出勤 → 早出なし", calcEarly(min(8, 0)), 0);
eq("7:50出勤（10分前）→ 切り捨てで0分", calcEarly(min(7, 50)), 0);
eq("7:45出勤（15分前）→ 15分", calcEarly(min(7, 45)), 15);
eq("7:40出勤（20分前）→ 15分", calcEarly(min(7, 40)), 15);
eq("7:00出勤（60分前）→ 60分", calcEarly(min(7, 0)), 60);
eq("6:29出勤（91分前）→ 90分", calcEarly(min(6, 29)), 90);
eq("8:30出勤（遅刻）→ 早出なし", calcEarly(min(8, 30)), 0);

console.log("【残業】17:00以降の退勤分・15分単位切り捨て");
eq("17:00ちょうど退勤 → 残業なし", calcOvertime(min(17, 0)), 0);
eq("17:14退勤 → 切り捨てで0分", calcOvertime(min(17, 14)), 0);
eq("17:15退勤 → 15分", calcOvertime(min(17, 15)), 15);
eq("17:50退勤 → 45分", calcOvertime(min(17, 50)), 45);
eq("19:00退勤 → 120分", calcOvertime(min(19, 0)), 120);
eq("16:30退勤（早退）→ 残業なし", calcOvertime(min(16, 30)), 0);

console.log("【休憩控除】12:00〜13:00との重なり");
eq("8:00〜17:00 → 休憩60分", calcLunchOverlap(min(8), min(17)), 60);
eq("8:00〜12:30 → 重なり30分", calcLunchOverlap(min(8), min(12, 30)), 30);
eq("8:00〜11:00（午前のみ）→ 0分", calcLunchOverlap(min(8), min(11)), 0);
eq("13:00〜17:00（午後のみ）→ 0分", calcLunchOverlap(min(13), min(17)), 0);
eq("12:15〜12:45（休憩内のみ）→ 30分", calcLunchOverlap(min(12, 15), min(12, 45)), 30);

console.log("【1日計算】実働＝退勤−出勤−休憩");
eq(
  "定時どおり 8:00〜17:00 → 実働480分(8h)・早出0・残業0",
  calcDay(min(8), min(17)),
  { work: 480, early: 0, overtime: 0, lunch: 60 }
);
eq(
  "7:40〜17:50 → 実働550分・早出15・残業45",
  calcDay(min(7, 40), min(17, 50)),
  { work: 550, early: 15, overtime: 45, lunch: 60 }
);
eq(
  "7:00〜19:00 → 実働660分(11h)・早出60・残業120",
  calcDay(min(7), min(19)),
  { work: 660, early: 60, overtime: 120, lunch: 60 }
);
eq(
  "9:00〜16:00（遅刻・早退）→ 実働360分・早出0・残業0",
  calcDay(min(9), min(16)),
  { work: 360, early: 0, overtime: 0, lunch: 60 }
);
eq(
  "8:00〜12:00（午前のみ）→ 実働240分・休憩控除なし",
  calcDay(min(8), min(12)),
  { work: 240, early: 0, overtime: 0, lunch: 0 }
);

console.log("【表示】formatMinutes");
eq("480分 → 8:00", formatMinutes(480), "8:00");
eq("550分 → 9:10", formatMinutes(550), "9:10");
eq("45分 → 0:45", formatMinutes(45), "0:45");
eq("0分 → 0:00", formatMinutes(0), "0:00");

console.log("【異常系】");
try {
  calcDay(min(17), min(8));
  failed++;
  console.log("  ❌ 退勤<出勤でエラーになるべき");
} catch {
  passed++;
  console.log("  ✅ 退勤<出勤はエラー");
}

// ===== ワンタイムQRトークン =====
const { TOKEN_RULES, makeToken, isValidToken, msUntilNextWindow } = require("./js/token.js");

(async () => {
  console.log("【QRトークン】60秒窓・現在窓＋1つ前まで有効");
  const SECRET = "test-secret";
  const WIN_MS = TOKEN_RULES.WINDOW_SEC * 1000;
  const T = Math.floor(1_750_000_000_000 / WIN_MS) * WIN_MS; // 固定時刻（窓の先頭に揃えて決定的に）

  const token = await makeToken(SECRET, T);
  eq("トークン長は10文字", token.length, TOKEN_RULES.TOKEN_LEN);
  eq("同じ窓内なら同じトークン", await makeToken(SECRET, T + WIN_MS - 1000), token);
  eq("窓が変わればトークンも変わる", (await makeToken(SECRET, T + WIN_MS)) !== token, true);
  eq("シークレットが違えばトークンも違う", (await makeToken("other", T)) !== token, true);

  eq("現在窓のトークン → 有効", await isValidToken(SECRET, token, T), true);
  eq("1つ前の窓のトークン → 有効（猶予）", await isValidToken(SECRET, token, T + WIN_MS), true);
  eq("2つ前の窓のトークン → 無効（期限切れ）", await isValidToken(SECRET, token, T + WIN_MS * 2), false);
  eq("デタラメなトークン → 無効", await isValidToken(SECRET, "aaaaaaaaaa", T), false);
  eq("空トークン → 無効", await isValidToken(SECRET, "", T), false);
  eq("別シークレットで生成したトークン → 無効", await isValidToken(SECRET, await makeToken("other", T), T), false);

  console.log("【QRトークン】窓の残り時間");
  eq("窓の開始直後 → 残りほぼ60秒", msUntilNextWindow(T - (T % WIN_MS)), WIN_MS);
  eq("窓の終わり1秒前 → 残り1秒", msUntilNextWindow(T - (T % WIN_MS) + WIN_MS - 1000), 1000);

  console.log(`\n結果: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
