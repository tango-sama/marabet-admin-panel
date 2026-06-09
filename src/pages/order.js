import '../styles/order.css';
import { getProducts, saveOrder, seedIfEmpty } from '../firebase.js';

const WILAYAS = [
  'أدرار','الشلف','الأغواط','أم البواقي','باتنة','بجاية','بسكرة','بشار','البليدة','البويرة',
  'تمنراست','تبسة','تلمسان','تيارت','تيزي وزو','الجزائر','الجلفة','جيجل','سطيف','سعيدة',
  'سكيكدة','سيدي بلعباس','عنابة','قالمة','قسنطينة','المدية','مستغانم','المسيلة','معسكر','ورقلة',
  'وهران','البيض','إليزي','برج بوعريريج','بومرداس','الطارف','تندوف','تيسمسيلت','الوادي','خنشلة',
  'سوق أهراس','تيبازة','ميلة','عين الدفلى','النعامة','عين تموشنت','غرداية','غليزان','تيميمون',
  'برج باجي مختار','أولاد جلال','بني عباس','عين صالح','عين قزام','تقرت','جانت','المغير','المنيعة'
];

const DEFAULT_PRODUCTS = [
  {id:'1',name:'Air Max Classic',brand:'Nike',cat:'sports',price:4500,sizes:'39-45',badge:'جديد',emoji:'👟',colors:[{n:'أبيض',h:'#FFFFFF'},{n:'أسود',h:'#111'},{n:'أحمر',h:'#E53935'}]},
  {id:'2',name:'Elegant Heel',brand:'Bata',cat:'womens_shoes',price:3200,sizes:'36-41',badge:'الأكثر طلباً',emoji:'👠',colors:[{n:'أسود',h:'#111'},{n:'بيج',h:'#D4B896'}]},
  {id:'3',name:'Oxford Formal',brand:'Adidas',cat:'mens_shoes',price:5800,sizes:'40-46',badge:null,emoji:'👞',colors:[{n:'بني',h:'#795548'},{n:'أسود',h:'#111'}]},
  {id:'4',name:'Summer Sandal',brand:'Local',cat:'womens_shoes',price:1800,sizes:'36-40',badge:'عرض',emoji:'🩴',colors:[{n:'ذهبي',h:'#C9A84C'},{n:'أبيض',h:'#FFFFFF'}]},
  {id:'5',name:'Kids Runner',brand:'Puma',cat:'kids',price:2400,sizes:'28-35',badge:null,emoji:'👟',colors:[{n:'أزرق',h:'#1565C0'},{n:'وردي',h:'#E91E63'}]},
  {id:'6',name:'Leather Tote',brand:'Local',cat:'bags',price:3500,sizes:'مقاس واحد',badge:null,emoji:'👜',colors:[{n:'بني',h:'#795548'},{n:'أسود',h:'#111'}]},
  {id:'7',name:'Sport Max',brand:'Reebok',cat:'sports',price:5200,sizes:'38-46',badge:'جديد',emoji:'👟',colors:[{n:'رمادي',h:'#9E9E9E'},{n:'أسود',h:'#111'},{n:'أبيض',h:'#FFFFFF'}]},
  {id:'8',name:'Classic 574',brand:'New Balance',cat:'mens_shoes',price:6800,sizes:'39-46',badge:null,emoji:'👟',colors:[{n:'أبيض',h:'#FFFFFF'},{n:'بحري',h:'#1A237E'}]}
];

// ── State ──
let PRODUCTS = [];
let cart = [];
let currentFilter = 'all';
let deliveryType = 'desk';
const DELIVERY_DESK = 800;
const DELIVERY_HOME = 1200;

// ── Helpers ──
function $(id) { return document.getElementById(id); }

function showToast(msg, type) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast ' + type + ' show';
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('show'), 3500);
}

