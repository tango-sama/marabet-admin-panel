import '../styles/admin.css';
import {
  db, storage,
  getProducts as fbGetProducts, saveProduct as fbSaveProduct, deleteProductById,
  getCategories as fbGetCategories, saveCategory as fbSaveCategory, deleteCategoryById,
  getOrders as fbGetOrders, updateOrderById, deleteOrderById,
  getSettings as fbGetSettings, saveSettings as fbSaveSettings,
  getAppearance as fbGetAppearance, saveAppearance as fbSaveAppearance,
  uploadProductPhoto, uploadSitePhoto, deleteProductPhotos,
  seedIfEmpty
} from '../firebase.js';

// ═══════════ HELPERS ═══════════
const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function uid() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'id_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function showToast(msg, type) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast ' + (type || '') + ' show';
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('show'), 3500);
}

// ═══════════ WEBP CONVERTER ═══════════
function convertToWebP(file) {
  return new Promise((resolve, reject) => {
    // If already WebP, return as-is
    if (file.type === 'image/webp') {
      resolve(file);
      return;
    }
    // Skip non-image files
    if (!file.type.startsWith('image/')) {
      resolve(file);
      return;
    }
    const img = new Image();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const url = URL.createObjectURL(file);
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(blob => {
        URL.revokeObjectURL(url);
        if (blob) {
          const webpFile = new File([blob], file.name.replace(/\.[^.]+$/, '.webp'), { type: 'image/webp' });
          resolve(webpFile);
        } else {
          // Fallback to original if conversion fails
          resolve(file);
        }
      }, 'image/webp', 0.85);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(file);
    };
    img.src = url;
  });
}

// ═══════════ STATE ═══════════
let products = [];
let categories = [];
let orders = [];
let SETTINGS = {};
let currentPage = 1;

// Photo drawer state
let drawerProduct = null;
let drawerSlots = [];
const swatches = [
  '#FFFFFF','#000000','#F5F5DC','#808080','#FF0000','#0000FF','#008000','#FFFF00',
  '#FFA500','#800080','#A52A2A','#FFC0CB','#00FFFF','#8B4513','#E6E6FA','#40E0D0',
  '#FFD700','#C0C0C0','#4B0082','#006400','#FF6347','#4682B4'
];

// ═══════════ STATS ═══════════
function updateStats() {
  const pc = $('prodCount'); if (pc) pc.textContent = products.length;
  const oc = $('orderCount'); if (oc) oc.textContent = orders.filter(o => !o.fulfilled).length;
  const sp = $('stat-products'); if (sp) sp.textContent = products.length;
  const sa = $('stat-active'); if (sa) sa.textContent = products.filter(p => p.active).length;
  const sc = $('stat-cats'); if (sc) sc.textContent = categories.length;
  const so = $('stat-orders'); if (so) so.textContent = orders.filter(o => !o.fulfilled).length;
}

// ═══════════ NAVIGATION ═══════════
function showPage(name) {
  $$('.page').forEach(p => p.classList.remove('active'));
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === name));
  const page = $('page-' + name); if (page) page.classList.add('active');
  const title = $('pageTitle'); if (title) title.textContent = name.charAt(0).toUpperCase() + name.slice(1);
  currentPage = 1;
  switch (name) {
    case 'products': renderSheet(); break;
    case 'categories': renderCats(); break;
    case 'orders': renderOrders(); break;
    case 'settings': renderSettings(); break;
    case 'dashboard': updateStats(); break;
  }
}

// ═══════════ PRODUCTS ==========================================================
function syncCatFilters() {
  const cf = $('catFilter');
  if (!cf) return;
  cf.innerHTML = '<option value="all">All Categories</option>' + categories.map(c =>
    `<option value="${c.key || ''}">${esc(c.name || '')}</option>`
  ).join('');
}

