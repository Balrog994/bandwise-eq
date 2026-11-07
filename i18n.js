// Translations: strings in _locales/<language>/messages.json, language chosen by Chrome
// (English if the browser language is not available).

const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)) || key;

// Applies translations to the HTML's data-i18n* attributes.
//   data-i18n="key"             → text
//   data-i18n-html="key"        → HTML (only for our own strings with <b>)
//   data-i18n-title / -placeholder / -aria → attributes
function localize(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll("[data-i18n-html]")) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.dataset.i18nAria));
  document.documentElement.lang = (chrome.i18n.getUILanguage() || "en").split("-")[0];
}
