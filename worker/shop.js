// Catalogue, prix, zones de livraison et éditions — source de vérité côté serveur.
// Le site affiche les mêmes valeurs, mais seuls ces chiffres-ci comptent au paiement.
import { db } from "./store.js";

export const FORMATS = {
  "24x30": { label: "24 × 30 cm", price: 90, edition: 15 },
  "40x50": { label: "40 × 50 cm", price: 200, edition: 10 },
  "50x70": { label: "50 × 70 cm", price: 320, edition: 5 },
};

// Catalogue par défaut ; remplacé par celui publié depuis le back office (contenu publié → store).
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
export async function getCatalog(env) {
  try {
    const c = await db(env).get("content");
    const list = c?.content?.store, defs = c?.content?.prices || {};
    const okP = (v) => Number.isInteger(+v) && +v >= 1 && +v <= 100000;
    const base = Object.fromEntries(Object.keys(FORMATS).map((f) => [f, okP(defs[f]) ? +defs[f] : FORMATS[f].price]));
    if (Array.isArray(list) && list.length) {
      const out = {};
      for (const x of list) if (x && OK_PATH.test(x.p || "")) {
        const prices = { ...base };
        for (const f of Object.keys(FORMATS)) if (x.prices && okP(x.prices[f])) prices[f] = +x.prices[f];
        out[x.p] = { title: String(x.title || "").trim().slice(0, 80) || PRODUCTS[x.p] || baseTitle(x.p), prices };
      }
      if (Object.keys(out).length) return out;
    }
    return Object.fromEntries(Object.entries(PRODUCTS).map(([p, t]) => [p, { title: t, prices: base }]));
  } catch {}
  const base = Object.fromEntries(Object.keys(FORMATS).map((f) => [f, FORMATS[f].price]));
  return Object.fromEntries(Object.entries(PRODUCTS).map(([p, t]) => [p, { title: t, prices: base }]));
}

export const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export const key = (p, f) => `${p}|${f}`;
export const edKey = (k) => "ed:" + k;

export async function soldCount(env, k) {
  const v = await db(env).get(edKey(k));
  return v && Number.isInteger(v.sold) ? v.sold : (SOLD_BEFORE[k] || 0);
}

// Vérifie le panier envoyé par le navigateur et recalcule tout côté serveur.
export async function checkCart(env, body) {
  const items = Array.isArray(body?.items) ? body.items : [];
  const zone = ZONES[body?.zone] ? body.zone : null;
  if (!items.length || items.length > 30) throw new Error("Panier vide ou invalide.");
  const CAT = await getCatalog(env);
  if (!zone) throw new Error("Zone de livraison invalide.");
  const merged = {};
  for (const it of items) {
    const q = Number(it?.q);
    if (!CAT[it?.p] || !FORMATS[it?.f] || !Number.isInteger(q) || q < 1 || q > FORMATS[it.f].edition) throw new Error("Article invalide.");
    merged[key(it.p, it.f)] = (merged[key(it.p, it.f)] || 0) + q;
  }
  const lines = [];
  for (const [k, q] of Object.entries(merged)) {
    const [p, f] = k.split("|");
    const sold = await soldCount(env, k);
    const cap = FORMATS[f].edition;
    if (sold + q > cap) throw new Error(sold >= cap ? `${CAT[p].title} ${FORMATS[f].label} : épuisé.` : `${CAT[p].title} ${FORMATS[f].label} : plus que ${cap - sold} exemplaire(s) disponible(s).`);
    lines.push({ p, f, q, title: CAT[p].title, label: FORMATS[f].label, price: CAT[p].prices[f] });
  }
  const subtotal = lines.reduce((a, l) => a + l.price * l.q, 0);
  const shipping = ZONES[zone].price;
  let promo = null, discount = 0;
  if (body?.promo) {
    const p = await getPromo(env, body.promo);
    if (!p) throw new Error(PROMO_BAD);
    discount = promoDiscount(p, subtotal);
    promo = { code: p.code, kind: p.kind, value: p.value, discount };
  }
  return { lines, zone, subtotal, shipping, promo, discount, total: Math.round((subtotal - discount + shipping) * 100) / 100 };
}

// ---------- codes promo ----------
// La remise porte uniquement sur le prix des tirages (sous-total), jamais sur les frais de port.
export const PROMO_BAD = "Ce code promo n’est pas valide ou a expiré.";
export const promoCode = (s) => String(s || "").trim().toUpperCase().replace(/\s+/g, "");
export const PROMO_RE = /^[A-Z0-9_-]{3,30}$/;
export const todayParis = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" }); // AAAA-MM-JJ
export async function getPromo(env, raw) {
  const code = promoCode(raw);
  if (!PROMO_RE.test(code)) return null;
  const p = await db(env).get("promo:" + code);
  if (!p || !p.active) return null;
  const d = todayParis();
  if ((p.from && d < p.from) || (p.until && d > p.until)) return null;
  if (p.max > 0 && (p.uses || 0) >= p.max) return null;
  return p;
}
// Montant de la remise en euros (au centime), jamais supérieur au sous-total.
export const promoDiscount = (p, subtotal) =>
  Math.min(subtotal, p.kind === "pct" ? Math.round(subtotal * p.value) / 100 : p.value);

// Attribue les numéros d'exemplaire après un paiement confirmé.
export async function assignNumbers(env, lines) {
  const out = [];
  for (const l of lines) {
    const k = key(l.p, l.f);
    const sold = await db(env).addSold(edKey(k), l.q, SOLD_BEFORE[k] || 0); // atomique
    const numbers = Array.from({ length: l.q }, (_, i) => sold + i + 1);
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
export async function expandCartMeta(env, meta) {
  const s = Object.keys(meta || {}).filter((k) => /^cart\d+$/.test(k)).sort((a, b) => +a.slice(4) - +b.slice(4)).map((k) => meta[k]).join("");
  const CAT = await getCatalog(env);
  return s.split(";").filter(Boolean).map((x) => {
    const [pp, f, q] = x.split("|"); const p = dec(pp);
    return { p, f, q: Number(q), title: CAT[p]?.title || PRODUCTS[p] || p, label: FORMATS[f]?.label, price: CAT[p]?.prices?.[f] ?? FORMATS[f]?.price };
  });
}
