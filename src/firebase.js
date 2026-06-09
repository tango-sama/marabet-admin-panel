// ═══════════════════════════════════════════════════
// Firebase config — Bazar Merabet (ES modules)
// Project: mrabet-fb38c
// ═══════════════════════════════════════════════════
import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  collection,
  doc,
  getDocs,
  getDoc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  writeBatch,
  enableIndexedDbPersistence
} from 'firebase/firestore';
import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL,
  deleteObject,
  listAll
} from 'firebase/storage';

const firebaseConfig = {
  apiKey: "AIzaSyAiL0J8poOLyQW9PUDUacPuKah0L2JMLeY",
  authDomain: "mrabet-fb38c.firebaseapp.com",
  projectId: "mrabet-fb38c",
  storageBucket: "mrabet-fb38c.firebasestorage.app",
  messagingSenderId: "195655893976",
  appId: "1:195655893976:web:2c42fa40c7f27769c5a8ad"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const storage = getStorage(app);

// Offline persistence
try {
  enableIndexedDbPersistence(db, { synchronizeTabs: true });
} catch (e) {
  // Silently fall back
}

// ═══════════ Products ═══════════
export async function getProducts(activeOnly = true) {
  let q = activeOnly
    ? query(collection(db, 'products'), where('active', '==', true))
    : query(collection(db, 'products'));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ _docId: d.id, ...d.data() }));
}

export async function saveProduct(product) {
  const data = { ...product };
  delete data._docId;
  if (product._docId) {
    return setDoc(doc(db, 'products', product._docId), data);
  } else {
    return addDoc(collection(db, 'products'), data);
  }
}

export async function deleteProductById(docId) {
  return deleteDoc(doc(db, 'products', docId));
}

// ═══════════ Categories ═══════════
export async function getCategories() {
  const snap = await getDocs(collection(db, 'categories'));
  return snap.docs.map(d => ({ _docId: d.id, ...d.data() }));
}

export async function saveCategory(cat) {
  const data = { ...cat };
  delete data._docId;
  if (cat._docId) {
    return setDoc(doc(db, 'categories', cat._docId), data);
  } else {
    return addDoc(collection(db, 'categories'), data);
  }
}

export async function deleteCategoryById(docId) {
  return deleteDoc(doc(db, 'categories', docId));
}

// ═══════════ Orders ═══════════
export async function getOrders() {
  const q = query(collection(db, 'orders'), orderBy('placedAt', 'desc'));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ _docId: d.id, ...d.data() }));
}

export async function saveOrder(order) {
  return addDoc(collection(db, 'orders'), order);
}

export async function updateOrderById(docId, data) {
  return updateDoc(doc(db, 'orders', docId), data);
}

export async function deleteOrderById(docId) {
  return deleteDoc(doc(db, 'orders', docId));
}

// ═══════════ Settings ═══════════
export async function getSettings() {
  const snap = await getDoc(doc(db, 'settings', 'general'));
  return snap.exists() ? snap.data() : {};
}

export async function saveSettings(data) {
  return setDoc(doc(db, 'settings', 'general'), data);
}

// ═══════════ Appearance ═══════════
export async function getAppearance() {
  const snap = await getDoc(doc(db, 'appearance', 'site'));
  return snap.exists() ? snap.data() : {};
}

export async function saveAppearance(data) {
  return setDoc(doc(db, 'appearance', 'site'), data, { merge: true });
}

// ═══════════ Storage ═══════════
export async function uploadProductPhoto(file, productId, colorIndex) {
  const path = `product-photos/${productId}/${colorIndex}`;
  const fileRef = ref(storage, path);
  await uploadBytes(fileRef, file);
  return getDownloadURL(fileRef);
}

export async function deleteProductPhotos(productId) {
  const folderRef = ref(storage, `product-photos/${productId}`);
  const res = await listAll(folderRef);
  return Promise.all(res.items.map(item => deleteObject(item)));
}

export async function uploadSitePhoto(file, name) {
  const fileRef = ref(storage, `site/${name}`);
  await uploadBytes(fileRef, file);
  return getDownloadURL(fileRef);
}

// ═══════════ Seed defaults ═══════════
export async function seedIfEmpty() {
  const snap = await getDocs(query(collection(db, 'products'), limit(1)));
  if (!snap.empty) return;

  const batch = writeBatch(db);

  const cats = [
    { key: 'mens_shoes', name: 'رجالي', visible: true },
    { key: 'womens_shoes', name: 'نسائي', visible: true },
    { key: 'kids', name: 'أطفال', visible: true },
    { key: 'bags', name: 'حقائب', visible: true },
    { key: 'sports', name: 'رياضي', visible: true }
  ];
  cats.forEach(c => batch.set(doc(collection(db, 'categories')), c));

  const prods = [
    { name: 'Air Max Classic', brand: 'Nike', category: 'sports', price: 4500, sizes: '39-45', active: true, variants: [{ color: 'White', hex: '#FFFFFF', photo: null }, { color: 'Black', hex: '#111111', photo: null }, { color: 'Red', hex: '#E53935', photo: null }] },
    { name: 'Elegant Heel', brand: 'Bata', category: 'womens_shoes', price: 3200, sizes: '36-41', active: true, variants: [{ color: 'Black', hex: '#111111', photo: null }, { color: 'Beige', hex: '#D4B896', photo: null }] },
    { name: 'Oxford Formal', brand: 'Adidas', category: 'mens_shoes', price: 5800, sizes: '40-46', active: true, variants: [{ color: 'Brown', hex: '#795548', photo: null }, { color: 'Black', hex: '#111111', photo: null }] },
    { name: 'Summer Sandal', brand: 'Local', category: 'womens_shoes', price: 1800, sizes: '36-40', active: true, variants: [{ color: 'Gold', hex: '#C9A84C', photo: null }, { color: 'White', hex: '#FFFFFF', photo: null }] },
    { name: 'Kids Runner', brand: 'Puma', category: 'kids', price: 2400, sizes: '28-35', active: true, variants: [{ color: 'Blue', hex: '#1565C0', photo: null }, { color: 'Pink', hex: '#E91E63', photo: null }] },
    { name: 'Leather Tote', brand: 'Local', category: 'bags', price: 3500, sizes: 'مقاس واحد', active: true, variants: [{ color: 'Brown', hex: '#795548', photo: null }, { color: 'Black', hex: '#111111', photo: null }] },
    { name: 'Sport Max', brand: 'Reebok', category: 'sports', price: 5200, sizes: '38-46', active: true, variants: [{ color: 'Gray', hex: '#9E9E9E', photo: null }, { color: 'Black', hex: '#111111', photo: null }, { color: 'White', hex: '#FFFFFF', photo: null }] },
    { name: 'Classic 574', brand: 'New Balance', category: 'mens_shoes', price: 6800, sizes: '39-46', active: true, variants: [{ color: 'White', hex: '#FFFFFF', photo: null }, { color: 'Navy', hex: '#1A237E', photo: null }] }
  ];
  prods.forEach(p => batch.set(doc(collection(db, 'products')), p));

  batch.set(doc(db, 'settings', 'general'), {
    storeName: 'Bazar Merabet',
    waNumber: '213772423191',
    yalidineApiId: '',
    yalidineApiToken: '',
    fromWilaya: 'Ouargla'
  });

  batch.set(doc(db, 'appearance', 'site'), { hero: null, featured: null });

  return batch.commit();
}
