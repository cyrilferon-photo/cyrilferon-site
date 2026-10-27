export const PP_BASE = (env) => (env.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com");
export async function ppToken(env) {
  const id = env.PAYPAL_CLIENT_ID, secret = env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error("PayPal pas encore configuré.");
  const r = await fetch(`${PP_BASE(env)}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${id}:${secret}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const d = await r.json();
  if (!r.ok) throw new Error("Connexion PayPal impossible.");
  return d.access_token;
}
export const eur = (n) => ({ currency_code: "EUR", value: n.toFixed(2) });
