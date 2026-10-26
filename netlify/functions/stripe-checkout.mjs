// Crée une session de paiement Stripe Checkout (page de paiement hébergée par Stripe).
import { json, checkCart, cartMeta, ZONES } from "../lib/shop.mjs";

function form(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    const name = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (typeof v === "object") form(v, name, out);
    else out.append(name, String(v));
  }
  return out;
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return json({ error: "Paiement par carte pas encore configuré." }, 503);
  let cart, body;
  try { body = await req.json(); cart = await checkCart(body); } catch (e) { return json({ error: e.message }, 400); }
  const lang = body.lang === "en" ? "en" : "fr";
  const origin = new URL(req.url).origin;
  const zone = ZONES[cart.zone];
  const params = form({
    mode: "payment",
    locale: lang,
    success_url: `${origin}/?commande=ok#boutique`,
    cancel_url: `${origin}/#boutique`,
    line_items: Object.fromEntries(cart.lines.map((l, i) => [i, {
      quantity: l.q,
      price_data: {
        currency: "eur",
        unit_amount: l.price * 100,
        product_data: {
          name: `${l.title} — ${l.label}`,
          description: lang === "fr" ? "Tirage d’art signé et numéroté, Hahnemühle Museum Etching 350 g" : "Signed and numbered fine art print, Hahnemühle Museum Etching 350 gsm",
        },
      },
    }])),
    shipping_address_collection: { allowed_countries: Object.fromEntries(zone.countries.map((c, i) => [i, c])) },
    shipping_options: { 0: { shipping_rate_data: { type: "fixed_amount", display_name: zone.name[lang], fixed_amount: { amount: zone.price * 100, currency: "eur" } } } },
    phone_number_collection: { enabled: "true" },
    metadata: { ...cartMeta(cart.lines), zone: cart.zone },
    payment_intent_data: { description: cart.lines.map((l) => `${l.q} × ${l.title} ${l.label}`).join(", ") },
  });
  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const data = await r.json();
  if (!r.ok) { console.error("stripe", data); return json({ error: "Stripe a refusé la demande." }, 502); }
  return json({ url: data.url });
};
export const config = { path: "/api/stripe-checkout" };
