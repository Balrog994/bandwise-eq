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
