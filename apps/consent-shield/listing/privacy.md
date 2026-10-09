# Consent Shield privacy policy

Effective date: 2026-10-08

Consent Shield collects no data. Its manifest says so to Firefox: `data_collection_permissions` is `required: ["none"]`.

## What the add-on reads

Consent Shield runs on every page you open, because a consent dialog can appear on any site. On each page it reads:

- a list of the controls on the page, to find the ones inside a dialog. This list can hold the text in form fields (password fields are masked). It stays in the page's memory and is not stored or sent anywhere.
- the text of a dialog that floats over the page, to tell a cookie dialog from a newsletter prompt
- the labels of the controls in that dialog, which the model reads to pick the next step

It does not run inside iframes.

## Where that data goes

The page passes the labels of the dialog's controls, the dialog title and the page address to the add-on's own background page. The background page runs the foxmind-small model on the labels and keeps the step log. The model and ONNX Runtime ship inside the add-on. Consent Shield makes no network requests. It has no server and no analytics. It sends nothing to the developer or to any other party.

## What the add-on stores

Two things, both on your computer only:

- The list of sites where you switched Consent Shield off. It is in `storage.local` and stays until you switch the site back on or remove the add-on.
- A log of the steps it took on the page in each tab, such as `pressed "Save my choices"`, with the page address, the dialog title and the time. It is in `storage.session`. The log of a tab is deleted when you close the tab, and Firefox deletes all of it when it quits. The popup shows this log.

## What sites receive

Consent Shield clicks controls in the site's dialog, as you would. The site then gets your refusal through its own consent tool, under its own privacy policy. Consent Shield does not delete cookies and does not block requests.

## Permissions

- `storage`: to keep the off-switch list and the step log described above.
- Host access to all sites (`<all_urls>`): to find and answer consent dialogs on any page.

The add-on asks for no other permissions.

## Contact

Open an issue at https://github.com/pooriaarab/foxpilot/issues.

## Changes

A change to this policy ships in a new version of the add-on. The history of this file is at https://github.com/pooriaarab/foxpilot/commits/main/apps/consent-shield/listing/privacy.md.
