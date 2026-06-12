/**
 * timu-card ワンタイムQRトークン（UI非依存・Nodeテスト可）
 *
 * 仕組み:
 * - 時刻を60秒の「窓」に区切り、SHA-256(secret|窓番号) の先頭10文字をトークンとする
 * - QR表示端末は現在窓のトークン入りURLをQR表示し、窓が変わるたびに更新
 * - 打刻アプリは「現在窓」と「1つ前の窓」のトークンのみ有効と判定
 *   （読み取り直後に窓が切り替わっても弾かれないための猶予。実質有効期限は最大2分）
 */

const TOKEN_RULES = {
  WINDOW_SEC: 60, // トークンが切り替わる間隔（秒）
  TOKEN_LEN: 10,  // トークン長（SHA-256 hexの先頭文字数）
  GRACE: 1,       // 何個前の窓まで許容するか
};

/** 実行環境に応じた WebCrypto subtle を返す */
function getSubtle() {
  if (typeof crypto !== "undefined" && crypto.subtle) return crypto.subtle;
  throw new Error("WebCrypto が利用できない環境です");
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const buf = await getSubtle().digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** epochMs時点の窓番号（windowOffsetで前後の窓を指定可） */
function windowNumber(epochMs, windowOffset = 0) {
  return Math.floor(epochMs / 1000 / TOKEN_RULES.WINDOW_SEC) + windowOffset;
}

/** 指定時刻のトークンを生成 */
async function makeToken(secret, epochMs, windowOffset = 0) {
  const hex = await sha256Hex(`${secret}|${windowNumber(epochMs, windowOffset)}`);
  return hex.slice(0, TOKEN_RULES.TOKEN_LEN);
}

/** トークンが有効か（現在窓〜GRACE個前の窓まで許容） */
async function isValidToken(secret, token, epochMs) {
  if (!token) return false;
  for (let off = 0; off >= -TOKEN_RULES.GRACE; off--) {
    if (token === (await makeToken(secret, epochMs, off))) return true;
  }
  return false;
}

/** 次の窓まで何ミリ秒か（QR表示の更新タイミング用） */
function msUntilNextWindow(epochMs) {
  const windowMs = TOKEN_RULES.WINDOW_SEC * 1000;
  return windowMs - (epochMs % windowMs);
}

// Node.js（テスト実行時）用エクスポート
if (typeof module !== "undefined" && module.exports) {
  module.exports = { TOKEN_RULES, windowNumber, makeToken, isValidToken, msUntilNextWindow };
}
