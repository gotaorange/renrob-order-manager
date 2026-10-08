'use client';
import { useEffect } from 'react';

export default function Workspace() {
  useEffect(() => {
    const failed = () => {
      const root = document.getElementById('app');
      if (root?.querySelector('.loading')) root.innerHTML = '<div class="empty">工作空間連線較慢，請重新整理再試。<p><a class="btn" href="">重新載入</a></p></div>';
    };
    const timer = window.setTimeout(failed, 15000);
    const script = document.createElement('script');
    script.src = '/app.js';
    script.async = true;
    script.onerror = failed;
    document.body.appendChild(script);
    return () => { window.clearTimeout(timer); script.remove(); };
  }, []);
  return <>
    <div id="app"><div className="loading"><div>Re:Nrob Lab<br /><span>正在開啟工作空間…</span></div></div></div>
    <div id="toast" role="status" aria-live="polite" />
    <dialog id="modal" />
    <noscript>請開啟瀏覽器的 JavaScript，才能使用訂單管理。</noscript>
  </>;
}
