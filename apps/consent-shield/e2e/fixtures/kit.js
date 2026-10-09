// What the fixture CMPs do when pressed. data-show opens a layer (or a second
// dialog) in place of the current one; data-close closes the dialog; a switch flips.
document.addEventListener("click", (event) => {
  const control = event.target.closest("button,[role=switch]");
  if (!control) return;
  if (control.getAttribute("role") === "switch") control.setAttribute("aria-checked", String(control.getAttribute("aria-checked") !== "true"));
  if (control.dataset.show) {
    control.closest("[data-box]").hidden = true;
    document.getElementById(control.dataset.show).hidden = false;
  }
  if (control.hasAttribute("data-close")) control.closest("[data-dialog]").hidden = true;
});