function renderSheet() {
  const body = $('sheetBody');
  if (!body) return;
  const catFilter = ($('catFilter')?.value || 'all');
  const statusFilter = ($('statusFilter')?.value || 'all');
  let list = products;
  if (catFilter !== 'all') list = list.filter(p => p.category === catFilter);
  if (statusFilter === 'active') list = list.filter(p => p.active);
  if (statusFilter === 'hidden') list = list.filter(p => !p.active);
  $('countBadge').textContent = list.length + ' products';

  if (!list.length) {
    body.innerHTML = '<tr><td colspan="10"><div class="empty"><div class="empty-icon">📦</div><div>No products</div></div></td></tr>';
    updateStats();
    return;
  }

  body.innerHTML = list.map((p, idx) => {
    const vars = (p.variants || []).map(v =>
      `<span class="variant-chip"><span class="dot" style="background:${v.hex || '#888'}"></span>${esc(v.color)}</span>`
    ).join('');
    const photoEl = p.variants?.find(v => v.photo)
      ? `<img src="${p.variants.find(v => v.photo).photo}" alt="">`
      : '📷';
    return `<tr>
      <td class="col-num">${idx + 1}</td>
      <td class="col-photo"><div class="photo-cell" data-pid="${p.id}">${photoEl}</div></td>
      <td><input class="cell-input" data-pid="${p.id}" data-field="name" value="${esc(p.name || '')}"></td>
      <td><input class="cell-input" data-pid="${p.id}" data-field="brand" value="${esc(p.brand || '')}"></td>
      <td><select class="cell-select" data-pid="${p.id}" data-field="category">${categories.map(c =>
        `<option value="${c.key}" ${p.category === c.key ? 'selected' : ''}>${esc(c.name)}</option>`
      ).join('')}</select></td>
      <td><input class="cell-input price" data-pid="${p.id}" data-field="price" type="number" value="${p.price || 0}"></td>
      <td><input class="cell-input" data-pid="${p.id}" data-field="sizes" value="${esc(p.sizes || '')}" placeholder="39-45"></td>
      <td class="variants-cell">${vars} <button class="add-color-btn" data-pid="${p.id}">✎</button></td>
      <td style="text-align:center"><label class="toggle"><input type="checkbox" data-pid="${p.id}" data-field="active" ${p.active !== false ? 'checked' : ''}><span class="toggle-slider"></span></label></td>
      <td class="col-actions">
        <button class="btn-icon" data-pid="${p.id}" title="Edit photos">🖼</button>
        <button class="btn-icon danger" data-pid="${p.id}" title="Delete">🗑</button>
      </td>
    </tr>`;
  }).join('');
  updateStats();
}

// Inline edit handler
$('sheetBody')?.addEventListener('input', e => {
  const pid = e.target.dataset.pid;
  if (!pid) return;
  const p = products.find(x => x.id === pid);
  if (!p) return;
  const field = e.target.dataset.field;
  let val = e.target.value;
  if (field === 'price') val = +val || 0;
  if (field === 'active') val = e.target.checked;
  p[field] = val;
});

$('sheetBody')?.addEventListener('click', e => {
  const pid = e.target.dataset.pid;
  if (!pid) return;
  if (e.target.classList.contains('btn-icon') && !e.target.classList.contains('danger')) openDrawer(pid);
  if (e.target.classList.contains('danger')) deleteProduct(pid);
  if (e.target.classList.contains('add-color-btn')) openDrawer(pid);
  if (e.target.closest('.photo-cell')) openDrawer(pid);
});

function addBlankRows(n) {
  for (let i = 0; i < n; i++) {
    products.push({ id: uid(), name: '', brand: '', category: 'sports', price: 0, sizes: '', active: true, variants: [] });
  }
  renderSheet();
}

async function saveAllProducts() {
  for (const p of products) {
    await fbSaveProduct({
      _docId: p.id,
      name: p.name || '', brand: p.brand || '', category: p.category || '', price: +p.price || 0,
      sizes: p.sizes || '', active: p.active !== false,
      variants: (p.variants || []).map(v => ({ color: v.color, hex: v.hex, photo: v.photo || null }))
    });
  }
  showToast('Products saved', 'success');
}

async function deleteProduct(pid) {
  if (!confirm('Delete this product?')) return;
  products = products.filter(p => p.id !== pid);
  await deleteProductById(pid).catch(() => {});
  renderSheet();
}

