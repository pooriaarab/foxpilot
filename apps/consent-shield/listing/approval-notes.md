# Notes for AMO reviewers

## Why `<all_urls>`

A consent dialog can appear on any site. The user does not choose the sites in advance, so no fixed host list can work.

The content script runs on every page at `document_idle`. It does four things:

1. It finds a cookie or newsletter dialog in the page.
2. It reads only the button and toggle labels in that dialog.
3. It switches off the optional toggles, opens the next layer, and presses "Reject all", "Save" or "No thanks". It never presses "Accept all", and it never switches off a toggle for necessary cookies.
4. It clicks only controls inside the dialog. It takes one step at a time, at most 60 steps on a page and for at most 60 seconds on a dialog. When a step fails, it stops and leaves the page as it is.

The user can switch the add-on off for each site in the popup. That list is in `storage.local`. The log of steps for each tab is in `storage.session`, and the popup shows it. The add-on sends nothing off the device.

## No network

The add-on makes no network request. The model (foxmind-small, ONNX, q8) ships inside the package and runs in the browser with WebAssembly. The manifest declares `data_collection_permissions` as `none`.

## Build

See `BUILD.md` in this folder (added with the release setup).
