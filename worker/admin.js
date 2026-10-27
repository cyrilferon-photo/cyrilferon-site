// Authentification du back office : mot de passe dans la variable secrète ADMIN_PASSWORD (Cloudflare),
// jeton signé (HMAC-SHA256) valable 7 jours.
const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(msg));
}
// Comparaison à temps constant (via deux HMAC, longueur toujours égale).
async function same(a, b) {
  const [x, y] = await Promise.all([hmac("cmp", String(a)), hmac("cmp", String(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let d = 0; for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];
  return d === 0;
}
const secret = (env) => env.ADMIN_PASSWORD || "";
const sign = async (env, s) => b64url(await hmac("cf-admin:" + secret(env), s));

export async function makeToken(env, days = 7) {
  const exp = String(Date.now() + days * 864e5);
  return exp + "." + (await sign(env, exp));
}
export async function checkPassword(env, pw) {
  return secret(env).length >= 8 && (await same(pw || "", secret(env)));
}
export async function isAdmin(env, req) {
  if (!secret(env)) return false;
  const t = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const [exp, sig] = t.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return same(sig, await sign(env, exp));
}
export { hmac };
