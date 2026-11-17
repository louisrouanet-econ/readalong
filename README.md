# ReadAlong

**Open it at <https://louisrouanet-econ.github.io/readalong/>.**

ReadAlong turns a reading into an audiobook you can follow word by word. Drop in a PDF (scanned or not), a Word file or a saved web page. A natural voice reads it while the spoken word is highlighted on the original page. Press **N** at any moment to pause and write a note. The note is pinned to that spot, and all notes can be exported as Markdown.

It was made for course readings, so the voice reads them the way a person would:

- **Skipped by default:** running headers, page numbers, footnote markers, margin notes, JSTOR cover pages, reference lists and in-text citations such as *(Olson 1982, 23)*. Each can be switched back on.
- **Numbers:** *1850* is read "eighteen fifty", *pp. 567-576* "pages five hundred sixty-seven to five hundred seventy-six", *CHAP. XIII* "chapter thirteen", *Louis XIV* "Louis the fourteenth" and *$3 million* "three million dollars".
- **Names:** about 60 names the voice gets wrong are built in (Bastiat, Tocqueville, Hayek, Mises, Rousseau, Keynes…). The **Names** panel lists every unusual word in a reading, lets you hear it, and lets you fix it by typing how it sounds (`bah-stee-AH`). Only the sentences containing that word are re-voiced.
- **Old spellings:** in early-modern texts (Hobbes), *warre*, *onely* and *ariseth* are pronounced properly.

## Everything runs in the browser

There is no server. GitHub Pages only delivers the files. Your readings, notes and pronunciation fixes stay in your browser's storage on your device, and nothing you add is uploaded. Notes therefore live in that browser on that computer: use **Export** to keep a copy.

- **The voice:** [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), an open model. The first time, the browser downloads it from Hugging Face and keeps it: 326 MB with a graphics card, 92 MB without.
- **Speed:** with a graphics card (WebGPU, in current Chrome and Edge), the voice is produced faster than you listen. Playback starts within seconds while the rest of the reading is voiced in the background. Without WebGPU, the voice runs on the processor and is slower than real time, so a reading has to be voiced ahead of listening.

Measured on one Windows laptop with a recent NVIDIA graphics card, in Chrome. Laptops with integrated graphics will be slower; phones much slower.

| Engine | Model | Speed |
|---|---|---|
| Graphics card (WebGPU) | 32-bit, 326 MB | about 3.6× real time |
| Processor only, 4 threads | 8-bit, 92 MB | about 0.6× real time |

The 16-bit model (163 MB) is faster on the graphics card but produces silence there (its numbers overflow), so it is not used.

To check another device, open [`tools/engine-test.html`](https://louisrouanet-econ.github.io/readalong/tools/engine-test.html).

**Storage:** audio is kept as uncompressed sound, about 115 MB per 40 minutes of listening. The Settings panel shows how much is used and can delete saved audio without touching readings or notes.

## How it compares with the local version

`ReadingApp_1` (not in this repository) is the original version. It runs on a computer as a small Python server, with the same voice running on the GPU. This browser version ports its text handling to JavaScript, and they were checked against each other on five PPEL readings:

- **Text extracted for reading:** 98.5–100% identical word for word. Olson 1993 is the 98.5%: an old JSTOR scan whose text layer lost its spaces, repaired here with the dictionary.
- **Pronunciation:** 99.0% of 16,808 words identical, 0.8% differ only in stress, and 0.2% differ in sound. These are words whose pronunciation depends on grammar, such as *live* and *use*, which the local version resolves with a part-of-speech tagger.

- **Word timing:** the highlight uses the same timing rule as the local version. Checked with Whisper speech recognition on three minutes of browser-made audio, the median gap between highlight and voice is 0.02 seconds (mean 0.06), the same as the local version.

The browser version also differs in a few other ways:
- **Original pages:** they are drawn sharply at any zoom.
- **Playback:** reading starts before the whole text is voiced.
- **Scans with no text layer:** OCR uses Tesseract.

## Use

| Key | Action |
|---|---|
| Space | play / pause |
| N | pause and write a note |
| ← / → | previous / next sentence |
| Shift + ← / → | back / forward 10 seconds |
| [ / ] | slower / faster |
| T | original pages or reflowed text |
| F | follow the voice on/off |

Click any word to read from there. In the text view, hover over a paragraph to read or skip it.

## Development

The app is plain HTML, CSS and JavaScript modules with no build step.

- **Run locally:** `python tools/serve.py`, then open <http://127.0.0.1:8800/>.
- **Tests:** `npm test` checks the number, citation and name rules with Node, using the same cases as the local version.

```
js/ingest/      format detection; PDF layout (reading order, columns, headers, footnotes, drop caps,
                margin notes, hyphenation); repair of scans that lost their spaces; OCR; Word, HTML, text
js/normalize.js printed text to spoken text (numbers, abbreviations, citations, old spellings)
js/g2p.js       words to phonemes (misaki dictionaries and rules; espeak-ng for unknown words)
js/lexicon.js   name pronunciations: built-in list plus your fixes
js/speech.js    what is read, sentences, synthesis chunks, pauses
js/tts.worker.js, js/engine.js   the voice model (onnxruntime-web) and word timings
js/player.js    gapless playback of passages while the rest is still being voiced
js/app.js       the interface
coi-sw.js       service worker that lets the voice use several processor threads on GitHub Pages
```

Licences of the components are listed in [NOTICE.md](NOTICE.md).
