// Contenu publié du site (galeries, ordre, textes, photos ajoutées) : lu par tous, écrit par le back office.
import { getStore } from "@netlify/blobs";
import { json } from "../lib/shop.mjs";
import { isAdmin } from "../lib/admin.mjs";
const store = () => getStore({ name: "site", consistency: "strong" });
export default async (req) => {
  if (req.method === "GET") {
    const c = await store().get("content", { type: "json" });
    return json(c || { content: null });
  }
  if (req.method === "PUT") {
    if (!isAdmin(req)) return json({ error: "Session expirée, reconnectez-vous." }, 401);
    let body; try { body = await req.json(); } catch { return json({ error: "Contenu invalide." }, 400); }
    const c = body?.content;
    if (!c || !Array.isArray(c.galleries)) return json({ error: "Contenu invalide." }, 400);
    const raw = JSON.stringify(c);
    if (raw.length > 2_000_000) return json({ error: "Contenu trop volumineux." }, 413);
    const prev = await store().get("content", { type: "json" });
    if (prev?.content) await store().setJSON("content-prev", prev); // une sauvegarde de la version précédente
    const doc = { content: c, updated: new Date().toISOString() };
    await store().setJSON("content", doc);
    return json({ ok: true, updated: doc.updated });
  }
  return json({ error: "Méthode non autorisée." }, 405);
};
export const config = { path: "/api/content" };
