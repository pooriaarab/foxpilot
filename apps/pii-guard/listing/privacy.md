# PII Guard privacy policy

Effective date: 2026-10-08

PII Guard collects no data. Its manifest says so to Firefox: `data_collection_permissions` is `required: ["none"]`.

## What the add-on reads

PII Guard reads the text you type into the message box on these sites only:

- chatgpt.com and chat.openai.com
- claude.ai
- gemini.google.com
- copilot.microsoft.com
- chat.mistral.ai
- perplexity.ai and www.perplexity.ai

It does not run on any other site.

## Where your text goes

The content script on the page checks the text with fixed patterns. Then it passes the text to the add-on's own background page, which runs the foxmind-small model. The model and ONNX Runtime ship inside the add-on. The text stays in memory and goes nowhere else.

PII Guard makes no network requests. It has no server and no analytics. It sends nothing to the developer or to any other party.

## What the add-on stores

Nothing. PII Guard does not ask for the `storage` permission. It keeps no log and no copy of your messages. The toolbar badge shows how many items it marked in the current tab. That number is not saved.

## What the site receives

PII Guard does not change what you send unless you choose "Redact and send". Then the site gets your message with tags such as [NAME_1] in place of the marked items. If you choose "Send anyway", the site gets the message as you typed it. Each AI chat site has its own privacy policy for the messages it receives.

## Permissions

- Host access to the sites listed above, so the content script can read the message box there.

The add-on asks for no other permissions.

## Contact

Open an issue at https://github.com/pooriaarab/foxpilot/issues.

## Changes

A change to this policy ships in a new version of the add-on. The history of this file is at https://github.com/pooriaarab/foxpilot/commits/main/apps/pii-guard/listing/privacy.md.
