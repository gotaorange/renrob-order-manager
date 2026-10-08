(() => {
  'use strict';
  if (window.location.protocol === 'file:') {
    window.location.replace('http://127.0.0.1:8765/');
    return;
  }
  const message = document.getElementById('startup-message');
  const failure = () => {
    if (document.querySelector('[data-startup]')) {
      message.textContent = '工作空間未能啟動，請按重新載入。若仍無法開啟，請使用 Chrome 或 Safari 開啟本機網址。';
    }
  };
  const timer = setTimeout(failure, 12000);
  const script = document.createElement('script');
  script.src = '/app.js?v=2';
  script.onerror = () => { clearTimeout(timer); failure(); };
  window.addEventListener('error', failure);
  document.head.appendChild(script);
})();
