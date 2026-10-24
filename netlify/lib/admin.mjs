// Authentification du back office : mot de passe dans la variable ADMIN_PASSWORD (Netlify),
// jeton signé (HMAC) valable 7 jours.
import crypto from "node:crypto";
const secret = () => process.env.ADMIN_PASSWORD || "";
const sign = (s) => crypto.createHmac("sha256", "cf-admin:" + secret()).update(s).digest("base64url");
export function makeToken(days = 7) {
  const exp = String(Date.now() + days * 864e5);
  return exp + "." + sign(exp);
}
export function checkPassword(pw) {
  const a = Buffer.from(String(pw || "")), b = Buffer.from(secret());
  return secret().length >= 8 && a.length === b.length && crypto.timingSafeEqual(a, b);
}
export function isAdmin(req) {
  if (!secret()) return false;
  const t = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const [exp, sig] = t.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
