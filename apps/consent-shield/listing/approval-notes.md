# Notes for AMO reviewers

## Why `<all_urls>`

A consent dialog can appear on any site. The user does not choose the sites in advance, so no fixed host list can work.

The content script runs on every page at `document_idle`. It does three things:

1. It finds a cookie or newsletter dialog in the page.
2. It reads only the button and toggle labels in that dialog.
3. It presses "Reject all", or switches off optional toggles. It never presses "Accept all".

The add-on keeps a local log in `storage.local`. It sends nothing off the device.

## No network

The add-on makes no network request. The model (foxmind-small, ONNX, q8) ships inside the package and runs in the browser with WebAssembly. The manifest declares `data_collection_permissions` as `none`.

## Build

See `BUILD.md` in this folder (added with the release setup).
