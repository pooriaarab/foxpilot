// Runs in the page after each action. Kept apart from browser.ts so tests can load it.

/** Waits after input: for autocomplete options to render, or a couple of frames. */
export const SETTLE = `(action => new Promise(resolve => {
  const field=window.__glinerFast?.nodes.get(action.node);
  const autocomplete=action.kind==='fill' && (field?.getAttribute('role')==='combobox' ||
    field?.getAttribute('aria-autocomplete')==='list' || field?.hasAttribute('aria-controls'));
  // Zipline addition: a click that opens a menu waits for its options too.
  const menu=action.kind==='click' && !!field && (field.hasAttribute('aria-haspopup') ||
    field.hasAttribute('aria-expanded') || field.getAttribute('role')==='combobox');
  // Zipline addition: a button inside a picker ("Done") closes it; the page is
  // read once it has gone, not mid-animation (a fading calendar was scored at 2 s).
  const dialogRoot=field?.closest('dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"]');
  // A day in a calendar grid or an option in a list keeps the picker open.
  const closing=action.kind==='click' && !!dialogRoot && !menu &&
    !['gridcell','option','menuitem','menuitemradio','tab'].includes(field.getAttribute('role')||'') &&
    !field.closest('[role="grid"],[role="listbox"],[role="menu"],[role="tablist"],table');
  const gone=()=>!dialogRoot.isConnected || !dialogRoot.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) ||
    parseFloat(getComputedStyle(dialogRoot).opacity)<0.05;
  let frames=0, stopped=false; const started=performance.now();
  const finish=()=>{stopped=true;resolve()};
  setTimeout(finish,autocomplete ? 600 : menu || closing ? 800 : 250);
  const ready=()=>{
    if (stopped) return;
    const ids=(field?.getAttribute('aria-controls')||field?.getAttribute('aria-owns')||'').split(/\\s+/).filter(Boolean);
    const linked=ids.map(id=>document.getElementById(id)).filter(Boolean);
    // aria-controls can name an element that never holds the options (Google
    // Flights' ticket type); a menu then shows them in a listbox or menu elsewhere.
    const roots=linked.length ? linked : [document];
    if (menu && linked.length) roots.push(...document.querySelectorAll('[role="listbox"],[role="menu"]'));
    const options=roots.flatMap(root=>[...root.querySelectorAll('[role="option"],[role="gridcell"],[role="menuitem"],[role="menuitemradio"]')]);
    if (++frames>=2 && closing) { if (gone()) finish(); else requestAnimationFrame(ready); return; }
    if (frames>=2 && (autocomplete || menu ? options.some(e=>{
      const r=e.getBoundingClientRect();
      return r.width && r.height && r.bottom>0 && r.top<innerHeight && e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
    }) : performance.now()-started>=150)) finish();
    else requestAnimationFrame(ready);
  };
  requestAnimationFrame(ready);
}))`;