// ── Delivery ──
window.setDelivery = function(type) {
  deliveryType = type;
  document.querySelectorAll('.del-option').forEach(o => o.classList.toggle('active', o.dataset.del === type));
  updateCartUI();
};

// ── Render ──
function renderProducts() {
  const grid = $('pgrid');
  const q = ($('search').value || '').toLowerCase();
  let list = currentFilter === 'all' ? PRODUCTS : PRODUCTS.filter(p => p.cat === currentFilter);
  if (q) list = list.filter(p => p.name.toLowerCase().includes(q) || (p.brand || '').toLowerCase().includes(q));
  if (!list.length) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:3rem;color:var(--ink-3)">لا توجد منتجات مطابقة</div>';
    return;
  }
  grid.innerHTML = list.map(p => {
    const inCart = cart.find(c => c.pid === p.id);
    const selected = inCart ? ' selected' : '';
    const visual = p.emoji || '👟';
    return `<div class="pcard${selected}" data-pid="${p.id}">
      ${p.badge ? `<span class="badge">${p.badge}</span>` : ''}
      <span class="check">✓</span>
      <span class="emoji">${visual}</span>
      <div class="brand">${p.brand || '&nbsp;'}</div>
      <div class="name">${p.name}</div>
      <div class="price"><span class="num">${p.price.toLocaleString()}</span> <span>دج</span></div>
    </div>`;
  }).join('');
  updateCartUI();
}

// ── Product click → add/remove from cart ──
function selectProduct(pid) {
  const p = PRODUCTS.find(x => x.id === pid);
  if (!p) return;
  const existing = cart.find(c => c.pid === pid);
  if (existing) {
    cart = cart.filter(c => c.pid !== pid);
    renderProducts();
    return;
  }
  const defaultColor = p.colors && p.colors.length ? p.colors[0] : { n: '', h: '#888' };
  const sizesArr = (p.sizes || '').split('-');
  const defaultSize = sizesArr.length === 2 ? Math.round((+sizesArr[0] + +sizesArr[1]) / 2) : (sizesArr[0] || '');
  cart.push({
    pid: p.id, name: p.name, brand: p.brand, emoji: p.emoji || '👟',
    price: p.price, color: defaultColor.n, colorHex: defaultColor.h,
    size: defaultSize, sizes: p.sizes, colors: p.colors, qty: 1
  });
  renderProducts();
}

