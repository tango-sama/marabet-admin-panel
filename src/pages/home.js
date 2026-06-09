import '../styles/home.css';
import { getProducts, getAppearance, seedIfEmpty } from '../firebase.js';

// ── Constants ──
const CATS = [
  { key: 'mens_shoes', name: 'رجالي', count: '120 منتج', icon: '👞' },
  { key: 'womens_shoes', name: 'نسائي', count: '150 منتج', icon: '👠' },
  { key: 'kids', name: 'أطفال', count: '80 منتج', icon: '👟' },
  { key: 'bags', name: 'حقائب', count: '60 منتج', icon: '👜' },
  { key: 'sports', name: 'رياضي', count: '90 منتج', icon: '⚽' }
];

const DEFAULT_PRODUCTS = [
  { id: 1, name: 'Air Max Classic', brand: 'Nike', cat: 'sports', price: 4500, sizes: '39-45', badge: 'جديد', emoji: '👟', colors: [{ n: 'أبيض', h: '#FFFFFF' }, { n: 'أسود', h: '#111' }, { n: 'أحمر', h: '#E53935' }] },
  { id: 2, name: 'Elegant Heel', brand: 'Bata', cat: 'womens_shoes', price: 3200, sizes: '36-41', badge: 'الأكثر طلباً', emoji: '👠', colors: [{ n: 'أسود', h: '#111' }, { n: 'بيج', h: '#D4B896' }] },
  { id: 3, name: 'Oxford Formal', brand: 'Adidas', cat: 'mens_shoes', price: 5800, sizes: '40-46', badge: null, emoji: '👞', colors: [{ n: 'بني', h: '#795548' }, { n: 'أسود', h: '#111' }] },
  { id: 4, name: 'Summer Sandal', brand: 'Local', cat: 'womens_shoes', price: 1800, sizes: '36-40', badge: 'عرض', emoji: '🩴', colors: [{ n: 'ذهبي', h: '#C9A84C' }, { n: 'أبيض', h: '#FFFFFF' }] },
  { id: 5, name: 'Kids Runner', brand: 'Puma', cat: 'kids', price: 2400, sizes: '28-35', badge: null, emoji: '👟', colors: [{ n: 'أزرق', h: '#1565C0' }, { n: 'وردي', h: '#E91E63' }] },
  { id: 6, name: 'Leather Tote', brand: 'Local', cat: 'bags', price: 3500, sizes: 'مقاس واحد', badge: null, emoji: '👜', colors: [{ n: 'بني', h: '#795548' }, { n: 'أسود', h: '#111' }] },
  { id: 7, name: 'Sport Max', brand: 'Reebok', cat: 'sports', price: 5200, sizes: '38-46', badge: 'جديد', emoji: '👟', colors: [{ n: 'رمادي', h: '#9E9E9E' }, { n: 'أسود', h: '#111' }, { n: 'أبيض', h: '#FFFFFF' }] },
  { id: 8, name: 'Classic 574', brand: 'New Balance', cat: 'mens_shoes', price: 6800, sizes: '39-46', badge: null, emoji: '👟', colors: [{ n: 'أبيض', h: '#FFFFFF' }, { n: 'بحري', h: '#1A237E' }] }
];

// ── State ──
let PRODUCTS = [];
let activeColors = {};
let currentFilter = 'all';

// ── Ticker ──
const brands = ['NIKE', 'ADIDAS', 'PUMA', 'BATA', 'REEBOK', 'NEW BALANCE', 'SKECHERS', 'LACOSTE'];
document.getElementById('ticker').innerHTML = brands.concat(brands).concat(brands)
  .map(b => `<span class="ticker-item">${b}</span><span class="ticker-dot"></span>`).join('');

// ── Categories rail ──
document.getElementById('catRail').innerHTML = CATS.map(c =>
  `<div class="cat-tile" onclick="window._filterTo('${c.key}')">
    <div class="ci">${c.icon}</div>
    <div class="cat-meta"><div class="nm">${c.name}</div><div class="ct"><bdi>${c.count}</bdi> ←</div></div>
  </div>`
).join('');

// ── Render products ──
function renderProducts(cat) {
  const grid = document.getElementById('pgrid');
  const list = cat === 'all' ? PRODUCTS : PRODUCTS.filter(p => p.cat === cat);
  if (!list.length) {
    grid.innerHTML = '<div style="grid-column:1/-1;color:var(--ink-2);padding:3rem;text-align:center">لا توجد منتجات في هذا الصنف حالياً.</div>';
    return;
  }
  grid.innerHTML = list.map(p => {
    const ci = activeColors[p.id] || 0;
    const dots = p.colors.map((c, i) =>
      `<div class="cdot${i === ci ? ' on' : ''}" data-pid="${p.id}" data-ci="${i}" style="background:${c.h};border-color:${i === ci ? 'var(--ink)' : 'var(--line)'}" onclick="event.stopPropagation();window._setColor('${p.id}',${i})" title="${c.n}"></div>`
    ).join('');
    const cur = p.colors[ci];
    const visual = cur.img ? `<img src="${cur.img}" alt="${p.name}" style="width:100%;height:100%;object-fit:cover">` : p.emoji;
    return `<article class="pcard" data-pid="${p.id}" onclick="window._order('${p.id}')">
      <div class="pcard-img">
        ${p.badge ? `<span class="pcard-badge">${p.badge}</span>` : ''}
        <span class="pcard-fav" onclick="event.stopPropagation()">♡</span>
        <div class="pe" data-pid="${p.id}">${visual}</div>
        <div class="pcard-quick">اطلب الآن</div>
      </div>
      <div class="pcard-brand">${p.brand}</div>
      <div class="pcard-name">${p.name}</div>
      <div class="pcard-colors">${dots}</div>
      <div class="pcard-foot"><div class="pcard-price"><span class="num">${p.price.toLocaleString()}</span> <span>دج</span></div><div class="pcard-sizes"><span class="ltr">${p.sizes}</span></div></div>
    </article>`;
  }).join('');
  requestAnimationFrame(() => {
    document.querySelectorAll('.pcard').forEach((c, i) => {
      setTimeout(() => c.classList.add('in'), i * 55);
    });
  });
}

