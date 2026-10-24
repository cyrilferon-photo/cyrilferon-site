// Envoi d'une photo depuis le back office (JPEG déjà réduit par le navigateur).
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import { json } from "../lib/shop.mjs";
import { isAdmin } from "../lib/admin.mjs";
export default async (req) => {
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);
  if (!isAdmin(req)) return json({ error: "Session expirée, reconnectez-vous." }, 401);
  const type = req.headers.get("content-type") || "image/jpeg";
  if (!/^image\/(jpeg|png|webp)$/.test(type)) return json({ error: "Format non accepté." }, 415);
  const buf = await req.arrayBuffer();
  if (!buf.byteLength || buf.byteLength > 5_500_000) return json({ error: "Image trop lourde (5 Mo maximum)." }, 413);
  const key = crypto.randomBytes(9).toString("base64url") + (type === "image/png" ? ".png" : type === "image/webp" ? ".webp" : ".jpg");
  await getStore("media").set(key, buf, { metadata: { type } });
  return json({ key, url: "/api/media/" + key });
};
export const config = { path: "/api/upload" };
