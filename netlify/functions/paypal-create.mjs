import { json, checkCart, pending } from "../lib/shop.mjs";
import { PP_BASE, ppToken, eur } from "../lib/paypal.mjs";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);
  let cart, body, token;
  try { body = await req.json(); cart = await checkCart(body); token = await ppToken(); } catch (e) { return json({ error: e.message }, 400); }
  const lang = body.lang === "en" ? "en" : "fr";
  const r = await fetch(`${PP_BASE()}/v2/checkout/orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        description: (lang === "fr" ? "Tirages d’art — Cyril Féron · Rétractation : " : "Fine art prints — Cyril Féron · Withdrawal form: ") + new URL(req.url).host + "/retractation",
        amount: { ...eur(cart.total), breakdown: { item_total: eur(cart.subtotal), shipping: eur(cart.shipping) } },
        items: cart.lines.map((l) => ({ name: `${l.title} — ${l.label}`.slice(0, 127), quantity: String(l.q), unit_amount: eur(l.price), category: "PHYSICAL_GOODS" })),
      }],
      application_context: { brand_name: "Cyril Féron", shipping_preference: "GET_FROM_FILE", user_action: "PAY_NOW", locale: lang === "fr" ? "fr-FR" : "en-GB" },
    }),
  });
  const d = await r.json();
  if (!r.ok) { console.error("paypal create", d); return json({ error: "PayPal a refusé la demande." }, 502); }
  await pending().setJSON(d.id, { lines: cart.lines, zone: cart.zone, total: cart.total, created: new Date().toISOString() });
  return json({ id: d.id });
};
export const config = { path: "/api/paypal-create" };