// ═══════════ CATEGORIES ═══════════
function renderCats() {
  const body = $('catsBody');
  if (!body) return;
  if (!categories.length) {
    body.innerHTML = '<tr><td colspan="5"><div class="empty"><div class="empty-icon">📁</div><div>No categories</div></div></td></tr>';
    return;
  }
  body.innerHTML = categories.map((c, i) => `<tr>
    <td>${i + 1}</td>
    <td><input class="cell-input" data-cid="${c.id}" value="${esc(c.name || '')}"></td>
    <td><input class="cell-input" data-cid="${c.id}" value="${esc(c.key || '')}"></td>
    <td><label class="toggle"><input type="checkbox" data-cid="${c.id}" ${c.visible !== false ? 'checked' : ''}><span class="toggle-slider"></span></label></td>
    <td class="col-actions"><button class="btn-icon danger" data-cid="${c.id}">🗑</button></td>
  </tr>`).join('');
}

$('catsBody')?.addEventListener('input', e => {
  const cid = e.target.dataset.cid;
  const c = categories.find(x => x.id === cid);
  if (!c) return;
  if (e.target.type === 'checkbox') c.visible = e.target.checked;
  else if (e.target.closest('td:nth-child(2)')) c.name = e.target.value;
  else if (e.target.closest('td:nth-child(3)')) c.key = e.target.value;
});

$('catsBody')?.addEventListener('click', e => {
  const cid = e.target.dataset.cid;
  if (!cid) return;
  if (e.target.classList.contains('danger')) {
    categories = categories.filter(c => c.id !== cid);
    deleteCategoryById(cid).catch(() => {});
    renderCats();
  }
});

function addCatRow() {
  categories.push({ id: uid(), name: '', key: '', visible: true });
  renderCats();
}

async function saveCatsAll() {
  for (const c of categories) {
    await fbSaveCategory({ _docId: c.id, name: c.name || '', key: c.key || '', visible: c.visible !== false });
  }
  syncCatFilters();
  showToast('Categories saved', 'success');
}

// ═══════════ ORDERS ═══════════
function renderOrders() {
  const body = $('ordersBody');
  if (!body) return;
  if (!orders.length) {
    body.innerHTML = '<tr><td colspan="9"><div class="empty"><div class="empty-icon">📦</div><div>No orders</div></div></td></tr>';
    updateStats();
    return;
  }
  const sorted = [...orders.filter(o => !o.fulfilled), ...orders.filter(o => o.fulfilled)];
  body.innerHTML = sorted.map(o => `<tr style="${o.fulfilled ? 'opacity:.55' : ''}">
    <td>${esc(o.num || '')}</td>
    <td>${esc(o.customer || '')} <button class="btn-icon" data-oid="${o._docId}" style="font-size:.65rem;border:1px solid var(--border);border-radius:3px;padding:1px 4px;color:var(--gold)">👤</button></td>
    <td>${esc(o.product || '')}</td>
    <td><span style="display:inline-flex;align-items:center;gap:5px"><span style="width:12px;height:12px;border-radius:50%;background:${o.colorHex || '#888'};display:inline-block"></span>${esc(o.color || '')}</span></td>
    <td>${esc(o.size || '')}</td>
    <td>${o.fulfilled ? '<span style="color:var(--gold)">✓ Done</span>' : '<span style="color:var(--success)">' + esc(o.status || 'New') + '</span>'}</td>
    <td>${!o.fulfilled ? '<button class="btn btn-sm" style="background:var(--gold);color:var(--black)" data-oid="'+o._docId+'">🚚 Fulfill</button>' : (esc(o.trackingNum || ''))}</td>
    <td><button class="btn btn-outline btn-sm" data-wa="'+o._docId+'">💬</button></td>
    <td><button class="btn-icon danger" data-del="'+o._docId+'">🗑</button></td>
  </tr>`).join('');
  updateStats();
}

