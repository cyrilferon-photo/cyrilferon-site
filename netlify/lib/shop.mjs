// Catalogue, prix, zones de livraison et éditions — source de vérité côté serveur.
// Le site affiche les mêmes valeurs, mais seuls ces chiffres-ci comptent au paiement.
import { getStore } from "@netlify/blobs";

export const EDITION = 30; // exemplaires par photo et par format

export const FORMATS = {
  "24x30": { label: "24 × 30 cm", price: 90 },
  "40x50": { label: "40 × 50 cm", price: 200 },
  "50x70": { label: "50 × 70 cm", price: 320 },
};

export const PRODUCTS = {
  "photos/nu-artistique--sloane-06-v2.jpg": "OFF - Sloane",
  "photos/nu-artistique--cerizvodka-15.jpg": "FLOWERS - Cerizvodka",
  "photos/nu-artistique--jess-04.jpg": "LILY - Jess",
  "photos/nu-artistique--cerizvodka-07.jpg": "MIRROR - Cerizvodka",
  "photos/nu-artistique--sloane-09.jpg": "FREEDOM - Sloane",
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
  if (!zone) throw new Error("Zone de livraison invalide.");
  const merged = {};
  for (const it of items) {
    const q = Number(it?.q);
    if (!PRODUCTS[it?.p] || !FORMATS[it?.f] || !Number.isInteger(q) || q < 1 || q > EDITION) throw new Error("Article invalide.");
    merged[key(it.p, it.f)] = (merged[key(it.p, it.f)] || 0) + q;
  }
  const store = editions();
  const lines = [];
  for (const [k, q] of Object.entries(merged)) {
    const [p, f] = k.split("|");
    const sold = await soldCount(store, k);
    if (sold + q > EDITION) throw new Error(`${PRODUCTS[p]} ${FORMATS[f].label} : plus que ${Math.max(0, EDITION - sold)} exemplaire(s) disponible(s).`);
    lines.push({ p, f, q, title: PRODUCTS[p], label: FORMATS[f].label, price: FORMATS[f].price });
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
    out.push({ ...l, numbers: numbers.map((n) => `${n}/${EDITION}`) });
  }
  return out;
}

// Format court pour les métadonnées Stripe (500 caractères max) : "indexPhoto.format.quantité;…"
const IDS = Object.keys(PRODUCTS);
export const compactCart = (lines) => lines.map((l) => `${IDS.indexOf(l.p)}.${l.f}.${l.q}`).join(";");
export function expandCart(s) {
  return String(s || "").split(";").filter(Boolean).map((x) => {
    const [i, f, q] = x.split(".");
    const p = IDS[Number(i)];
    return { p, f, q: Number(q), title: PRODUCTS[p], label: FORMATS[f]?.label, price: FORMATS[f]?.price };
  });
}
