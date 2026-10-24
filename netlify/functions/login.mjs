import { json } from "../lib/shop.mjs";
import { checkPassword, makeToken } from "../lib/admin.mjs";
export default async (req) => {
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);
  if (!process.env.ADMIN_PASSWORD) return json({ error: "Mot de passe non configuré sur Netlify (variable ADMIN_PASSWORD)." }, 503);
  let pw = ""; try { ({ password: pw } = await req.json()); } catch {}
  await new Promise((r) => setTimeout(r, 400)); // ralentit les essais
  if (!checkPassword(pw)) return json({ error: "Mot de passe incorrect." }, 401);
  return json({ token: makeToken() });
};
export const config = { path: "/api/login" };
