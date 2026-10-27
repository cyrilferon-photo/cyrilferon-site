// Point d'entrée du site sur Cloudflare Workers.
// Les fichiers du site (index.html, photos…) sont servis directement par Cloudflare ;
// ce Worker ne reçoit que les adresses qui ne correspondent à aucun fichier : /api/*, /store, etc.
import { db, SiteStore } from "./store.js";
import { json, checkCart, cartMeta, expandCartMeta, assignNumbers, getCatalog, soldCount, key, edKey, ZONES, FORMATS, SOLD_BEFORE } from "./shop.js";
import { isAdmin, checkPassword, makeToken, hmac } from "./admin.js";
import { PP_BASE, ppToken, eur } from "./paypal.js";

export { SiteStore };

const FEED = "https://feeds.behold.so/Z14F54n7vMxO5coDfGVr";
const notAllowed = () => json({ error: "Méthode non autorisée." }, 405);
const randomKey = (n = 9) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ---------- Stripe ----------
function form(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    const name = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (typeof v === "object") form(v, name, out);
    else out.append(name, String(v));
  }
  return out;
}

async function stripeCheckout(req, env) {
  if (req.method !== "POST") return notAllowed();
  const secret = env.STRIPE_SECRET_KEY;
  if (!secret) return json({ error: "Paiement par carte pas encore configuré." }, 503);
  let cart, body;
  try { body = await req.json(); cart = await checkCart(env, body); } catch (e) { return json({ error: e.message }, 400); }
  const lang = body.lang === "en" ? "en" : "fr";
  const origin = new URL(req.url).origin;
  const host = origin.replace(/^https?:\/\//, "");
  const zone = ZONES[cart.zone];
  const params = form({
    mode: "payment",
    locale: lang,
    success_url: `${origin}/store?commande=ok`,
    cancel_url: `${origin}/store`,
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
    payment_intent_data: { description: cart.lines.map((l) => `${l.q} × ${l.title} ${l.label}`).join(", ") + (lang === "fr" ? ` · Formulaire de rétractation : ${origin}/retractation` : ` · Withdrawal form: ${origin}/retractation`) },
    custom_text: {
      submit: { message: lang === "fr" ? `Droit de rétractation de 14 jours à réception. [Formulaire de rétractation](${origin}/retractation)` : `14-day right of withdrawal from delivery. [Withdrawal form](${origin}/retractation)` },
      after_submit: { message: lang === "fr" ? `Merci ! Formulaire de rétractation : [${host}/retractation](${origin}/retractation)` : `Thank you! Withdrawal form: [${host}/retractation](${origin}/retractation)` },
    },
  });
  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const data = await r.json();
  if (!r.ok) { console.error("stripe", JSON.stringify(data)); return json({ error: "Stripe a refusé la demande." }, 502); }
  return json({ url: data.url });
}

async function verifyStripe(raw, header, secret) {
  const h = String(header || "");
  const t = (h.split(",").find((s) => s.trim().startsWith("t=")) || "").trim().slice(2);
  const sigs = h.split(",").filter((s) => s.trim().startsWith("v1=")).map((s) => s.trim().slice(3));
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = [...new Uint8Array(await hmac(secret, `${t}.${raw}`))].map((b) => b.toString(16).padStart(2, "0")).join("");
  let ok = false;
  for (const s of sigs) {
    if (s.length !== expected.length) continue;
    let d = 0; for (let i = 0; i < s.length; i++) d |= s.charCodeAt(i) ^ expected.charCodeAt(i);
    if (d === 0) ok = true;
  }
  return ok;
}

async function stripeWebhook(req, env) {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return json({ error: "not configured" }, 503);
  const raw = await req.text();
  if (!(await verifyStripe(raw, req.headers.get("stripe-signature"), secret))) return json({ error: "bad signature" }, 400);
  const event = JSON.parse(raw);
  const s = event.data?.object;
  const paid = (event.type === "checkout.session.completed" && s?.payment_status === "paid") || event.type === "checkout.session.async_payment_succeeded";
  if (!paid) return json({ received: true });
  const store = db(env), id = `order:stripe_${s.id}`;
  if (await store.get(id)) return json({ received: true, duplicate: true });
  const lines = await assignNumbers(env, await expandCartMeta(env, s.metadata));
  await store.put(id, {
    provider: "stripe",
    id: s.id,
    payment: s.payment_intent,
    date: new Date().toISOString(),
    zone: s.metadata?.zone,
    email: s.customer_details?.email,
    name: s.customer_details?.name,
    phone: s.customer_details?.phone,
    shipping: s.collected_information?.shipping_details || s.shipping_details || null,
    total: (s.amount_total || 0) / 100,
    lines,
  });
  return json({ received: true });
}

// ---------- PayPal ----------
async function paypalCreate(req, env) {
  if (req.method !== "POST") return notAllowed();
  let cart, body, token;
  try { body = await req.json(); cart = await checkCart(env, body); token = await ppToken(env); } catch (e) { return json({ error: e.message }, 400); }
  const lang = body.lang === "en" ? "en" : "fr";
  const r = await fetch(`${PP_BASE(env)}/v2/checkout/orders`, {
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
  if (!r.ok) { console.error("paypal create", JSON.stringify(d)); return json({ error: "PayPal a refusé la demande." }, 502); }
  await db(env).put(`pending:${d.id}`, { lines: cart.lines, zone: cart.zone, total: cart.total, created: new Date().toISOString() });
  return json({ id: d.id });
}

async function paypalCapture(req, env) {
  if (req.method !== "POST") return notAllowed();
  let orderID, token;
  try { ({ orderID } = await req.json()); token = await ppToken(env); } catch (e) { return json({ error: e.message }, 400); }
  if (!/^[A-Z0-9]{8,32}$/.test(String(orderID))) return json({ error: "Commande invalide." }, 400);
  const store = db(env), id = `order:paypal_${orderID}`;
  const done = await store.get(id);
  if (done) return json({ ok: true, lines: done.lines });
  const cart = await store.get(`pending:${orderID}`);
  if (!cart) return json({ error: "Commande inconnue." }, 404);
  const r = await fetch(`${PP_BASE(env)}/v2/checkout/orders/${orderID}/capture`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const d = await r.json();
  if (!r.ok || d.status !== "COMPLETED") { console.error("paypal capture", JSON.stringify(d)); return json({ error: "Le paiement PayPal n’a pas abouti." }, 402); }
  const pu = d.purchase_units?.[0] || {};
  const country = pu.shipping?.address?.country_code;
  const lines = await assignNumbers(env, cart.lines);
  await store.put(id, {
    provider: "paypal",
    id: orderID,
    capture: pu.payments?.captures?.[0]?.id,
    date: new Date().toISOString(),
    zone: cart.zone,
    zoneMismatch: Boolean(country && !ZONES[cart.zone].countries.includes(country)),
    email: d.payer?.email_address,
    name: [d.payer?.name?.given_name, d.payer?.name?.surname].filter(Boolean).join(" "),
    shipping: pu.shipping || null,
    total: cart.total,
    lines,
  });
  await store.del(`pending:${orderID}`);
  return json({ ok: true, lines });
}

// ---------- boutique ----------
const config = (env) => json({
  stripe: Boolean(env.STRIPE_SECRET_KEY),
  paypalClientId: env.PAYPAL_CLIENT_ID || null,
  editions: Object.fromEntries(Object.entries(FORMATS).map(([k, f]) => [k, f.edition])),
  zones: Object.fromEntries(Object.entries(ZONES).map(([k, z]) => [k, { price: z.price, countries: z.countries }])),
});

async function stock(req, env) {
  const CAT = await getCatalog(env);
  if (req.method === "PUT") { // correction manuelle d'un compteur depuis le back office
    if (!(await isAdmin(env, req))) return json({ error: "Session expirée, reconnectez-vous." }, 401);
    let b; try { b = await req.json(); } catch { return json({ error: "Requête invalide." }, 400); }
    const sold = Number(b?.sold);
    if (!CAT[b?.p] || !FORMATS[b?.f] || !Number.isInteger(sold) || sold < 0 || sold > FORMATS[b.f].edition) return json({ error: "Valeur invalide." }, 400);
    await db(env).setSold(edKey(key(b.p, b.f)), sold);
    return json({ ok: true });
  }
  const sold = {};
  for (const p of Object.keys(CAT)) for (const f of Object.keys(FORMATS)) sold[key(p, f)] = await soldCount(env, key(p, f));
  return json({ editions: Object.fromEntries(Object.entries(FORMATS).map(([k, f]) => [k, f.edition])), sold });
}

async function ordersList(req, env) {
  if (!(await isAdmin(env, req))) return json({ error: "Session expirée, reconnectez-vous." }, 401);
  const list = await db(env).list("order:", 200);
  return json({ orders: list.map((x) => x.v).sort((a, b) => String(b.date).localeCompare(String(a.date))) });
}

// Remise à zéro avant l'ouverture : supprime commandes et compteurs (les ventes d'avant restent comptées).
async function reset(req, env) {
  if (req.method !== "POST") return notAllowed();
  if (!(await isAdmin(env, req))) return json({ error: "Session expirée, reconnectez-vous." }, 401);
  let b; try { b = await req.json(); } catch {}
  if (b?.confirm !== "EFFACER") return json({ error: "Confirmation manquante." }, 400);
  const s = db(env);
  const n = { orders: await s.purge("order:"), editions: await s.purge("ed:"), pending: await s.purge("pending:") };
  return json({ ok: true, ...n });
}

// ---------- back office ----------
async function login(req, env) {
  if (req.method !== "POST") return notAllowed();
  if (!env.ADMIN_PASSWORD) return json({ error: "Mot de passe non configuré sur Cloudflare (variable ADMIN_PASSWORD)." }, 503);
  let pw = ""; try { ({ password: pw } = await req.json()); } catch {}
  await new Promise((r) => setTimeout(r, 400)); // ralentit les essais
  if (!(await checkPassword(env, pw))) return json({ error: "Mot de passe incorrect." }, 401);
  return json({ token: await makeToken(env) });
}

async function content(req, env) {
  const store = db(env);
  if (req.method === "GET") return json((await store.get("content")) || { content: null });
  if (req.method !== "PUT") return notAllowed();
  if (!(await isAdmin(env, req))) return json({ error: "Session expirée, reconnectez-vous." }, 401);
  let body; try { body = await req.json(); } catch { return json({ error: "Contenu invalide." }, 400); }
  const c = body?.content;
  if (!c || !Array.isArray(c.galleries)) return json({ error: "Contenu invalide." }, 400);
  if (JSON.stringify(c).length > 1_800_000) return json({ error: "Contenu trop volumineux." }, 413);
  const prev = await store.get("content");
  if (prev?.content) await store.put("content-prev", prev); // une sauvegarde de la version précédente
  const doc = { content: c, updated: new Date().toISOString() };
  await store.put("content", doc);
  return json({ ok: true, updated: doc.updated });
}

async function upload(req, env) {
  if (req.method !== "POST") return notAllowed();
  if (!(await isAdmin(env, req))) return json({ error: "Session expirée, reconnectez-vous." }, 401);
  const type = req.headers.get("content-type") || "image/jpeg";
  if (!/^image\/(jpeg|png|webp)$/.test(type)) return json({ error: "Format non accepté." }, 415);
  const buf = await req.arrayBuffer();
  if (!buf.byteLength || buf.byteLength > 5_500_000) return json({ error: "Image trop lourde (5 Mo maximum)." }, 413);
  const k = randomKey() + (type === "image/png" ? ".png" : type === "image/webp" ? ".webp" : ".jpg");
  await db(env).mediaPut(k, type, buf);
  return json({ key: k, url: "/api/media/" + k });
}

async function media(k, env, ctx, req) {
  if (!/^[A-Za-z0-9_-]{6,40}\.(jpg|png|webp)$/.test(k)) return new Response("Not found", { status: 404 });
  const cache = caches.default, ck = new Request(new URL(req.url).toString());
  const hit = await cache.match(ck);
  if (hit) return hit;
  const r = await db(env).mediaGet(k);
  if (!r) return new Response("Not found", { status: 404 });
  const res = new Response(r.data, { headers: { "content-type": r.type || "image/jpeg", "cache-control": "public, max-age=31536000, immutable" } });
  ctx.waitUntil(cache.put(ck, res.clone()));
  return res;
}

// ---------- contact ----------
const clean = (s, n) => String(s || "").replace(/\r/g, "").trim().slice(0, n);
const SUBJECTS = { session: "Commande de séance photo", print: "Achat d’un tirage", other: "Autre demande" };
async function contact(req, env, ctx) {
  if (req.method !== "POST") return notAllowed();
  let f;
  try {
    const ct = req.headers.get("content-type") || "";
    f = ct.includes("application/json") ? await req.json() : Object.fromEntries(await req.formData());
  } catch { return json({ error: "Message invalide." }, 400); }
  if (f["bot-field"]) return json({ ok: true }); // robot
  const m = { name: clean(f.name, 120), email: clean(f.email, 200), subject: SUBJECTS[f.subject] || clean(f.subject, 200), message: clean(f.message, 5000), date: new Date().toISOString() };
  if (!m.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.email) || !m.message) return json({ error: "Merci de remplir tous les champs." }, 400);
  await db(env).put(`msg:${m.date}:${randomKey(4)}`, m);
  if (env.EMAIL && env.MAIL_FROM && env.MAIL_TO) ctx.waitUntil(sendMail(env, m).catch((e) => console.error("mail", e?.message || e)));
  return json({ ok: true });
}
async function sendMail(env, m) {
  const subject = `Site — message de ${m.name}${m.subject ? " : " + m.subject : ""}`;
  const text = `${m.message}\n\n—\n${m.name} <${m.email}>\n${m.date}`;
  // API « Email Service » (env.EMAIL.send) ; repli sur l'API Email Routing (message MIME brut).
  let first;
  try {
    await env.EMAIL.send({ to: env.MAIL_TO, from: { email: env.MAIL_FROM, name: "Site cyrilferon.com" }, replyTo: m.email, subject, text });
    return;
  } catch (e) { first = e; }
  const { EmailMessage } = await import("cloudflare:email");
  const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
  const raw = [
    `From: "Site cyrilferon.com" <${env.MAIL_FROM}>`, `To: <${env.MAIL_TO}>`, `Reply-To: <${m.email}>`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`, `Message-ID: <${randomKey(12)}@${env.MAIL_FROM.split("@")[1]}>`,
    `Date: ${new Date().toUTCString()}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "",
    b64(text).replace(/.{76}/g, "$&\r\n"),
  ].join("\r\n");
  try { await env.EMAIL.send(new EmailMessage(env.MAIL_FROM, env.MAIL_TO, raw)); }
  catch (e) { console.error("mail (format simple)", first?.message); throw e; }
}

async function messages(req, env) {
  if (!(await isAdmin(env, req))) return json({ error: "Session expirée, reconnectez-vous." }, 401);
  return json({ messages: (await db(env).list("msg:", 200)).map((x) => x.v) });
}

// ---------- Instagram (Behold), mis en cache 1 h ----------
async function instagram(req, ctx) {
  const cache = caches.default, ck = new Request(new URL("/api/instagram", req.url).toString());
  const hit = await cache.match(ck);
  if (hit) return hit;
  try {
    const r = await fetch(FEED);
    if (!r.ok) throw new Error(String(r.status));
    const d = await r.json();
    const posts = (Array.isArray(d) ? d : d.posts || []).slice(0, 6).map((p) => ({
      href: p.permalink,
      src: p.sizes?.medium?.mediaUrl || (p.mediaType === "VIDEO" ? p.thumbnailUrl : p.mediaUrl),
      video: p.mediaType === "VIDEO",
      alt: (p.prunedCaption || p.caption || "").slice(0, 100),
    }));
    const res = new Response(JSON.stringify({ posts }), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=3600" } });
    ctx.waitUntil(cache.put(ck, res.clone()));
    return res;
  } catch {
    return new Response(JSON.stringify({ posts: [] }), { status: 502, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
}

// ---------- routeur ----------
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url), p = url.pathname;
    try {
      switch (p) {
        case "/api/config": return config(env);
        case "/api/stock": return await stock(req, env);
        case "/api/orders": return await ordersList(req, env);
        case "/api/reset": return await reset(req, env);
        case "/api/stripe-checkout": return await stripeCheckout(req, env);
        case "/api/stripe-webhook": return await stripeWebhook(req, env);
        case "/api/paypal-create": return await paypalCreate(req, env);
        case "/api/paypal-capture": return await paypalCapture(req, env);
        case "/api/login": return await login(req, env);
        case "/api/content": return await content(req, env);
        case "/api/upload": return await upload(req, env);
        case "/api/contact": return await contact(req, env, ctx);
        case "/api/messages": return await messages(req, env);
        case "/api/instagram": return await instagram(req, ctx);
      }
      if (p.startsWith("/api/media/")) return await media(p.slice(11), env, ctx, req);
      if (p.startsWith("/api/")) return json({ error: "Introuvable." }, 404);
      // Boutique à l'adresse /store : même page, ouverte sur les tirages.
      if (p === "/store/") return Response.redirect(url.origin + "/store" + url.search, 301);
      if (p === "/store") return env.ASSETS.fetch(new Request(new URL("/", url), req));
      return env.ASSETS.fetch(req);
    } catch (e) {
      console.error(p, e?.stack || e);
      return json({ error: "Erreur du serveur, réessayez dans un instant." }, 500);
    }
  },
};
