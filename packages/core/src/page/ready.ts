// Runs in the page before the finished page is judged. Kept apart from browser.ts so tests can load it.
// It uses nothing from module scope, like settle.ts.

/**
 * Waits until the page is quiet (no DOM change for 250 ms) and no progress
 * indicator is visible (role=progressbar, aria-busy=true), at most `capMs`.
 * Google Flights draws its results for a second or two after the form is sent;
 * a page read in that gap looks empty. A page that never goes quiet is read at the cap.
 */
export function ready(capMs: number): Promise<void> { return new Promise(resolve => {
  const started=performance.now(); let last=started;
  const observer=new MutationObserver(()=>{last=performance.now()});
  observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});
  const loading=()=>[...document.querySelectorAll('[role="progressbar"],[aria-busy="true"]')].some(e=>{
    const r=e.getBoundingClientRect();
    return r.width>0 && r.height>0 && e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  });
  const check=()=>{
    const now=performance.now();
    if (now-started>=capMs || (now-last>=250 && !loading())) { observer.disconnect(); resolve(); return; }
    setTimeout(check,Math.max(30,Math.min(250-(now-last),capMs-(now-started))));
  };
  setTimeout(check,250);
}); }
