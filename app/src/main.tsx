import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// iPad のブラウザがデータを勝手に消さないよう、永続保存を依頼する
navigator.storage?.persist?.();

// 公開版だけ: オフラインで開けるように Service Worker を登録する
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
