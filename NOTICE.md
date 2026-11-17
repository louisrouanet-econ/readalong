# Third-party software and data

ReadAlong's own code is released under the MIT licence (see LICENSE). It builds on the following work:

| Component | Use | Licence |
|---|---|---|
| [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) by hexgrad, ONNX export by [onnx-community](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped) | the voice; downloaded by the browser from Hugging Face, not stored in this repository | Apache 2.0 |
| [misaki](https://github.com/hexgrad/misaki) by hexgrad | pronunciation dictionaries (`data/dict.json`) and rules ported to `js/g2p.js` | Apache 2.0 |
| [espeak-ng](https://github.com/espeak-ng/espeak-ng) via [phonemizer.js](https://github.com/xenova/phonemizer.js) (`vendor/phonemizer.js`) | pronunciation of words not in the dictionary | espeak-ng: GPL 3.0; phonemizer.js wrapper: Apache 2.0 |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (`vendor/ort/`) | runs the voice model on the graphics card or processor | MIT |
| [PDF.js](https://github.com/mozilla/pdf.js) (`vendor/pdfjs/`) | reads and draws PDFs | Apache 2.0 |
| [fflate](https://github.com/101arrowz/fflate) (`vendor/fflate.mjs`) | opens Word (.docx) files | MIT |
| [Readability](https://github.com/mozilla/readability) 0.6.0 (`vendor/readability.mjs`) | finds the article in a web page (as Firefox Reader View does) | Apache 2.0 |
| [Tesseract.js](https://github.com/naptha/tesseract.js) | OCR for scanned pages; loaded from jsDelivr only when needed | Apache 2.0 |
| [Newsreader](https://fonts.google.com/specimen/Newsreader), [IBM Plex Mono](https://fonts.google.com/specimen/IBM+Plex+Mono) | typefaces, from Google Fonts | SIL Open Font License 1.1 |

The sample text in `samples/` (Hobbes, *Leviathan*, 1651, as printed in the 1909 Oxford edition) is in the public domain.
