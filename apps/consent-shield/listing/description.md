Consent Shield says no for you. When a page shows a cookie consent dialog, it refuses the optional purposes. When a page pushes a newsletter, offer or notification prompt, it declines it.

On a cookie dialog, Consent Shield works one step at a time, the way you would by hand:
- it opens "Manage options" or the next layer of the dialog
- it switches off each optional toggle, such as personalised ads or audience measurement
- it scrolls the dialog when the Save button is further down
- it presses "Reject all", "Save my choices" or a button like them

On a nag dialog, it presses "No thanks", "Not now", "Close" or a button like them.

A small language model, foxmind-small, reads the labels of the buttons and toggles in the dialog and picks the next step. Fixed rules check each step before it happens:
- it never presses a button whose label says "accept", "agree", "allow all", "enable all" or "consent"
- it never switches off a toggle labelled "essential", "necessary", "required" or "strictly"
- it clicks only controls inside the dialog
- it takes at most 60 steps on a page, and spends at most 60 seconds on one dialog

If a step fails, Consent Shield stops and leaves the page as it is. For example, it stops when a toggle does not switch off or when the site switches it back on.

The toolbar button shows how many toggles it switched off and buttons it pressed on the page, or "!" when it stopped. The popup lists every step for the current tab, so you can see what it did. The popup also has an "Off on" switch for the current site. On a site that is off, Consent Shield does nothing.

Your data stays in your browser. The model ships inside the add-on and runs on your computer with WebAssembly. Consent Shield makes no network requests and collects no data.

Firefox no longer has its own cookie banner handling. In Firefox 120, Mozilla started to turn on a Cookie Banner Blocker in private windows for users in Germany. It worked only on sites in a list that Mozilla kept, and for each site it set cookies or clicked the buttons that the list named. Mozilla archived that list in January 2025 and removed the feature in Firefox 155. Consent Shield uses no site list. It reads the dialog on any site, switches off the optional toggles one by one in dialogs with several layers, and also declines newsletter and notification prompts.

Limits:
- it reads English labels only, so a dialog in another language is usually left as it is
- it does not look inside iframes or shadow roots, so consent tools that live there are not handled
- it presses buttons with events from a script, and some sites ignore those
- it refuses what the dialog offers, but it does not delete cookies that a site sets before you answer

Consent Shield is open source under the MIT license. The source, the build steps and the test pages are at https://github.com/pooriaarab/foxpilot/tree/main/apps/consent-shield
