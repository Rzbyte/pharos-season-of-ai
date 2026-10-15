// The lab's landing page: the planned list opens and closes. Without JavaScript the list is simply
// shown; with it, it starts collapsed (landing.css hides it until this has run, so it never flashes).
import { wireToggle } from "./lab.js";

const list = document.getElementById("planned-body");
wireToggle(document.getElementById("planned-toggle"));
list.dataset.ready = "";
