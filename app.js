(() => {
  "use strict";

  const STORAGE_KEY = "event-pos-v1";
  const $ = (id) => document.getElementById(id);
  const yen = (value) => "¥" + Number(value || 0).toLocaleString("ja-JP");
  const intValue = (value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0;
  const clone = (value) => JSON.parse(JSON.stringify(value));

  function freshState() {
    return {
      schemaVersion: 1,
      boothName: "イベントPOS",
      merchandise: [],
      transactions: [],
      nextMerchandiseId: 1,
      nextTransactionId: 1,
      csvExportedFingerprint: null,
      lastCsvExportedAt: null
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return freshState();
      const parsed = JSON.parse(raw);
      const state = { ...freshState(), ...parsed };
      if (!Array.isArray(state.merchandise) || !Array.isArray(state.transactions)) throw new Error("Invalid data");
      state.merchandise = state.merchandise.map((p, index) => ({
        id: Number(p.id), name: String(p.name ?? ""), price: Number(p.price),
        stockIn: Number(p.stockIn ?? p.stock ?? 0), stockNow: Number(p.stockNow ?? p.stock ?? 0),
        sortOrder: Number.isFinite(Number(p.sortOrder)) ? Number(p.sortOrder) : index
      })).sort((a, b) => a.sortOrder - b.sortOrder);
      state.transactions = state.transactions.map((t) => ({
        ...t,
        id: Number(t.id),
        items: Array.isArray(t.items) ? t.items : [],
        itemCount: Number(t.itemCount ?? 0),
        total: Number(t.total ?? 0),
        tendered: Number(t.tendered ?? 0),
        change: Number(t.change ?? 0)
      }));
      state.nextMerchandiseId = Math.max(Number(state.nextMerchandiseId) || 1, ...state.merchandise.map(p => p.id + 1), 1);
      state.nextTransactionId = Math.max(Number(state.nextTransactionId) || 1, ...state.transactions.map(t => t.id + 1), 1);
      return state;
    } catch (error) {
      alert("保存データを読み込めませんでした。データが破損している可能性があります。安全のため初期化はせず、ブラウザのデータを消去しないでください。");
      return freshState();
    }
  }

  let state = loadState();
  let cart = new Map();
  let toastTimer = null;
  let pendingTransaction = null;

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      $("storageStatus").textContent = "正常";
      return true;
    } catch (error) {
      $("storageStatus").textContent = "エラー";
      alert("データを保存できませんでした。端末の空き容量やブラウザ設定を確認してください。会計処理を中断します。");
      return false;
    }
  }

  function fingerprintTransactions() {
    // Include all saved transaction content. A later transaction or mutation invalidates prior CSV export.
    return JSON.stringify(state.transactions);
  }

  function csvIsCurrent() {
    return state.csvExportedFingerprint !== null &&
      state.csvExportedFingerprint === fingerprintTransactions();
  }

  function invalidateCsvExport() {
    state.csvExportedFingerprint = null;
    state.lastCsvExportedAt = null;
  }

  function showToast(message) {
    const toast = $("toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
  }

  function showDialog(id) {
    const dialog = $(id);
    if (typeof dialog.showModal === "function") dialog.showModal();
    else alert("このブラウザではダイアログを表示できません。対応ブラウザで開いてください。");
  }
  function closeDialog(id) { if ($(id).open) $(id).close(); }

  function setPage(page) {
    document.querySelectorAll(".tab").forEach((button) => button.classList.toggle("active", button.dataset.page === page));
    document.querySelectorAll(".page").forEach((section) => section.classList.toggle("active", section.id === "page-" + page));
    if (page === "records") renderRecords();
    if (page === "settings") renderSettings();
    window.scrollTo(0, 0);
  }

  function cartItemCount() {
    let count = 0;
    for (const quantity of cart.values()) count += quantity;
    return count;
  }
  function cartTotal() {
    let total = 0;
    for (const [id, quantity] of cart.entries()) {
      const product = state.merchandise.find((p) => p.id === id);
      if (product) total += product.price * quantity;
    }
    return total;
  }

  function renderPOS() {
    const grid = $("productGrid");
    grid.innerHTML = "";
    const products = [...state.merchandise].sort((a, b) => (a.sortOrder ?? a.id) - (b.sortOrder ?? b.id));
    $("emptyProducts").classList.toggle("hidden", products.length > 0);
    for (const product of products) {
      const quantity = cart.get(product.id) || 0;
      const soldout = product.stockNow <= 0;
      const card = document.createElement("article");
      card.className = "product-card" + (soldout ? " soldout" : "");
      const name = document.createElement("div");
      name.className = "product-name";
      name.textContent = product.name;
      const price = document.createElement("div");
      price.className = "product-price";
      price.textContent = yen(product.price);
      const stock = document.createElement("div");
      stock.className = "product-stock";
      stock.textContent = soldout ? "売り切れ" : "在庫 " + product.stockNow;
      const controls = document.createElement("div");
      controls.className = "qty-controls";
      const minus = document.createElement("button");
      minus.className = "qty-button";
      minus.type = "button";
      minus.textContent = "−";
      minus.setAttribute("aria-label", product.name + "を1点減らす");
      minus.disabled = quantity <= 0;
      minus.addEventListener("click", () => setQuantity(product.id, quantity - 1));
      const qty = document.createElement("span");
      qty.className = "qty-number";
      qty.textContent = String(quantity);
      const plus = document.createElement("button");
      plus.className = "qty-button";
      plus.type = "button";
      plus.textContent = "+";
      plus.setAttribute("aria-label", product.name + "を1点増やす");
      plus.disabled = soldout || quantity >= product.stockNow;
      plus.addEventListener("click", () => setQuantity(product.id, quantity + 1));
      const spacer = document.createElement("span");
      spacer.className = "qty-spacer";
      const line = document.createElement("span");
      line.className = "line-total";
      line.textContent = yen(product.price * quantity);
      controls.append(minus, qty, plus, spacer, line);
      card.append(name, price, stock, controls);
      grid.append(card);
    }
    $("itemCount").textContent = String(cartItemCount());
    $("cartTotal").textContent = yen(cartTotal());
    $("checkoutOpen").disabled = cartItemCount() === 0;
  }

  function setQuantity(id, quantity) {
    const product = state.merchandise.find((p) => p.id === id);
    if (!product) return;
    const next = Math.max(0, Math.min(product.stockNow, Math.floor(quantity)));
    if (next === 0) cart.delete(id);
    else cart.set(id, next);
    renderPOS();
  }

  function openCheckout() {
    if (cartItemCount() < 1) return;
    // Revalidate stock and prices at the time checkout begins.
    for (const [id, quantity] of cart.entries()) {
      const product = state.merchandise.find((p) => p.id === id);
      if (!product || product.stockNow < quantity) {
        showToast("在庫が変更されています。数量を確認してください。");
        cart.delete(id);
        renderPOS();
        return;
      }
    }
    $("paymentEntry").classList.remove("hidden");
    $("paymentDone").classList.add("hidden");
    $("checkoutTitle").textContent = "会計確認";
    $("paymentError").textContent = "";
    $("tenderedInput").value = "";
    $("modalTotal").textContent = yen(cartTotal());
    const lines = $("checkoutLines");
    lines.innerHTML = "";
    for (const [id, quantity] of cart.entries()) {
      const product = state.merchandise.find((p) => p.id === id);
      const row = document.createElement("div");
      row.className = "checkout-line";
      const label = document.createElement("span");
      label.textContent = product.name + " × " + quantity + "（" + yen(product.price) + "）";
      const amount = document.createElement("strong");
      amount.textContent = yen(product.price * quantity);
      row.append(label, amount);
      lines.append(row);
    }
    showDialog("checkoutDialog");
    setTimeout(() => $("tenderedInput").focus(), 80);
  }

  function commitPayment() {
    const tendered = Number($("tenderedInput").value);
    const total = cartTotal();
    if ($("tenderedInput").value.trim() === "" || !intValue(tendered)) {
      $("paymentError").textContent = "預り金額は0以上の整数で入力してください。";
      return;
    }
    if (tendered < total) {
      $("paymentError").textContent = "預り金額が合計金額に足りません。";
      return;
    }
    if (cartItemCount() < 1) {
      $("paymentError").textContent = "商品が選択されていません。";
      return;
    }

    const items = [];
    let verifyTotal = 0;
    let verifyCount = 0;
    for (const [id, quantity] of cart.entries()) {
      const p = state.merchandise.find((product) => product.id === id);
      if (!p || !Number.isSafeInteger(quantity) || quantity < 1 || p.stockNow < quantity) {
        $("paymentError").textContent = "在庫が不足しています。画面を閉じて数量を確認してください。";
        return;
      }
      const subtotal = p.price * quantity;
      if (!Number.isSafeInteger(subtotal)) {
        $("paymentError").textContent = "金額が大きすぎるため会計できません。";
        return;
      }
      items.push({ merchandiseId: p.id, name: p.name, unitPrice: p.price, quantity, subtotal });
      verifyTotal += subtotal;
      verifyCount += quantity;
    }
    if (!Number.isSafeInteger(verifyTotal) || verifyTotal !== total) {
      $("paymentError").textContent = "合計金額の検証に失敗しました。もう一度お試しください。";
      return;
    }

    const before = clone(state);
    const transaction = {
      id: state.nextTransactionId,
      items,
      itemCount: verifyCount,
      total: verifyTotal,
      tendered,
      change: tendered - verifyTotal,
      createdAt: new Date().toISOString()
    };
    for (const item of items) {
      const product = state.merchandise.find((p) => p.id === item.merchandiseId);
      product.stockNow -= item.quantity;
    }
    state.transactions.push(transaction);
    state.nextTransactionId += 1;
    invalidateCsvExport();
    if (!persist()) {
      state = before;
      return;
    }
    pendingTransaction = transaction;
    $("doneTotal").textContent = yen(transaction.total);
    $("doneTendered").textContent = yen(transaction.tendered);
    $("doneChange").textContent = yen(transaction.change);
    $("paymentEntry").classList.add("hidden");
    $("paymentDone").classList.remove("hidden");
    $("checkoutTitle").textContent = "会計完了";
    renderPOS();
    renderSettings();
  }

  function finishCheckout() {
    closeDialog("checkoutDialog");
    cart.clear();
    pendingTransaction = null;
    renderPOS();
  }

  function renderRecords() {
    const body = $("recordsBody");
    body.innerHTML = "";
    const transactions = [...state.transactions].sort((a, b) => b.id - a.id);
    $("recordCount").textContent = transactions.length + "件";
    $("emptyRecords").classList.toggle("hidden", transactions.length > 0);
    $("csvStatus").textContent = csvIsCurrent() ? "最新CSV出力済み" : "CSV未出力／要再出力";
    $("csvStatus").className = csvIsCurrent() ? "status-good" : "status-bad";
    for (const t of transactions) {
      const row = document.createElement("tr");
      const values = ["#" + t.id, String(t.itemCount), yen(t.total), yen(t.tendered), yen(t.change)];
      values.forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      });
      row.tabIndex = 0;
      row.setAttribute("aria-label", "取引 " + t.id + " の明細を表示");
      row.addEventListener("click", () => showTransaction(t.id));
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          showTransaction(t.id);
        }
      });
      body.append(row);
    }
  }

  function showTransaction(id) {
    const t = state.transactions.find((transaction) => transaction.id === id);
    if (!t) return;
    $("transactionTitle").textContent = "取引 #" + t.id;
    const container = $("transactionDetail");
    container.innerHTML = "";
    const lines = document.createElement("div");
    lines.className = "detail-lines";
    for (const item of t.items) {
      const row = document.createElement("div");
      row.className = "detail-row";
      const left = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = item.name;
      const meta = document.createElement("small");
      meta.textContent = yen(item.unitPrice) + " × " + item.quantity;
      left.append(name, meta);
      const right = document.createElement("strong");
      right.textContent = yen(item.subtotal);
      row.append(left, right);
      lines.append(row);
    }
    const total = document.createElement("div");
    total.className = "detail-total";
    const label = document.createElement("span");
    label.textContent = "取引価格";
    const amount = document.createElement("span");
    amount.textContent = yen(t.total);
    total.append(label, amount);
    container.append(lines, total);
    const info = document.createElement("p");
    info.className = "hint";
    info.textContent = "商品点数 " + t.itemCount + "点 ／ 預り " + yen(t.tendered) + " ／ お釣り " + yen(t.change) +
      (t.createdAt ? " ／ " + new Date(t.createdAt).toLocaleString("ja-JP") : "");
    container.append(info);
    showDialog("transactionDialog");
  }

  function csvEscape(value) {
    const str = String(value ?? "");
    return '"' + str.replace(/"/g, '""') + '"';
  }

  function exportCSV() {
    const headers = [
      "transactionId", "createdAt", "itemCount", "total", "tendered", "change",
      "itemsJson", "merchandiseIdsJson", "itemNames", "unitPricesJson", "quantitiesJson", "subtotalsJson"
    ];
    const rows = [headers];
    for (const t of [...state.transactions].sort((a, b) => a.id - b.id)) {
      rows.push([
        t.id,
        t.createdAt || "",
        t.itemCount,
        t.total,
        t.tendered,
        t.change,
        JSON.stringify(t.items),
        JSON.stringify(t.items.map(item => item.merchandiseId)),
        t.items.map(item => item.name).join(" | "),
        JSON.stringify(t.items.map(item => item.unitPrice)),
        JSON.stringify(t.items.map(item => item.quantity)),
        JSON.stringify(t.items.map(item => item.subtotal))
      ]);
    }
    const csv = "\uFEFF" + rows.map(row => row.map(csvEscape).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const stamp = new Date();
    const filenameDate = [
      stamp.getFullYear(),
      String(stamp.getMonth() + 1).padStart(2, "0"),
      String(stamp.getDate()).padStart(2, "0"),
      "-",
      String(stamp.getHours()).padStart(2, "0"),
      String(stamp.getMinutes()).padStart(2, "0"),
      String(stamp.getSeconds()).padStart(2, "0")
    ].join("");
    anchor.href = url;
    anchor.download = "pos-sales-" + filenameDate + ".csv";
    anchor.style.display = "none";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();

    // Only mark exported if the click was initiated and state persisted.
    const oldFingerprint = state.csvExportedFingerprint;
    const oldTime = state.lastCsvExportedAt;
    state.csvExportedFingerprint = fingerprintTransactions();
    state.lastCsvExportedAt = new Date().toISOString();
    if (!persist()) {
      state.csvExportedFingerprint = oldFingerprint;
      state.lastCsvExportedAt = oldTime;
    } else {
      renderRecords();
      renderSettings();
      showToast("CSV出力を開始しました。ファイルが保存されたことを確認してください。");
    }
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function renderSettings() {
    $("boothTitle").textContent = state.boothName || "イベントPOS";
    $("boothNameInput").value = state.boothName || "";
    const container = $("settingsProducts");
    container.innerHTML = "";
    const products = [...state.merchandise].sort((a, b) => (a.sortOrder ?? a.id) - (b.sortOrder ?? b.id));
    $("emptySettingsProducts").classList.toggle("hidden", products.length > 0);
    products.forEach((p, index) => {
      const row = document.createElement("div");
      row.className = "settings-product";
      const info = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = p.name;
      const meta = document.createElement("small");
      meta.textContent = yen(p.price) + " ／ 入庫 " + p.stockIn + " ／ 現在庫 " + p.stockNow;
      info.append(name, meta);
      const actions = document.createElement("div");
      actions.className = "settings-actions";
      const up = makeSmallButton("↑", "上へ", () => moveProduct(p.id, -1));
      up.disabled = index === 0;
      const down = makeSmallButton("↓", "下へ", () => moveProduct(p.id, 1));
      down.disabled = index === products.length - 1;
      const edit = makeSmallButton("編集", "商品を編集", () => openProductEditor(p.id));
      edit.classList.add("edit");
      const del = makeSmallButton("削除", "商品を削除", () => deleteProduct(p.id));
      del.classList.add("delete");
      actions.append(up, down, edit, del);
      row.append(info, actions);
      container.append(row);
    });
    const current = csvIsCurrent();
    $("resetCsvStatus").textContent = current ? "最新CSV出力済み" : "未出力／要再出力";
    $("resetCsvStatus").className = current ? "status-good" : "status-bad";
  }

  function makeSmallButton(text, label, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "small-button";
    button.textContent = text;
    button.setAttribute("aria-label", label);
    button.addEventListener("click", handler);
    return button;
  }

  function moveProduct(id, direction) {
    const sorted = [...state.merchandise].sort((a, b) => (a.sortOrder ?? a.id) - (b.sortOrder ?? b.id));
    const index = sorted.findIndex(p => p.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= sorted.length) return;
    [sorted[index], sorted[target]] = [sorted[target], sorted[index]];
    // IDs remain stable; a separate ordering field preserves user-defined display order.
    sorted.forEach((p, i) => { p.sortOrder = i; });
    state.merchandise = sorted.sort((a, b) => a.sortOrder - b.sortOrder);
    if (!persist()) return;
    renderSettings();
    renderPOS();
  }

  function openProductEditor(id = null) {
    $("productError").textContent = "";
    $("productForm").reset();
    $("productIdInput").value = "";
    $("productDialogTitle").textContent = id === null ? "商品を追加" : "商品を編集";
    if (id !== null) {
      const p = state.merchandise.find(product => product.id === id);
      if (!p) return;
      $("productIdInput").value = String(p.id);
      $("productNameInput").value = p.name;
      $("productPriceInput").value = String(p.price);
      $("productStockInInput").value = String(p.stockIn);
      $("productStockNowInput").value = String(p.stockNow);
    } else {
      $("productPriceInput").value = "0";
      $("productStockInInput").value = "0";
      $("productStockNowInput").value = "0";
    }
    showDialog("productDialog");
  }

  function saveProduct(event) {
    event.preventDefault();
    const idRaw = $("productIdInput").value;
    const name = $("productNameInput").value.trim();
    const price = Number($("productPriceInput").value);
    const stockIn = Number($("productStockInInput").value);
    const stockNow = Number($("productStockNowInput").value);
    if (!name) { $("productError").textContent = "商品名を入力してください。"; return; }
    if (!intValue(price) || !Number.isSafeInteger(price)) { $("productError").textContent = "価格は0以上の整数で入力してください。"; return; }
    if (!intValue(stockIn) || !Number.isSafeInteger(stockIn) || !intValue(stockNow) || !Number.isSafeInteger(stockNow)) {
      $("productError").textContent = "在庫数は0以上の整数で入力してください。"; return;
    }
    const before = clone(state);
    if (idRaw) {
      const product = state.merchandise.find(p => p.id === Number(idRaw));
      if (!product) return;
      product.name = name;
      product.price = price;
      product.stockIn = stockIn;
      product.stockNow = stockNow;
    } else {
      state.merchandise.push({
        id: state.nextMerchandiseId++,
        name, price, stockIn, stockNow,
        sortOrder: state.merchandise.length
      });
    }
    if (!persist()) { state = before; return; }
    closeDialog("productDialog");
    // Cart quantities are clipped against newly edited stock; a renamed/repriced item updates before payment.
    for (const [id, quantity] of cart.entries()) {
      const p = state.merchandise.find(product => product.id === id);
      if (!p || p.stockNow <= 0) cart.delete(id);
      else if (quantity > p.stockNow) cart.set(id, p.stockNow);
    }
    renderPOS();
    renderSettings();
    showToast("商品を保存しました。");
  }

  function deleteProduct(id) {
    const p = state.merchandise.find(product => product.id === id);
    if (!p) return;
    if (!confirm("「" + p.name + "」を商品リストから削除しますか？過去の取引明細は保持されます。")) return;
    state.merchandise = state.merchandise.filter(product => product.id !== id);
    cart.delete(id);
    if (!persist()) return;
    renderSettings();
    renderPOS();
    showToast("商品を削除しました。");
  }

  function openReset() {
    $("resetRecordCount").textContent = state.transactions.length + "件";
    $("resetAcknowledge").checked = false;
    $("resetConfirmButton").disabled = true;
    const allowed = csvIsCurrent();
    $("resetBlocked").classList.toggle("hidden", allowed);
    $("resetConfirm").classList.toggle("hidden", !allowed);
    showDialog("resetDialog");
  }

  function resetSales() {
    if (!csvIsCurrent()) {
      $("resetBlocked").classList.remove("hidden");
      $("resetConfirm").classList.add("hidden");
      return;
    }
    if (!$("resetAcknowledge").checked) return;
    const before = clone(state);
    state.transactions = [];
    state.nextTransactionId = 1;
    invalidateCsvExport();
    if (!persist()) { state = before; return; }
    closeDialog("resetDialog");
    renderRecords();
    renderSettings();
    showToast("売上記録をリセットしました。");
  }

  function initialize() {
    document.querySelectorAll(".tab").forEach(button => button.addEventListener("click", () => setPage(button.dataset.page)));
    document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => closeDialog(button.dataset.close)));
    $("checkoutOpen").addEventListener("click", openCheckout);
    $("payNow").addEventListener("click", commitPayment);
    $("finishCheckout").addEventListener("click", finishCheckout);
    $("exportCsv").addEventListener("click", exportCSV);
    $("addProductOpen").addEventListener("click", () => openProductEditor());
    $("productForm").addEventListener("submit", saveProduct);
    $("resetOpen").addEventListener("click", openReset);
    $("resetAcknowledge").addEventListener("change", () => $("resetConfirmButton").disabled = !$("resetAcknowledge").checked);
    $("resetConfirmButton").addEventListener("click", resetSales);
    $("goExport").addEventListener("click", () => {
      closeDialog("resetDialog");
      setPage("records");
    });
    $("boothForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const name = $("boothNameInput").value.trim();
      if (!name) { showToast("ブース名を入力してください。"); return; }
      const before = state.boothName;
      state.boothName = name;
      if (!persist()) { state.boothName = before; return; }
      renderSettings();
      showToast("ブース名を保存しました。");
    });
    $("tenderedInput").addEventListener("keydown", event => {
      if (event.key === "Enter") commitPayment();
    });
    // Escape closes dialogs; no destructive operation is bound to a backdrop click.
    renderPOS();
    renderRecords();
    renderSettings();
  }

  initialize();
})();
