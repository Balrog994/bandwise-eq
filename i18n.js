// Traduzioni: testi in _locales/<lingua>/messages.json, lingua scelta da Chrome
// (inglese se la lingua del browser non è disponibile).

const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)) || key;

// Applica le traduzioni agli attributi data-i18n* dell'HTML.
//   data-i18n="chiave"          → testo
//   data-i18n-html="chiave"     → HTML (solo per i nostri testi con <b>)
//   data-i18n-title / -placeholder / -aria → attributi
function localize(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll("[data-i18n-html]")) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.dataset.i18nAria));
  document.documentElement.lang = (chrome.i18n.getUILanguage() || "en").split("-")[0];
}
