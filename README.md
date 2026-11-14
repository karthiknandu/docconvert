# DocConvert – PDF, Scan & OCR

A converter that runs entirely in the browser. Files never leave the device.

**Open the app:** https://karthiknandu.github.io/docconvert/

## What it does
- **From PDF:** Word, Excel, PowerPoint, images (JPG/PNG), text, searchable PDF
- **To PDF:** Word (.docx), Excel (.xlsx/.csv), PowerPoint (.pptx), images, text, HTML
- **Scan:** camera or gallery photos → page detection, perspective correction, filters → PDF, Word, text or images
- **OCR:** 80 languages (up to 3 at once), language data loaded on first use and kept on the device

## Install on a phone
Open the link in Chrome → menu ⋮ → **Add to Home screen** / **Install app**. Works offline after first use.

## Built with
pdf.js, pdf-lib, Tesseract.js, docx, docx-preview, SheetJS, PptxGenJS, pptx-preview, JSZip, html2canvas (all bundled locally, see `vendor/` and `tess/`).

## Quality engine and learning
- Every page is inspected, repaired (tilt, rotation, shadows, blur, background, split pages), read with OCR retries, cleaned and rebuilt (headings, lists, tables, header/footer) before the file is offered. A report lists what was fixed.
- The app learns on the device: corrections you make in **Review uncertain words**, a personal dictionary, recurring document layouts, and which settings work best. Open 🧠 to see, export, import or reset what it has learned.
