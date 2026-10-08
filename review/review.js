/* Interface review only. Every record below is fictional and never persisted. */
(() => {
  'use strict';
  const previewMessage = '這是介面預覽，所有資料均為虛構。此版本不會儲存、上傳、下載、製作 PI 或變更密碼。';
  const copy = value => JSON.parse(JSON.stringify(value));
  const fixture = (id, code, values) => ({
    id, orderNo: id, code, styleNo: 'DEMO-TOTE', factory: '灣得', version: 1,
    items: [{color: '原色（示範）', quantity: 50, unitPrice: 200}],
    workflowConfirmed: true, sampleRequired: true, sampleStage: 'requirements',
    sampleDue: '', productionStatus: 'waiting', productionDue: '',
    requirements: '虛構示範：使用已確認的設計圖，製作簡約提袋。',
    specifications: '虛構規格：寬 30 × 高 35 公分，尺寸僅用於介面展示。',
    printDetails: '示範單面印花', packaging: '示範一般包裝',
    sampleBill: '', sampleInvoice: '', samplePaid: false, samplePaidDate: '',
    invoiceRequired: true, taxMode: 'included', deposit: 3000,
    depositReceived: false, balanceReceived: false, depositInvoice: '', balanceInvoice: '',
    sampleFee: 0, shipping: 0, totals: {subtotal: 10000, tax: 0, total: 10000, balance: 7000},
    dataComplete: true, buyer: '虛構示範買方（無真實名稱、統編或地址）',
    internalNotes: '虛構帳務資料，僅示範內部欄位的版面。',
    folder: '介面預覽不連接本機資料夾',
    files: [{id: 'demo-design', name: '示範設計圖稿（無實際檔案）.pdf', kind: 'design', size: 0}],
    history: [{at: '2026-10-01T09:00:00', text: '虛構示範：建立介面展示訂單。'}],
    ...values,
  });
  const orders = [
    fixture('DEMO-001', '示範訂單 甲', {workflowConfirmed: false}),
    fixture('DEMO-002', '示範訂單 乙', {sampleStage: 'sample_review', sampleDue: '2026-10-20', depositReceived: true}),
    fixture('DEMO-003', '示範訂單 丙', {sampleRequired: false, sampleStage: 'sample_confirmed', productionStatus: 'producing', productionDue: '2026-10-30', depositReceived: true}),
  ];
  const publicKeys = [
    'id', 'orderNo', 'code', 'styleNo', 'factory', 'workflowConfirmed',
    'sampleRequired', 'sampleStage', 'sampleDue', 'productionStatus', 'productionDue',
    'requirements', 'specifications', 'printDetails', 'packaging',
    'sampleBill', 'sampleInvoice', 'samplePaid', 'samplePaidDate',
  ];
  function publicOrder(order) {
    const result = Object.fromEntries(publicKeys.map(key => [key, order[key]]));
    result.items = order.items.map(({color, quantity}) => ({color, quantity}));
    result.files = order.files.filter(file => ['design', 'sample_bill', 'sample_invoice'].includes(file.kind))
      .map(({id, name, kind}) => ({id, name, kind}));
    return result;
  }
  async function api(path, body, method = 'POST') {
    // The production helper uses GET whenever it receives no body.
    if (body !== undefined && body !== null) throw new Error(previewMessage);
    if (!['GET', 'POST'].includes(method)) throw new Error(previewMessage);
    if (path === '/api/session') return {admin: true, local: false, review: true};
    if (path === '/api/orders') return {orders: copy(orders)};
    if (path === '/api/public/orders') return {orders: copy(orders.map(publicOrder))};
    if (path === '/api/settings') return {
      ordersRoot: '介面預覽不連接本機資料夾，也不會建立訂單資料夾',
      piTemplate: '介面預覽不使用真實 PI 範本', templateAvailable: false,
    };
    const match = path.match(/^\/api\/orders\/(DEMO-00[123])\/(files|quote-text)$/);
    if (match) {
      const order = orders.find(item => item.id === match[1]);
      if (match[2] === 'files') return {files: copy(order.files)};
      return {quotes: [{name: '工廠報價欄位示範（虛構）', text: '介面預覽沒有讀取工廠報價。\n正式本機版本會在這裡顯示報價文字，供內部核對。'}]};
    }
    throw new Error(previewMessage);
  }
  function notify() {
    const dialog = document.querySelector('#modal');
    dialog.innerHTML = '<div class="modal-head"><h2>介面預覽</h2><button class="close" data-action="close" aria-label="關閉">×</button></div><div class="modal-body"><p>' + previewMessage + '</p></div>';
    if (!dialog.open) dialog.showModal();
  }
  // Capture before the original application's handlers. No file contents or
  // passwords are read, and no persistence/download action can run.
  document.addEventListener('click', event => {
    const target = event.target.closest('button,a');
    if (!target) return;
    if (['upload', 'password', 'logout', 'generate-pi'].includes(target.dataset.action) ||
        target.getAttribute('href')?.startsWith('#preview-api/')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      notify();
    }
  }, true);
  document.addEventListener('submit', event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    notify();
  }, true);
  Object.defineProperty(window, 'RENROB_REVIEW', {value: Object.freeze({api}), writable: false});
})();
