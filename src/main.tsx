import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Safely catch unhandled rejections from benign dev-server WebSocket drops (such as Vite HMR disabled mode)
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const msg = typeof reason === 'string' ? reason : reason?.message || '';
    if (
      msg.includes('WebSocket closed without opened') ||
      msg.includes('[vite] failed to connect to websocket') ||
      msg.includes('WebSocket connection to') ||
      msg.includes('Failed to construct \'WebSocket\'')
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  });

  window.addEventListener('error', (event) => {
    const msg = event.message || '';
    if (
      msg.includes('WebSocket closed without opened') ||
      msg.includes('[vite] failed to connect to websocket')
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
