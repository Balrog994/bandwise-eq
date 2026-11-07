# Bandwise EQ

An equalizer for the sound of your Chrome tabs. Use it to bring out the voices in a podcast, soften harsh highs on a video, add some bass to music on Spotify Web, or correct the sound of your headphones with an AutoEQ profile.

![Bandwise EQ](docs/img/social.png)

## Features

- **Graphic mode:** 10 classic sliders from 31 Hz to 16 kHz. The filter gains are solved so that the curve passes exactly through the slider values, with no bumps in between.
- **Parametric mode:** up to 10 bands and 7 filter types (bell, low and high shelf, low-pass, high-pass, notch, band-pass). Drag the points, turn the knobs or type values such as `2.5k`. Both modes edit the same equalizer, so your curve carries over when you switch.
- **Spectrum analyzer:** sound before and after the EQ, peak hold, a crosshair that reads frequency and levels, per-filter curves and a stereo output meter with clip indicator. FFT size, scale, ranges and smoothing are adjustable.
- **Level-matched A/B:** hold A/B to hear the original sound. The bypassed signal is volume-matched, so you compare the tone and not the loudness. Shift+click keeps the bypass on.
- **Headphone profiles:** import and export AutoEQ and Equalizer APO `ParametricEQ.txt` files.
- **Settings that stick:** separate settings for each tab, optional per-site memory, built-in and personal presets, a preamp fader and an output limiter.
- **No extra windows:** the audio engine runs in an offscreen document, so you can close the popup and keep listening.
- **Private:** no network access, no analytics and no access to page content. See the [privacy policy](https://balrog994.github.io/bandwise-eq/privacy.html).
- English and Italian.

## Install

- **Chrome Web Store:** coming soon.
- **From source:** clone this repository, open `chrome://extensions`, enable *Developer mode*, click *Load unpacked* and select the repository folder.

Requires Chrome 116 or later.

## How it works

| File | Role |
|---|---|
| `sw.js` | Service worker: gets the tab's media stream (`tabCapture`) and manages the offscreen document. |
| `offscreen.js` | Audio engine (Web Audio). Each tab has its own chain: preamp, filters and limiter, plus analyzers, meters and the level-matched bypass. |
| `eq-common.js` | Shared data model: validation, presets, the graphic-EQ solver, mode switching and Equalizer APO import/export. |
| `popup.*`, `ui-controls.js` | User interface: graph, analyzer, knobs, faders and meters. |
| `i18n.js`, `_locales/` | Translations. |

To build the package for the store, run `python scripts/build_zip.py`. It creates `dist/bandwise-eq-<version>.zip` with only the extension files.

## Feedback

Bug reports and suggestions are welcome on [GitHub Issues](https://github.com/Balrog994/bandwise-eq/issues).

## License

[GNU General Public License v3.0](LICENSE).
