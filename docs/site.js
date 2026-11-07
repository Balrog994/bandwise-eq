// Click a screenshot to see it full size; click again or press Esc to close.
// Without JavaScript the link simply opens the image.
(() => {
  const dialog = document.createElement("dialog");
  dialog.className = "zoom";
  const img = document.createElement("img");
  dialog.append(img);
  document.body.append(dialog);
  dialog.addEventListener("click", () => dialog.close());

  for (const link of document.querySelectorAll("a.shot")) {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      img.src = link.href;
      img.alt = link.querySelector("img")?.alt || "";
      dialog.showModal();
    });
  }
})();

// Light/dark theme toggle. Until the visitor chooses, the site follows the system theme;
// the choice is remembered in this browser only (localStorage, no cookies).
(() => {
  const button = document.querySelector(".theme-toggle");
  if (!button) return;
  const html = document.documentElement;
  const systemDark = matchMedia("(prefers-color-scheme: dark)");
  const isDark = () => (html.dataset.theme ? html.dataset.theme === "dark" : systemDark.matches);
  const sync = () => {
    const dark = isDark();
    button.classList.toggle("is-dark", dark);
    const label = dark ? "Switch to light theme" : "Switch to dark theme";
    button.setAttribute("aria-label", label);
    button.title = label;
  };
  button.addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    html.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch {}
    sync();
  });
  systemDark.addEventListener("change", sync);
  sync();
})();

// Demo video: until play is pressed it is just an image and a link, so opening the page
// contacts nobody. On click the player is loaded from youtube-nocookie.com.
// Without JavaScript the link opens the video on YouTube.
for (const link of document.querySelectorAll("a.video[data-youtube]")) {
  link.addEventListener("click", (e) => {
    e.preventDefault();
    const frame = document.createElement("iframe");
    frame.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(link.dataset.youtube)}?autoplay=1&rel=0`;
    frame.title = "Bandwise EQ demo video";
    frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    frame.allowFullscreen = true;
    const box = document.createElement("div");
    box.className = "video";
    box.append(frame);
    link.replaceWith(box);
    frame.focus();
  });
}
