// Task 03 page: the shell's task navigation, and the evidence viewer. A thumbnail is a plain link to
// its full image, so it works without JavaScript; with it, the full image opens in a <dialog> and is
// only requested when it is opened. Nothing else runs on this page.
import { renderTaskNav } from "./lab.js";
import { LAB, TASKS } from "./tasks.js";

renderTaskNav(TASKS, "03", LAB);

const viewer = document.getElementById("viewer");
const image = document.getElementById("viewer-img");
if (viewer && image && typeof viewer.showModal === "function") {
  let opener = null;
  for (const link of document.querySelectorAll("a[data-evidence]")) {
    link.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      opener = link;
      image.src = link.getAttribute("href");
      image.alt = link.dataset.alt ?? "";
      viewer.showModal();
    });
  }
  // Closing (Close, Escape or a click outside the image) returns focus to the thumbnail.
  viewer.addEventListener("click", (event) => {
    if (event.target === viewer) viewer.close();
  });
  viewer.addEventListener("close", () => {
    image.removeAttribute("src");
    opener?.focus();
  });
}
