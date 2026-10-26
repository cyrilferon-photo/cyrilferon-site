// Catalogue, prix, zones de livraison et éditions — source de vérité côté serveur.
// Le site affiche les mêmes valeurs, mais seuls ces chiffres-ci comptent au paiement.
import { getStore } from "@netlify/blobs";

// Édition de 30 exemplaires par photo, tous formats confondus.

export const FORMATS = {
  "24x30": { label: "24 × 30 cm", price: 90, edition: 15 },
  "40x50": { label: "40 × 50 cm", price: 200, edition: 10 },
  "50x70": { label: "50 × 70 cm", price: 320, edition: 5 },
};

// Catalogue par défaut ; remplacé par celui publié depuis le back office (site/content → store).
export const PRODUCTS = {
  "photos/nu-artistique--sloane-06-v3.jpg": "OFF - Sloane",
  "photos/nu-artistique--cerizvodka-15.jpg": "FLOWERS - Cerizvodka",
  "photos/nu-artistique--jess-04.jpg": "LILY - Jess",
  "photos/nu-artistique--cerizvodka-07.jpg": "MIRROR - Cerizvodka",
  "photos/nu-artistique--sloane-09-v2.jpg": "FREEDOM - Sloane",
  "photos/nu-artistique--cerizvodka-12-v2.jpg": "ROSE - Cerizvodka",
  "photos/voyages--newyorkcity-24.jpg": "OCULUS",
  "photos/voyages--newyorkcity-08.jpg": "THUNDERBOLT",
  "photos/concerts--sun-01.jpg": "SUN",
};

// Exemplaires vendus avant l'ouverture de la boutique en ligne.
export const SOLD_BEFORE = {
  "photos/nu-artistique--cerizvodka-15.jpg|24x30": 1,
  "photos/nu-artistique--cerizvodka-12-v2.jpg|24x30": 1,
};

const EU = ["FR", "MC", "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "CH"];
const WORLD = ["US", "CA", "GB", "NO", "IS", "LI", "AD", "AU", "NZ", "JP", "KR", "SG", "HK", "TW", "IL", "AE", "BR", "MX", "AR", "CL", "ZA",
  "GP", "MQ", "RE", "GF", "YT", "PM", "BL", "MF", "NC", "PF"];

export const ZONES = {
  eu: { price: 15, countries: EU, name: { fr: "Livraison Colissimo suivi — France, UE et Suisse", en: "Colissimo tracked delivery — France, EU & Switzerland" } },
  world: { price: 35, countries: WORLD, name: { fr: "Livraison Colissimo suivi — international", en: "Colissimo tracked delivery — international" } },
};

const OK_PATH = /^(photos\/[a-z0-9-]+\.jpg|media\/[A-Za-z0-9_-]{6,40}\.(jpg|png|webp))$/;
const baseTitle = (p) => p.replace(/^.*--/, "").replace(/\.[a-z]+$/, "").replace(/(^|-)([a-z])/g, (m, a, b) => a + b.toUpperCase());
export async function getCatalog() {
  try {
    const c = await getStore({ name: "site", consistency: "strong" }).get("content", { type: "json" });
    const list = c?.content?.store;
    if (Array.isArray(list) && list.length) {
      const out = {};
      for (const x of list) if (x && OK_PATH.test(x.p || "")) out[x.p] = String(x.title || "").trim().slice(0, 80) || PRODUCTS[x.p] || baseTitle(x.p);
      if (Object.keys(out).length) return out;
    }
  } catch {}
  return PRODUCTS;
}

export const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export const editions = () => getStore({ name: "editions", consistency: "strong" });
export const orders = () => getStore({ name: "orders", consistency: "strong" });
export const pending = () => getStore({ name: "pending", consistency: "strong" });

export const key = (p, f) => `${p}|${f}`;

export async function soldCount(store, k) {
  const v = await store.get(k, { type: "json" });
  return v && Number.isInteger(v.sold) ? v.sold : (SOLD_BEFORE[k] || 0);
}

// Vérifie le panier envoyé par le navigateur et recalcule tout côté serveur.
export async function checkCart(body) {
  const items = Array.isArray(body?.items) ? body.items : [];
  const zone = ZONES[body?.zone] ? body.zone : null;
  if (!items.length || items.length > 30) throw new Error("Panier vide ou invalide.");
  const CAT = await getCatalog();
  if (!zone) throw new Error("Zone de livraison invalide.");
  const merged = {};
  for (const it of items) {
    const q = Number(it?.q);
    if (!CAT[it?.p] || !FORMATS[it?.f] || !Number.isInteger(q) || q < 1 || q > FORMATS[it.f].edition) throw new Error("Article invalide.");
    merged[key(it.p, it.f)] = (merged[key(it.p, it.f)] || 0) + q;
  }
  const store = editions();
  const lines = [];
  for (const [k, q] of Object.entries(merged)) {
    const [p, f] = k.split("|");
    const sold = await soldCount(store, k);
    const cap = FORMATS[f].edition;
    if (sold + q > cap) throw new Error(sold >= cap ? `${CAT[p]} ${FORMATS[f].label} : épuisé.` : `${CAT[p]} ${FORMATS[f].label} : plus que ${cap - sold} exemplaire(s) disponible(s).`);
    lines.push({ p, f, q, title: CAT[p], label: FORMATS[f].label, price: FORMATS[f].price });
  }
  const subtotal = lines.reduce((a, l) => a + l.price * l.q, 0);
  const shipping = ZONES[zone].price;
  return { lines, zone, subtotal, shipping, total: subtotal + shipping };
}

// Attribue les numéros d'exemplaire après un paiement confirmé.
export async function assignNumbers(lines) {
  const store = editions();
  const out = [];
  for (const l of lines) {
    const k = key(l.p, l.f);
    const sold = await soldCount(store, k);
    const numbers = Array.from({ length: l.q }, (_, i) => sold + i + 1);
    await store.setJSON(k, { sold: sold + l.q, updated: new Date().toISOString() });
    out.push({ ...l, numbers: numbers.map((n) => `${n}/${FORMATS[l.f].edition}`) });
  }
  return out;
}

// Panier encodé pour les métadonnées Stripe (500 caractères max par clé → découpé en cart0, cart1…).
const enc = (p) => p.replace(/^photos\//, "").replace(/\.jpg$/, "");
const dec = (x) => (x.startsWith("media/") ? x : "photos/" + x + ".jpg");
export function cartMeta(lines) {
  const s = lines.map((l) => `${enc(l.p)}|${l.f}|${l.q}`).join(";");
  const out = {};
  for (let i = 0, k = 0; i < s.length; i += 480, k++) out["cart" + k] = s.slice(i, i + 480);
  return out;
}
export async function expandCartMeta(meta) {
  const s = Object.keys(meta || {}).filter((k) => /^cart\d+$/.test(k)).sort((a, b) => +a.slice(4) - +b.slice(4)).map((k) => meta[k]).join("");
  const CAT = await getCatalog();
  return s.split(";").filter(Boolean).map((x) => {
    const [pp, f, q] = x.split("|"); const p = dec(pp);
    return { p, f, q: Number(q), title: CAT[p] || PRODUCTS[p] || p, label: FORMATS[f]?.label, price: FORMATS[f]?.price };
  });
}