$('ordersBody')?.addEventListener('click', async e => {
  const oid = e.target.dataset.oid || e.target.dataset.wa || e.target.dataset.del;
  if (!oid) return;
  const o = orders.find(x => x._docId === oid);
  if (!o) return;
  if (e.target.classList.contains('btn-icon') && !e.target.classList.contains('danger')) {
    // View customer
    const fields = [
      ['Order', o.num], ['Customer', o.customer], ['Phone', o.phone],
      ['Wilaya', o.wilaya], ['Commune', o.commune], ['Address', o.address],
      ['Product', o.product], ['Color', o.color], ['Size', o.size],
      ['Price', (o.price || 0).toLocaleString() + ' DZD'], ['Status', o.status]
    ];
    $('customerModalBody').innerHTML = fields.map(([k, v]) =>
      `<div class="info-row"><span class="info-key">${k}</span><span class="info-val">${esc(String(v))}</span></div>`
    ).join('');
    $('customerModal').classList.add('open');
  }
  if (e.target.dataset.wa) {
    const num = SETTINGS.waNumber || '213772423191';
    window.open(`https://wa.me/${num}?text=${encodeURIComponent('مرحبا ' + o.customer + '، بخصوص طلبك: ' + o.product)}`, '_blank');
  }
  if (e.target.dataset.del) {
    orders = orders.filter(x => x._docId !== oid);
    await deleteOrderById(oid).catch(() => {});
    renderOrders();
  }
  if (e.target.classList.contains('btn') && !e.target.classList.contains('btn-outline') && !e.target.classList.contains('btn-icon')) {
    o.fulfilled = true;
    o.status = 'Fulfilled';
    await updateOrderById(oid, { fulfilled: true, status: 'Fulfilled' });
    renderOrders();
  }
});

// ═══════════ SETTINGS ═══════════
function renderSettings() {
  $('settingStoreName').value = SETTINGS.storeName || '';
  $('waNumber').value = SETTINGS.waNumber || '';
  $('yalidineApiId').value = SETTINGS.yalidineApiId || '';
  $('yalidineApiToken').value = SETTINGS.yalidineApiToken || '';
  $('fromWilaya').value = SETTINGS.fromWilaya || 'Ouargla';
}

async function saveSettings() {
  SETTINGS = {
    storeName: $('settingStoreName').value,
    waNumber: $('waNumber').value,
    yalidineApiId: $('yalidineApiId').value,
    yalidineApiToken: $('yalidineApiToken').value,
    fromWilaya: $('fromWilaya').value
  };
  await fbSaveSettings(SETTINGS);
  showToast('Settings saved', 'success');
}

async function clearAllData() {
  if (!confirm('DELETE ALL DATA? This cannot be undone!')) return;
  const allProds = await fbGetProducts(false);
  const allCats = await fbGetCategories();
  const allOrders = await fbGetOrders();
  for (const p of allProds) { await deleteProductById(p._docId).catch(() => {}); }
  for (const c of allCats) { await deleteCategoryById(c._docId).catch(() => {}); }
  for (const o of allOrders) { await deleteOrderById(o._docId).catch(() => {}); }
  products = []; categories = []; orders = [];
  await seedIfEmpty();
  // Reload
  const [p, c, o] = await Promise.all([fbGetProducts(false), fbGetCategories(), fbGetOrders()]);
  products = p; categories = c; orders = o;
  renderSheet(); syncCatFilters();
  showToast('All data cleared', 'warning');
}

// ═══════════ PHOTO DRAWER ======================================================
function openDrawer(pid) {
  drawerProduct = products.find(p => p.id === pid);
  if (!drawerProduct) return;
  drawerSlots = (drawerProduct.variants || []).map((v, i) => ({
    colorIndex: i, color: v.color, hex: v.hex, url: v.photo || null, file: null
  }));
  renderDrawerSlots();
  $('drawerOverlay').classList.add('open');
}

function closeDrawer() {
  $('drawerOverlay').classList.remove('open');
  drawerProduct = null;
  drawerSlots = [];
}

