// Service worker: ottiene lo stream della scheda e gestisce il documento offscreen
// (invisibile) dove gira l'elaborazione audio. Nessuna finestra viene aperta.

async function hasOffscreen() {
  const ctxs = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  return ctxs.length > 0;
}

let creating = null;
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  creating ??= chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Processing the tab's audio with the equalizer"
  }).finally(() => { creating = null; });
  await creating;
}

const toOffscreen = (msg) => chrome.runtime.sendMessage({ target: "offscreen", ...msg });

async function setBadge(tabId, on) {
  try {
    await chrome.action.setBadgeText({ tabId, text: on ? "EQ" : "" });
    if (on) await chrome.action.setBadgeBackgroundColor({ tabId, color: "#1a73e8" });
  } catch { /* scheda già chiusa */ }
}

async function closeIfIdle() {
  if (!(await hasOffscreen())) return;
  const { tabs } = await toOffscreen({ cmd: "status" });
  if (!tabs.length) await chrome.offscreen.closeDocument();
}

async function handle(msg) {
  switch (msg.cmd) {
    case "status":
      return (await hasOffscreen()) ? toOffscreen({ cmd: "status" }) : { tabs: [] };

    case "start": {
      let streamId;
      try {
        streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: msg.tabId });
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
      await ensureOffscreen();
      const res = await toOffscreen({ cmd: "start", tabId: msg.tabId, streamId, eq: msg.eq, match: msg.match });
      if (res?.ok) await setBadge(msg.tabId, true);
      return res;
    }

    case "stop": {
      if (await hasOffscreen()) await toOffscreen({ cmd: "stop", tabId: msg.tabId });
      await setBadge(msg.tabId, false);
      await closeIfIdle();
      return { ok: true };
    }

    case "ended": // la scheda è stata chiusa o la cattura è terminata
      await setBadge(msg.tabId, false);
      await closeIfIdle();
      return { ok: true };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "sw") return;
  handle(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

// Ogni scheda ha la sua configurazione in chrome.storage.session ("tab:<id>"):
// quando la scheda viene chiusa non serve più.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove("tab:" + tabId);
});
