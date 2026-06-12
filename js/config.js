/**
 * timu-card 共通設定
 * TIMU_SECRET: ワンタイムQRトークン生成用の共有シークレット
 * （変更するとそれまでのQR表示端末・アプリ両方の再読み込みが必要）
 */
const TIMU_SECRET = "323a470aa3d2c6166a7aa6325941548f";

/**
 * GAS_URL: Google Apps Script Web App のURL（スプレッドシート連携）
 * 空文字の間は送信せず、打刻は端末内のキューに保存される
 */
const GAS_URL = "https://script.google.com/macros/s/AKfycbzURoU3ZhgScC05BdFogjxV7K1TXlN9_-INaGc18I79jNhzQVURRykAJZwXfvQYajUT/exec";