function renderDrawerSlots() {
  const container = $('photoSlots');
  container.innerHTML = drawerSlots.map((s, i) => {
    const statusClass = s.url ? 'assigned' : 'unassigned';
    const thumb = s.url ? `<img src="${s.url}" alt="">` : (s.file ? `<img src="${URL.createObjectURL(s.file)}" alt="">` : '🖼');
    const takenColors = drawerSlots.filter(x => x.url || x.file).map(x => x.hex);
    const swatchHTML = swatches.map(h => {
      const taken = takenColors.includes(h) && h !== s.hex;
      const picked = h === s.hex;
      let cls = 'slot-swatch';
      if (picked) cls += ' picked';
      if (taken) cls += ' taken';
      return `<div class="${cls}" style="background:${h}" data-hex="${h}" data-slot="${i}"></div>`;
    }).join('');
    return `<div class="photo-slot ${statusClass}">
      <div class="photo-slot-top">
        <div class="slot-thumb">${thumb}</div>
        <div class="slot-info">
          <div class="slot-filename">${esc(s.url || (s.file ? s.file.name : 'No photo'))}</div>
          <div class="slot-color-row">
            <span class="slot-color-preview" style="background:${s.hex || '#888'}"></span>
            <span class="slot-color-name">${esc(s.color || 'Unassigned')}</span>
          </div>
        </div>
        <button class="btn-icon" data-rm-slot="${i}">🗑</button>
      </div>
      <div class="slot-swatches">${swatchHTML}</div>
    </div>`;
  }).join('');

  // Swatch click handlers
  container.querySelectorAll('.slot-swatch:not(.taken)').forEach(sw => {
    sw.addEventListener('click', () => {
      const si = +sw.dataset.slot;
      const hex = sw.dataset.hex;
      drawerSlots[si].hex = hex;
      // Try to find a matching color name
      const variant = drawerProduct.variants?.[si];
      if (variant) variant.hex = hex;
      renderDrawerSlots();
    });
  });

  // Remove slot button
  container.querySelectorAll('[data-rm-slot]').forEach(btn => {
    btn.addEventListener('click', () => {
      const si = +btn.dataset.rmSlot;
      drawerSlots[si].url = null;
      drawerSlots[si].file = null;
      renderDrawerSlots();
    });
  });
}

// File drop/select → WebP conversion
$('drawerDrop')?.addEventListener('dragover', e => { e.preventDefault(); $('drawerDrop').classList.add('drag'); });
$('drawerDrop')?.addEventListener('dragleave', () => $('drawerDrop').classList.remove('drag'));
$('drawerDrop')?.addEventListener('drop', async e => {
  e.preventDefault();
  $('drawerDrop').classList.remove('drag');
  await handleDrawerFiles(e.dataTransfer.files);
});
$('drawerDrop')?.addEventListener('click', () => $('drawerFileInput').click());
$('drawerFileInput')?.addEventListener('change', async e => {
  await handleDrawerFiles(e.target.files);
  $('drawerFileInput').value = '';
});

async function handleDrawerFiles(fileList) {
  for (const file of fileList) {
    // Convert to WebP
    const webp = await convertToWebP(file);
    // Assign to first slot without a photo
    const empty = drawerSlots.find(s => !s.url && !s.file);
    if (empty) {
      empty.file = webp;
      empty.url = URL.createObjectURL(webp); // Preview
    }
  }
  renderDrawerSlots();
}

// Save drawer
$('drawerSave')?.addEventListener('click', async () => {
  if (!drawerProduct) return;
  // Upload new files to Firebase Storage
  for (const slot of drawerSlots) {
    if (slot.file) {
      try {
        const url = await uploadProductPhoto(slot.file, drawerProduct.id, slot.colorIndex);
        slot.url = url;
        slot.file = null;
      } catch (e) {
        console.error('Upload failed:', e);
      }
    }
  }
  // Update product variants
  drawerProduct.variants = drawerSlots.map(s => ({
    color: s.color, hex: s.hex, photo: s.url || null
  }));
  await fbSaveProduct({
    _docId: drawerProduct.id,
    name: drawerProduct.name, brand: drawerProduct.brand, category: drawerProduct.category,
    price: drawerProduct.price, sizes: drawerProduct.sizes, active: drawerProduct.active,
    variants: drawerProduct.variants
  });
  closeDrawer();
  renderSheet();
  showToast('Photos saved', 'success');
});

$('drawerCancel')?.addEventListener('click', closeDrawer);
$('drawerClose')?.addEventListener('click', closeDrawer);
$('drawerOverlay')?.addEventListener('click', e => { if (e.target === $('drawerOverlay')) closeDrawer(); });

// ═══════════ IMPORT / EXPORT ═══════════
function exportJSON() {
  const data = { products, categories, settings: SETTINGS };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'bazar-merabet-export.json';
  a.click();
}

