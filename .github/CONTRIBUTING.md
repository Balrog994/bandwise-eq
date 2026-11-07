# Contributing to Bandwise EQ

Thanks for wanting to help. Bandwise EQ is a small project that I maintain in my spare time, so a few notes up front save time for both of us.

## Reporting a bug or asking for a feature

Open an [issue](https://github.com/Balrog994/bandwise-eq/issues/new/choose) and pick the right template. For bugs, the site where it happens and your Chrome version help a lot: audio behaves differently from one site to another.

If you found a security problem, please don't open a public issue. See [SECURITY.md](SECURITY.md) instead.

## Labels

I use labels to sort issues. You don't need to add them yourself, but they help you find your way around:

| Label | Meaning |
|---|---|
| `bug` | Something doesn't work as it should |
| `enhancement` | A new feature or an improvement |
| `site compatibility` | A problem that happens only on a specific site |
| `chrome limitation` | Caused by Chrome, DRM or the tabCapture API, so it can't be fixed in the extension |
| `needs info` | I'm waiting for more details from the person who opened the issue |
| `translation` | A new language or a fix to the interface text |
| `accessibility` | Something that makes the extension harder to use for people with disabilities |
| `documentation` | The README, the website or these guides |
| `question` | A question rather than a problem |
| `good first issue` | A small, well-defined task, good if you're new to the code |
| `help wanted` | I'd welcome help on this one |
| `duplicate`, `invalid`, `wontfix` | Closed without changes; the issue explains why |

If you'd like to contribute code but don't know where to start, look for `good first issue` or `help wanted`.

## Before you write code

For anything bigger than a small fix, open an issue first and describe what you'd like to change. That way we can agree on the approach before you spend time on it.

## Running the extension from source

There is no build step and there are no dependencies.

1. Clone the repository.
2. Open `chrome://extensions` and turn on Developer mode.
3. Click "Load unpacked" and choose the repository folder.
4. After a change, click the reload button on the extension card and reopen the popup.

To debug the audio engine, open the service worker or the offscreen document from the extension card ("Inspect views").

## How the code is organized

| File | What it does |
|---|---|
| `sw.js` | Service worker: starts and stops the capture of a tab, badge |
| `offscreen.js` | Audio engine: one Web Audio chain per tab, analyzer and meters |
| `eq-common.js` | Shared EQ logic: filter math, graphic EQ solver, presets, AutoEQ import and export |
| `ui-controls.js` | Knobs, faders and meters used by the popup |
| `popup.js`, `popup.html`, `popup.css` | The popup |
| `_locales/en`, `_locales/it` | Interface text in English and Italian |
| `docs/` | The website (GitHub Pages), not part of the extension |

## Guidelines

- Plain JavaScript, no frameworks, no libraries, no bundler. Keep it that way unless we've agreed otherwise in an issue.
- The extension must not access the network or load remote code, and must not read page content. This is a promise made to users in the store listing and privacy policy.
- Comments and identifiers in English.
- Any new interface text goes in both `_locales/en/messages.json` and `_locales/it/messages.json`. If you don't speak Italian, add the English text to both and say so in the pull request; I'll translate it.
- The popup must never scroll and must stay under 600 px tall. Check it in both English and Italian, since Italian strings are longer.
- Try your change on at least one real site with audio (YouTube works well) with the EQ on and off.

## Pull requests

Keep each pull request focused on one change and fill in the template. By contributing, you agree that your code is released under the project's license, [GPL-3.0](../LICENSE).

Everyone taking part in the project is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
