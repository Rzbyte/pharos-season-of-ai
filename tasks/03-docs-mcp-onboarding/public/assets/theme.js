// Agent Arena Lab: light and dark themes, shared by every task page.
//
// A classic script, loaded in <head> before the stylesheet, so a saved choice is in place before
// the first paint and the page never flashes the other theme. With nothing saved, lab.css follows
// the system setting (prefers-color-scheme). The toggle switches to the other theme and saves the
// choice on this device only. Choosing the theme the system already uses clears the saved choice,
// so from then on the page follows the system again.
//
// Storage can be unavailable (private modes, blocked site data): every access is guarded, and the
// toggle still works for the visit, it is just not remembered. Nothing here is ever sent anywhere.
(() => {
  const KEY = "agent-arena-lab:theme";
  // --bg of each theme in lab.css, for the browser's own interface (theme-color).
  const BACKGROUND = { dark: "#0B0B0B", light: "#EFF1F2" };
  const root = document.documentElement;
  const systemLight = matchMedia("(prefers-color-scheme: light)");

  const saved = () => {
    try {
      const value = localStorage.getItem(KEY);
      return value === "light" || value === "dark" ? value : null;
    } catch {
      return null;
    }
  };
  const save = (choice) => {
    try {
      if (choice) localStorage.setItem(KEY, choice);
      else localStorage.removeItem(KEY);
    } catch {
      // Not remembered; the choice still applies to this visit.
    }
  };
  const system = () => (systemLight.matches ? "light" : "dark");
  const current = () => root.dataset.theme ?? system();

  /** "light" or "dark" overrides the system setting; null follows it. */
  function apply(choice) {
    if (choice) root.dataset.theme = choice;
    else delete root.dataset.theme;
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      meta.content = BACKGROUND[choice ?? (meta.media.includes("light") ? "light" : "dark")];
    }
    describe();
  }

  /** The toggle offers the other theme; its visible word and icon follow the theme in lab.css. */
  function describe() {
    const button = document.getElementById("theme-toggle");
    if (button) button.setAttribute("aria-label", `Switch to ${current() === "dark" ? "light" : "dark"} theme`);
  }

  root.classList.add("js");
  apply(saved());
  document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("theme-toggle")?.addEventListener("click", () => {
      const next = current() === "dark" ? "light" : "dark";
      const choice = next === system() ? null : next;
      save(choice);
      apply(choice);
    });
    describe();
  });
  // With nothing saved the page follows the system as it changes, and so does the toggle's name.
  systemLight.addEventListener("change", describe);
  // A choice made in another tab applies here too.
  addEventListener("storage", (event) => {
    if (event.key === KEY) apply(saved());
  });
})();
