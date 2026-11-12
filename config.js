// 公開してよい接続先だけを設定します。利用キー・社員情報は入れません。
window.DRIVE_CONFIG = Object.freeze({
  apiUrl: '',
  requestTimeoutMs: 20000,
  bridgeTimeoutMs: 30000,
  allowBridge: true,
  version: '0.1.0'
});