async function doImport() {
  let raw = $('jsonPaste').value.trim();
  if (!raw) { showToast('Paste JSON or drop a file', 'error'); return; }
  try {
    const data = JSON.parse(raw);
    if (data.products) {
      for (const p of data.products) {
        p.id = p.id || uid();
        products.push(p);
        await fbSaveProduct({ _docId: p.id, ...p });
      }
    }
    if (data.categories) {
      for (const c of data.categories) {
        c.id = c.id || uid();
        categories.push(c);
        await fbSaveCategory({ _docId: c.id, ...c });
      }
    }
    $('importModal').classList.remove('open');
    renderSheet(); syncCatFilters();
    showToast('Import complete', 'success');
  } catch(e) {
    showToast('Invalid JSON', 'error');
  }
}

// ═══════════ EVENT BINDINGS ====================================================
$$('.nav-item').forEach(n => n.addEventListener('click', () => showPage(n.dataset.page)));
$('collapseBtn')?.addEventListener('click', () => {
  $('sidebar').classList.toggle('collapsed');
  $('main').classList.toggle('expanded');
  $('collapseBtn').classList.toggle('at-edge');
});
$('catFilter')?.addEventListener('change', () => { currentPage = 1; renderSheet(); });
$('statusFilter')?.addEventListener('change', () => { currentPage = 1; renderSheet(); });
$('exportBtn')?.addEventListener('click', exportJSON);
$('importBtn')?.addEventListener('click', () => $('importModal').classList.add('open'));
$('doImport')?.addEventListener('click', doImport);
$('addRowBtn')?.addEventListener('click', () => addBlankRows(1));
$('add5Btn')?.addEventListener('click', () => addBlankRows(5));
$('saveAllBtn')?.addEventListener('click', saveAllProducts);
$('addCatBtn')?.addEventListener('click', addCatRow);
$('saveCatsBtn')?.addEventListener('click', saveCatsAll);
$('saveSettingsBtn')?.addEventListener('click', saveSettings);
$('clearAllBtn')?.addEventListener('click', clearAllData);

// Modal close
$$('[data-close]').forEach(b => b.addEventListener('click', () => {
  const m = $(b.dataset.close); if (m) m.classList.remove('open');
}));
$$('.modal-overlay').forEach(m => m.addEventListener('click', e => {
  if (e.target === m) m.classList.remove('open');
}));

// Import drop
$('jsonDrop')?.addEventListener('dragover', e => { e.preventDefault(); $('jsonDrop').classList.add('drag'); });
$('jsonDrop')?.addEventListener('dragleave', () => $('jsonDrop').classList.remove('drag'));
$('jsonDrop')?.addEventListener('drop', e => {
  e.preventDefault();
  $('jsonDrop').classList.remove('drag');
  const f = e.dataTransfer.files[0];
  if (f) { const r = new FileReader(); r.onload = x => { $('jsonPaste').value = x.target.result; }; r.readAsText(f); }
});
$('jsonFile')?.addEventListener('change', function() {
  const f = this.files[0];
  if (f) { const r = new FileReader(); r.onload = x => { $('jsonPaste').value = x.target.result; }; r.readAsText(f); }
});

// ═══════════ INIT ═══════════
(async function init() {
  try {
    const [fbProducts, fbCategories, fbOrders, settings] = await Promise.all([
      fbGetProducts(false), fbGetCategories(), fbGetOrders(), fbGetSettings()
    ]);
    products = fbProducts.map(p => { p.id = p._docId || p.id || uid(); return p; });
    categories = fbCategories.map(c => { c.id = c._docId || c.id || uid(); return c; });
    orders = fbOrders.map(o => { o.id = o._docId || o.id || uid(); return o; });
    SETTINGS = settings || {};

    await seedIfEmpty();
    if (!products.length || !categories.length) {
      const [p2, c2] = await Promise.all([fbGetProducts(false), fbGetCategories()]);
      products = p2.map(p => { p.id = p._docId || p.id || uid(); return p; });
      categories = c2.map(c => { c.id = c._docId || c.id || uid(); return c; });
    }
  } catch(e) {
    console.error('Init error:', e);
  }

  syncCatFilters();
  showPage('products');
  updateStats();
})();
