# PrivyPDF Redactor Web

PrivyPDF Redactor Web is a browser-only PDF redaction app designed for GitHub Pages.
It lets users attach PDF files, choose sensitive fields, and download redacted PDF
copies without uploading documents to a backend server.

## How It Works

- PDF.js reads and renders PDF pages in the browser.
- The app detects configured field answers such as names, email addresses, age,
  phone numbers, addresses, and custom labels.
- Matching areas are painted as black redaction boxes.
- jsPDF rebuilds the output as an image-based PDF, so the original text layer is
  not included in the downloaded result.

Tradeoff: the redacted PDF is no longer selectable/searchable text because pages
are rebuilt as images. This is intentional for a static GitHub Pages app.

## Local Development

```bash
npm install
npm run dev
```

Build production assets:

```bash
npm run build
```

Preview the production build:

```bash
npm run preview
```

## GitHub Pages

This repository includes a GitHub Actions workflow:

```text
.github/workflows/deploy.yml
```

After pushing to `main`, enable GitHub Pages in the repository settings:

1. Open repository `Settings`.
2. Go to `Pages`.
3. Set `Source` to `GitHub Actions`.
4. Run or wait for the `Deploy GitHub Pages` workflow.

The site is configured for:

```text
https://xTarazTwilightForever.github.io/PrivyPDF-Redactor-Web/
```

## Privacy

Files are processed locally inside the browser session. The app does not include
a backend upload endpoint.

## License

Apache License 2.0. See `LICENSE`.

