# Imposition Studio

Print imposition tool for flatbed UV printing. Reads InDesign IDML templates, places photos into frames, and generates production-quality multi-layer PDFs with White Ink spot color and overprint.

## Architecture

- **Frontend**: Vite + React — handles IDML parsing, photo upload, placement preview
- **Backend**: Vercel Python serverless function — generates production PDFs with ReportLab + pypdf
- **Storage**: IndexedDB for template persistence across sessions

## PDF Output

Generated PDFs contain:
- Single page sized to your tray dimensions
- **OCG layer "image"** — full-resolution photos with cover-fit clipping
- **OCG layer "White_Ink"** — Separation spot color named "White_Ink" (C15 M100 Y100 K0 alternate) with overprint (OP/op/OPM 1)
- White_Ink only on frames with photos — empty slots get no white ink
- Layers toggle in Acrobat and process correctly in print production RIPs

## Deploy to Vercel

```bash
npm i -g vercel
cd imposition-studio
npm install
vercel
```

The Python serverless function (`api/generate-pdf.py`) automatically deploys with the frontend. Vercel handles the Python runtime.

## Local Development

```bash
npm install
npm run dev
```

Note: PDF generation requires the server-side API. For local dev with the API, use `vercel dev` instead of `npm run dev`.

## IDML Template Requirements

Your InDesign templates need:
1. **"image" layer** — empty graphic frames with script labels controlling placement order
2. **"White" layer** — matching frames with "White_Ink" spot color + OverprintFill=true

The app reads frame positions and sorts by visual position (top-to-bottom, left-to-right).
