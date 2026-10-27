/**
 * Copie automatique des commandes de cyrilferon.com dans une Google Sheet.
 *
 * Installation (5 minutes, une seule fois) :
 * 1. Créez une Google Sheet vide (par ex. « Commandes cyrilferon.com ») dans votre Google Drive.
 * 2. Menu Extensions → Apps Script. Effacez le code proposé et collez tout ce fichier. Enregistrez.
 * 3. Bouton « Déployer » → « Nouveau déploiement » → type « Application Web ».
 *    - Exécuter en tant que : Moi
 *    - Qui a accès : Tout le monde
 *    Cliquez sur « Déployer », autorisez l'accès à votre compte, puis copiez l'« URL de l'application Web ».
 * 4. Dans Cloudflare (projet cyrilferon → Settings → Runtime variables), ajoutez un Secret
 *    nommé SHEETS_URL avec cette URL.
 * 5. Dans le back office du site, onglet Stocks : « Envoyer vers Google Sheets » recopie tout l'historique.
 *    Ensuite chaque nouvelle vente s'ajoute toute seule.
 */
const HEAD = ["date", "commande", "paiement", "client", "email", "telephone", "adresse", "tirage", "format", "quantite", "numeros", "prix_unitaire", "total_commande"];
const TITLES = ["Date", "N° commande", "Paiement", "Client", "Email", "Téléphone", "Adresse de livraison", "Tirage", "Format", "Quantité", "Numéros d'exemplaire", "Prix unitaire (€)", "Total commande (€)"];

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const body = JSON.parse(e.postData.contents || "{}");
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    if (body.replace) sheet.clear();
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(TITLES);
      sheet.getRange(1, 1, 1, TITLES.length).setFontWeight("bold");
      sheet.setFrozenRows(1);
    }
    // évite les doublons (même commande, même tirage, mêmes numéros)
    const last = sheet.getLastRow();
    const seen = new Set(last > 1 ? sheet.getRange(2, 1, last - 1, HEAD.length).getValues().map((r) => [r[1], r[7], r[8], r[10]].join("|")) : []);
    const add = rows
      .map((r) => HEAD.map((h) => (h === "date" ? new Date(r.date) : r[h] === undefined ? "" : r[h])))
      .filter((r) => !seen.has([r[1], r[7], r[8], r[10]].join("|")));
    if (add.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, add.length, HEAD.length).setValues(add);
      sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).setNumberFormat("dd/mm/yyyy hh:mm");
      sheet.autoResizeColumns(1, HEAD.length);
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: true, added: add.length })).setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}