// ── Cart UI ──
function updateCartUI() {
  const container = $('cartItems');
  $('cartCount').textContent = cart.length;
  const wrap = $('cartTotalsWrap');
  if (!cart.length) {
    container.innerHTML = '<div class="cart-empty">لم تضيفي أي منتج بعد.<br>اختاري منتجاً من القائمة.</div>';
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'block';
  const subtotal = cart.reduce((s, c) => s + c.price * c.qty, 0);
  const delivery = deliveryType === 'home' ? DELIVERY_HOME : DELIVERY_DESK;
  $('cartSubtotal').textContent = subtotal.toLocaleString();
  $('cartDelivery').textContent = delivery.toLocaleString();
  $('cartGrandTotal').textContent = (subtotal + delivery).toLocaleString();

  container.innerHTML = cart.map((c, i) => {
    const colorOpts = (c.colors || [{n:c.color,h:c.colorHex}]).map((cl, ci) =>
      `<option value="${ci}" ${cl.n === c.color ? 'selected' : ''}>${cl.n}</option>`
    ).join('');
    const sizesArr = (c.sizes || '').split('-');
    const sizeOpts = sizesArr.length === 2
      ? Array.from({ length: +sizesArr[1] - +sizesArr[0] + 1 }, (_, si) => +sizesArr[0] + si)
          .map(s => `<option value="${s}" ${String(s) === String(c.size) ? 'selected' : ''}>${s}</option>`).join('')
      : `<option value="${c.size}" selected>${c.size || '—'}</option>`;
    return `<div class="cart-item">
      <button class="ci-remove" data-idx="${i}" title="حذف">✕</button>
      <div class="ci-emoji">${c.emoji}</div>
      <div class="ci-info">
        <div class="ci-name">${c.name}</div>
        <div class="ci-detail">${c.brand || ''}</div>
        <div style="display:flex;gap:8px;margin-top:6px">
          <select data-idx="${i}" class="ci-color-sel" style="background:var(--bg);border:1px solid var(--line);color:var(--ink);font-family:var(--sans);font-size:.7rem;padding:4px 6px;border-radius:8px;direction:rtl">${colorOpts}</select>
          <select data-idx="${i}" class="ci-size-sel" style="background:var(--bg);border:1px solid var(--line);color:var(--ink);font-family:var(--sans);font-size:.7rem;padding:4px 6px;border-radius:8px;direction:rtl">${sizeOpts}</select>
        </div>
        <div class="ci-price"><span class="num">${(c.price * c.qty).toLocaleString()}</span> دج</div>
        <div class="ci-qty">
          <button data-idx="${i}" class="ci-qty-minus">−</button><span>${c.qty}</span><button data-idx="${i}" class="ci-qty-plus">+</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

// ── Cart events (delegated) ──
$('cartItems').addEventListener('click', e => {
  const idx = e.target.dataset.idx;
  if (idx === undefined) return;
  if (e.target.classList.contains('ci-remove')) { cart.splice(+idx, 1); renderProducts(); }
  if (e.target.classList.contains('ci-qty-minus')) { cart[idx].qty = Math.max(1, cart[idx].qty - 1); renderProducts(); }
  if (e.target.classList.contains('ci-qty-plus')) { cart[idx].qty = (cart[idx].qty || 1) + 1; renderProducts(); }
});
$('cartItems').addEventListener('change', e => {
  const idx = e.target.dataset.idx;
  if (idx === undefined) return;
  if (e.target.classList.contains('ci-color-sel')) {
    const c = cart[+idx];
    const colors = c.colors || [{ n: c.color, h: c.colorHex }];
    const col = colors[+e.target.value] || colors[0];
    c.color = col.n; c.colorHex = col.h;
  }
  if (e.target.classList.contains('ci-size-sel')) { cart[+idx].size = e.target.value; }
  updateCartUI();
});

// ── Product grid clicks ──
$('pgrid').addEventListener('click', e => {
  const card = e.target.closest('.pcard');
  if (!card) return;
  selectProduct(card.dataset.pid);
});

// ── Delivery toggle ──
$('deliveryToggle').addEventListener('click', e => {
  const opt = e.target.closest('.del-option');
  if (!opt) return;
  setDelivery(opt.dataset.del);
});

// ── Submit ──
function submitOrder(mode) {
  if (!cart.length) { showToast('أضيفي منتجاً واحداً على الأقل إلى السلة', 'error'); return; }
  const name = $('cName').value.trim();
  const phone = $('cPhone').value.trim();
  const wilaya = $('cWilaya').value;
  const commune = $('cCommune').value.trim();
  const address = $('cAddress').value.trim();
  if (!name) { showToast('الرجاء إدخال الاسم الكامل', 'error'); return; }
  if (!phone) { showToast('الرجاء إدخال رقم الهاتف', 'error'); return; }
  const note = $('cNote').value.trim();
  const subtotal = cart.reduce((s, c) => s + c.price * c.qty, 0);
  const delivery = deliveryType === 'home' ? DELIVERY_HOME : DELIVERY_DESK;
  const grand = subtotal + delivery;
  const delLabel = deliveryType === 'home' ? 'توصيل للمنزل' : 'توصيل للمكتب (Stop Desk)';

  if (mode === 'whatsapp') {
    let waMsg = `مرحباً، أريد طلب:\n\n`;
    cart.forEach((c, i) => {
      waMsg += `${i + 1}. ${c.name} — ${c.brand || ''} | اللون: ${c.color || '—'} | المقاس: ${c.size} | الكمية: ${c.qty} | ${(c.price * c.qty).toLocaleString()} دج\n`;
    });
    waMsg += `\n💰 ثمن المنتجات: ${subtotal.toLocaleString()} دج\n`;
    waMsg += `🚚 التوصيل: ${delivery.toLocaleString()} دج (${delLabel})\n`;
    waMsg += `📦 المجموع الكلي: ${grand.toLocaleString()} دج\n\n`;
    waMsg += `👤 الاسم: ${name}\n📞 الهاتف: ${phone}\n`;
    if (wilaya) waMsg += `📍 الولاية: ${wilaya}`;
    if (commune) waMsg += ` — ${commune}`;
    if (address) waMsg += `\n🏠 العنوان: ${address}`;
    if (note) waMsg += `\n📝 ملاحظة: ${note}`;
    window.open('https://wa.me/213772423191?text=' + encodeURIComponent(waMsg), '_blank');
  }

  // Save to Firestore
  cart.forEach(c => {
    saveOrder({
      customer: name, phone, wilaya: wilaya || '', commune: commune || '', address: address || '',
      product: c.name + (c.brand ? ' — ' + c.brand : ''), color: c.color || '', colorHex: c.colorHex || '#888',
      size: c.size || '', price: c.price * c.qty, qty: c.qty,
      deliveryType, deliveryFee: delivery, total: grand,
      status: mode === 'save' ? 'Saved' : 'New', fulfilled: false, trackingNum: '', note,
      placedAt: new Date().toISOString()
    }).catch(() => {});
  });

  cart = []; renderProducts();
  ['cName','cPhone','cWilaya','cCommune','cAddress','cNote'].forEach(id => { $(id).value = ''; });
  deliveryType = 'desk';
  document.querySelectorAll('.del-option').forEach(o => o.classList.toggle('active', o.dataset.del === 'desk'));
  showToast(mode === 'whatsapp' ? '✅ تم إرسال الطلب عبر واتساب!' : '✅ تم حفظ الطلب لدى البائع!', 'success');
}

$('saveBtn').addEventListener('click', () => submitOrder('save'));
$('waBtn').addEventListener('click', () => submitOrder('whatsapp'));

// ── Filters ──
$('catPills').addEventListener('click', e => {
  const pill = e.target.closest('.cpill');
  if (!pill) return;
  document.querySelectorAll('.cpill').forEach(p => p.classList.remove('active'));
  pill.classList.add('active');
  currentFilter = pill.dataset.cat;
  renderProducts();
});
$('search').addEventListener('input', renderProducts);

// ── Wilaya dropdown ──
WILAYAS.forEach(w => { const o = document.createElement('option'); o.value = w; o.textContent = w; $('cWilaya').appendChild(o); });

// ── Init ──
(async function init() {
  try {
    const fbProducts = await getProducts(true);
    if (fbProducts && fbProducts.length) {
      PRODUCTS = fbProducts.map(p => {
        const variants = (p.variants || []).map(v => ({ n: v.color || '', h: v.hex || '#888', img: v.photo || null }));
        return {
          id: p._docId || p.id, name: p.name || '', brand: p.brand || '', cat: p.category || 'sports',
          price: p.price || 0, sizes: p.sizes || '',
          emoji: variants.length ? null : '👟', colors: variants.length ? variants : [{ n: '', h: '#888' }], badge: null
        };
      });
    } else {
      PRODUCTS = DEFAULT_PRODUCTS;
    }
  } catch(e) {
    PRODUCTS = DEFAULT_PRODUCTS;
  }
  renderProducts();
  seedIfEmpty().catch(() => {});

  // URL param — auto-select product
  const params = new URLSearchParams(window.location.search);
  const pid = params.get('pid');
  if (pid) {
    setTimeout(() => selectProduct(pid), 400);
    if (window.history && window.history.replaceState) window.history.replaceState({}, '', window.location.pathname);
  }
})();
