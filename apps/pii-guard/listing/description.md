PII Guard checks the message you type into an AI chat before you send it. It underlines personal data in the message box. If you send a message that has personal data, it stops the send and asks what to do.

It works on these sites:
- chatgpt.com and chat.openai.com
- claude.ai
- gemini.google.com
- copilot.microsoft.com
- chat.mistral.ai
- perplexity.ai and www.perplexity.ai

What it looks for:
- names
- email addresses
- phone numbers
- card numbers
- street addresses
- dates of birth
- ID numbers, such as passport, social security, licence, tax or account numbers
- health conditions

Fixed patterns find email addresses, card numbers and North American phone numbers as you type. A small language model, foxmind-small, then finds names, addresses and the other types. An ID number gets a mark only when a word such as "passport" or "account" comes before it. The toolbar button shows how many items are marked.

When you press Enter or the site's Send button and the message has marked items, PII Guard shows three choices:
- Redact and send: puts a numbered tag, such as [NAME_1] or [EMAIL_1], in place of each item, then sends. The same value gets the same tag every time it appears.
- Send anyway: sends the message as you typed it.
- Cancel: keeps the message in the box so you can edit it. Escape does the same.

Your text stays in your browser. The model ships inside the add-on and runs on your computer with WebAssembly. The page passes your text only to the add-on's own background page. PII Guard makes no network requests, stores no text and collects no data.

We tested PII Guard in Firefox on 40 test messages. Precision was 1.0 for most types and 0.75 for street addresses. Recall was 0.67 to 1.0, depending on the type. Once the model has loaded, one check takes about 205 ms.

What it misses:
- some phone number formats (the fixed pattern knows only North American numbers, so the model must find the rest)
- some social security numbers
- drug names
- text after the first 20,000 characters (the model reads only the first 1,500)

The model is trained for short English text, so other languages get fewer marks. If you send a message within about half a second of your last key, and the message has a name but no email, phone or card number, the model may not have answered yet. That message goes through without a prompt.

PII Guard can miss personal data. Read your message before you send it. The popup has no settings yet.

PII Guard is open source under the MIT license. The source, the build steps and the test suite are at https://github.com/pooriaarab/foxpilot/tree/main/apps/pii-guard