function setColor(pid, i) {
  activeColors[pid] = i;
  const p = PRODUCTS.find(x => x.id === pid);
  if (!p) return;
  const col = p.colors[i];
  const peEl = document.querySelector(`.pe[data-pid="${pid}"]`);
  if (peEl) {
    peEl.style.transition = 'opacity .25s';
    peEl.style.opacity = '0';
    setTimeout(() => {
      peEl.innerHTML = col.img
        ? `<img src="${col.img}" alt="${p.name}" style="width:100%;height:100%;object-fit:cover">`
        : p.emoji;
      peEl.style.opacity = '1';
    }, 200);
  }
  document.querySelectorAll(`.cdot[data-pid="${pid}"]`).forEach(d => {
    const on = Number(d.dataset.ci) === i;
    d.classList.toggle('on', on);
    d.style.borderColor = on ? 'var(--ink)' : 'var(--line)';
  });
}

function filterTo(cat) {
  currentFilter = cat;
  document.querySelectorAll('.fpill').forEach(p => p.classList.toggle('active', p.dataset.cat === cat));
  renderProducts(cat);
  document.getElementById('collection').scrollIntoView({ behavior: 'smooth' });
}

function order(pid) {
  window.location.href = 'order.html?pid=' + encodeURIComponent(pid);
}

// Expose to inline onclick handlers
window._filterTo = filterTo;
window._setColor = setColor;
window._order = order;

// ── Filter bar ──
document.getElementById('filterBar').addEventListener('click', e => {
  const p = e.target.closest('.fpill');
  if (!p) return;
  currentFilter = p.dataset.cat;
  document.querySelectorAll('.fpill').forEach(x => x.classList.toggle('active', x === p));
  renderProducts(p.dataset.cat);
});

// ── Contact form ──
document.getElementById('contactForm').addEventListener('submit', function (e) {
  e.preventDefault();
  const n = document.getElementById('fname').value;
  const ph = document.getElementById('fphone').value;
  const pr = document.getElementById('fproduct').value;
  const m = document.getElementById('fmsg').value;
  const t = `مرحبا، اسمي ${n}${ph ? '\nهاتف: ' + ph : ''}${pr ? '\nالمنتج: ' + pr : ''}\n\n${m}`;
  window.open('https://wa.me/213772423191?text=' + encodeURIComponent(t), '_blank');
});

// ── Nav scroll ──
const nav = document.getElementById('nav');
addEventListener('scroll', () => nav.classList.toggle('scrolled', scrollY > 40));

// ── Reveal on scroll ──
const io = new IntersectionObserver(es => {
  es.forEach(e => { if (e.isIntersecting) e.target.classList.add('in'); });
}, { threshold: .1 });
document.querySelectorAll('.rv').forEach(el => io.observe(el));

// ── Mobile burger ──
document.getElementById('burger').addEventListener('click', () => {
  const m = document.getElementById('navMenu');
  const open = m.style.display === 'flex';
  m.style.cssText = open ? '' : 'display:flex;flex-direction:column;position:fixed;top:58px;right:0;left:0;background:rgba(247,245,241,.98);padding:2rem;gap:1.5rem;border-bottom:1px solid var(--line);z-index:199;box-shadow:var(--shadow)';
});

// ── Init ──
(async function init() {
  try {
    // Load appearance
    const appear = await getAppearance();
    if (appear.hero) {
      const hp = document.querySelector('.hero-photo .ph-illus');
      if (hp) hp.outerHTML = `<img src="${appear.hero}" alt="بازار مرابط">`;
    }
    if (appear.featured) {
      const fv = document.querySelector('.featured-visual .big');
      if (fv) fv.outerHTML = `<img src="${appear.featured}" alt="مجموعة جديدة" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">`;
    }

    // Load products
    const fbProducts = await getProducts(true);
    if (fbProducts && fbProducts.length) {
      PRODUCTS = fbProducts.map(p => {
        const variants = (p.variants || []).map(v => ({ n: v.color || '', h: v.hex || '#888', img: v.photo || null }));
        return {
          id: p._docId || p.id,
          name: p.name || '',
          brand: p.brand || '',
          cat: p.category || 'sports',
          price: p.price || 0,
          sizes: p.sizes || '',
          emoji: variants.length ? null : '👟',
          colors: variants.length ? variants : [{ n: '', h: '#888' }],
          badge: null
        };
      });
    } else {
      PRODUCTS = DEFAULT_PRODUCTS;
    }
    renderProducts('all');

    // Seed if empty
    seedIfEmpty().catch(() => {});
  } catch (e) {
    PRODUCTS = DEFAULT_PRODUCTS;
    renderProducts('all');
  }

  // Safety: ensure hero headline resolves
  setTimeout(() => {
    document.querySelectorAll('.hero-h1 .line span').forEach(s => {
      s.style.opacity = '1';
      s.style.transform = 'none';
    });
  }, 1500);
})();
