// Stockage du site : un Durable Object unique (base SQLite gérée par Cloudflare, cohérence forte).
// Contient le contenu publié, les éditions vendues, les commandes, les paniers PayPal en attente,
// les photos envoyées depuis le back office et les messages du formulaire de contact.
import { DurableObject } from "cloudflare:workers";

const CHUNK = 1_500_000; // une valeur stockée est limitée à 2 Mo : les photos sont découpées

export class SiteStore extends DurableObject {
  async get(k) { return (await this.ctx.storage.get(k)) ?? null; }
  async put(k, v) { await this.ctx.storage.put(k, v); return true; }
  async del(k) { await this.ctx.storage.delete(k); return true; }
  async list(prefix, limit = 500) {
    const m = await this.ctx.storage.list({ prefix, limit, reverse: true });
    return [...m.entries()].map(([k, v]) => ({ k, v }));
  }
  // Ajoute q exemplaires vendus de façon atomique ; renvoie le nombre vendu avant l'ajout.
  async addSold(k, q, base) {
    const cur = await this.ctx.storage.get(k);
    const sold = cur && Number.isInteger(cur.sold) ? cur.sold : base;
    await this.ctx.storage.put(k, { sold: sold + q, updated: new Date().toISOString() });
    return sold;
  }
  // Remet un compteur à une valeur donnée (back office, onglet Stocks).
  async setSold(k, sold) {
    await this.ctx.storage.put(k, { sold, updated: new Date().toISOString() });
    return true;
  }
  // Supprime toutes les clés d'un préfixe (remise à zéro avant l'ouverture).
  async purge(prefix) {
    let n = 0;
    for (;;) {
      const keys = [...(await this.ctx.storage.list({ prefix, limit: 128 })).keys()];
      if (!keys.length) return n;
      await this.ctx.storage.delete(keys); n += keys.length;
    }
  }
  // Statistiques de visite anonymes : un document par jour, compteurs incrémentés ici (atomique).
  async hit(day, kind, key) {
    const k = "st:" + day;
    const d = (await this.ctx.storage.get(k)) || { v: 0 };
    if (kind === "v") { d.v = (d.v || 0) + 1; if (key) { d.ref = d.ref || {}; d.ref[key] = (d.ref[key] || 0) + 1; } }
    else {
      const m = (d[kind] = d[kind] || {});
      if (m[key] === undefined && Object.keys(m).length >= 1000) return false;
      m[key] = (m[key] || 0) + 1;
    }
    await this.ctx.storage.put(k, d);
    return true;
  }
  // Corrige les statistiques (tests) : remet une rubrique à zéro, ou fixe le total d'une ligne.
  async statsEdit(kind, key, value) {
    const all = await this.ctx.storage.list({ prefix: "st:" });
    const kinds = kind === "l" ? ["l", "u"] : [kind];
    const batch = {};
    for (const [k, d] of all) {
      let ch = false;
      for (const kd of kinds) {
        if (!d[kd]) continue;
        if (key == null) { delete d[kd]; ch = true; }
        else if (d[kd][key] !== undefined) { delete d[kd][key]; ch = true; }
      }
      if (ch) batch[k] = d;
    }
    if (Object.keys(batch).length) await this.ctx.storage.put(batch);
    if (key != null && value > 0) {
      const tk = "st:" + new Date().toISOString().slice(0, 10);
      const d = (await this.ctx.storage.get(tk)) || { v: 0 };
      (d[kind] = d[kind] || {})[key] = value;
      await this.ctx.storage.put(tk, d);
    }
    return true;
  }
  async mediaPut(key, type, buf) {
    const bytes = new Uint8Array(buf);
    const parts = Math.ceil(bytes.length / CHUNK);
    const batch = { [`media:${key}`]: { type, parts, size: bytes.length } };
    for (let i = 0; i < parts; i++) batch[`media:${key}:${i}`] = bytes.slice(i * CHUNK, (i + 1) * CHUNK);
    await this.ctx.storage.put(batch);
    return true;
  }
  async mediaGet(key) {
    const meta = await this.ctx.storage.get(`media:${key}`);
    if (!meta) return null;
    const out = new Uint8Array(meta.size);
    for (let i = 0, o = 0; i < meta.parts; i++) {
      const c = await this.ctx.storage.get(`media:${key}:${i}`);
      out.set(c, o); o += c.length;
    }
    return { type: meta.type, data: out.buffer };
  }
}

// Accès depuis le Worker : toujours la même instance « site ».
export const db = (env) => env.SITE.get(env.SITE.idFromName("site"));
