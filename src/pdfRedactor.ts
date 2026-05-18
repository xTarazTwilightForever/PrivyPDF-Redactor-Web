import jsPDF from "jspdf";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import type { RedactionRule, Validator } from "./rules";
import { agePattern, emailPattern, phonePattern } from "./rules";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RedactionHit = {
  pageIndex: number;
  rect: Rect;
  reason: string;
  text: string;
};

export type ProcessOptions = {
  selectedKeys: string[];
  customValues: string[];
  allEmails: boolean;
  allRegex: boolean;
  padding: number;
};

export type ProcessProgress = {
  page: number;
  totalPages: number;
  message: string;
};

export type ProcessResult = {
  fileName: string;
  outputName: string;
  blob: Blob;
  hits: RedactionHit[];
};

type TextSpan = {
  pageIndex: number;
  text: string;
  rect: Rect;
};

type PdfPageProxy = Awaited<ReturnType<Awaited<ReturnType<typeof pdfjsLib.getDocument>["promise"]>["getPage"]>>;

const renderScale = 2;
const sectionHeadingWords = [
  "demographics",
  "experience",
  "section",
  "participant's",
  "participants",
  "participant",
  "question",
  "questions",
  "required",
  "study",
  "form"
];

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\*/g, " ")
    .replace(/’/g, "'")
    .replace(/[^a-z0-9@._+\-'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isQuestionNumber(text: string): boolean {
  return /^\d{1,3}\.?$/.test(text.trim());
}

function isFooterOrHeader(text: string): boolean {
  const clean = text.trim().toLowerCase();
  return (
    clean.length === 0 ||
    clean.startsWith("http://") ||
    clean.startsWith("https://") ||
    /^\d+\/\d+$/.test(clean) ||
    /\d{1,2}\/\d{1,2}\/\d{2,4},/.test(clean)
  );
}

function isLabelLine(text: string, labels: string[]): boolean {
  const clean = normalizeText(text);
  if (!clean) return false;

  return labels.some((label) => {
    const labelClean = normalizeText(label);
    if (!labelClean) return false;
    if (clean === labelClean) return true;
    if (!clean.startsWith(`${labelClean} `)) return false;
    const tail = clean.slice(labelClean.length).trim();
    if (!tail || tail === "required" || isQuestionNumber(tail)) return true;
    return tail.split(" ").every((part) => part === "required" || isQuestionNumber(part));
  });
}

function isNameValue(text: string): boolean {
  const clean = text.trim();
  const normalized = normalizeText(clean);
  if (!clean || emailPattern.test(clean)) return false;
  if (isQuestionNumber(clean) || isFooterOrHeader(clean)) return false;
  if (clean.includes("'s") || clean.includes("’s")) return false;
  if (/\band\b/i.test(clean)) return false;
  if (sectionHeadingWords.some((word) => normalized.includes(word))) return false;
  if (/\d/.test(clean) || clean.length > 80) return false;

  const parts = clean.split(/\s+/).filter(Boolean);
  return parts.length >= 1 && parts.length <= 5 && parts.every((part) => /^[A-Za-z][A-Za-z'’.-]*$/.test(part));
}

function matchesValidator(text: string, validator: Validator, regex?: RegExp): boolean {
  const clean = text.trim();
  if (isFooterOrHeader(clean)) return false;
  if (validator === "age" && /^\d{1,3}\.$/.test(clean)) return false;
  if (validator !== "age" && isQuestionNumber(clean)) return false;

  if (validator === "name") return isNameValue(clean);
  if (validator === "email") return Boolean((regex ?? emailPattern).test(clean));
  if (validator === "phone") return Boolean((regex ?? phonePattern).test(clean));
  if (validator === "age") return Boolean((regex ?? agePattern).test(clean));
  return clean.length > 0 && clean.length <= 120;
}

function padRect(rect: Rect, padding: number): Rect {
  return {
    x: Math.max(0, rect.x - padding),
    y: Math.max(0, rect.y - padding),
    width: rect.width + padding * 2,
    height: rect.height + padding * 2
  };
}

function textItemRect(item: unknown, viewport: pdfjsLib.PageViewport): Rect | null {
  const candidate = item as { str?: string; width?: number; height?: number; transform?: number[] };
  if (!candidate.str || !candidate.transform || candidate.transform.length < 6) return null;

  const x = candidate.transform[4] ?? 0;
  const y = candidate.transform[5] ?? 0;
  const width = Math.max(candidate.width ?? 0, candidate.str.length * 4);
  const height = Math.max(candidate.height ?? 0, Math.abs(candidate.transform[3] ?? 10));
  const points = viewport.convertToViewportRectangle([x, y, x + width, y + height]);
  const left = Math.min(points[0], points[2]);
  const top = Math.min(points[1], points[3]);
  const right = Math.max(points[0], points[2]);
  const bottom = Math.max(points[1], points[3]);

  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(6, bottom - top)
  };
}

async function extractTextSpans(pdf: pdfjsLib.PDFDocumentProxy): Promise<TextSpan[]> {
  const spans: TextSpan[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();

    for (const item of textContent.items) {
      const text = "str" in item ? String(item.str).trim() : "";
      const rect = textItemRect(item, viewport);
      if (text && rect) {
        spans.push({ pageIndex: pageNumber - 1, text, rect });
      }
    }
  }
  return spans;
}

function detectLabelValues(spans: TextSpan[], rules: RedactionRule[], options: ProcessOptions): RedactionHit[] {
  const selected = new Set(options.selectedKeys);
  const hits: RedactionHit[] = [];

  for (const rule of rules) {
    if (!selected.has(rule.key)) continue;

    for (let index = 0; index < spans.length; index += 1) {
      const labelSpan = spans[index];
      if (!isLabelLine(labelSpan.text, rule.labels)) continue;

      const candidates = spans.slice(index + 1, index + 11);
      const value = candidates.find(
        (candidate) =>
          candidate.pageIndex === labelSpan.pageIndex &&
          matchesValidator(candidate.text, rule.validator, rule.regex)
      );

      if (value) {
        hits.push({
          pageIndex: value.pageIndex,
          rect: padRect(value.rect, options.padding),
          reason: rule.key,
          text: value.text
        });
      }
    }
  }

  return hits;
}

function detectGlobalPatterns(spans: TextSpan[], rules: RedactionRule[], options: ProcessOptions): RedactionHit[] {
  const selected = new Set(options.selectedKeys);
  const hits: RedactionHit[] = [];

  for (const rule of rules) {
    if (!selected.has(rule.key)) continue;
    const shouldScan = (rule.key === "email" && options.allEmails) || (options.allRegex && rule.regex);
    if (!shouldScan || !rule.regex) continue;

    for (const span of spans) {
      if (rule.regex.test(span.text)) {
        hits.push({
          pageIndex: span.pageIndex,
          rect: padRect(span.rect, options.padding),
          reason: rule.key,
          text: span.text
        });
      }
    }
  }

  return hits;
}

function detectCustomValues(spans: TextSpan[], options: ProcessOptions): RedactionHit[] {
  const hits: RedactionHit[] = [];
  for (const span of spans) {
    const cleanSpan = normalizeText(span.text);
    for (const value of options.customValues) {
      if (value.trim() && cleanSpan.includes(normalizeText(value))) {
        hits.push({
        pageIndex: span.pageIndex,
        rect: padRect(span.rect, options.padding),
        reason: "custom",
        text: value
        });
      }
    }
  }
  return hits;
}

function dedupeHits(hits: RedactionHit[]): RedactionHit[] {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = [
      hit.pageIndex,
      Math.round(hit.rect.x),
      Math.round(hit.rect.y),
      Math.round(hit.rect.width),
      Math.round(hit.rect.height),
      hit.reason
    ].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function renderRedactedPage(page: PdfPageProxy, hits: RedactionHit[], pageIndex: number): Promise<HTMLCanvasElement> {
  const viewport = page.getViewport({ scale: renderScale });
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create canvas context.");

  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);

  await page.render({ canvas, canvasContext: context, viewport }).promise;

  context.save();
  context.fillStyle = "#000";
  for (const hit of hits.filter((item) => item.pageIndex === pageIndex)) {
    context.fillRect(
      hit.rect.x * renderScale,
      hit.rect.y * renderScale,
      hit.rect.width * renderScale,
      hit.rect.height * renderScale
    );
  }
  context.restore();

  return canvas;
}

function outputName(fileName: string): string {
  const clean = fileName.replace(/\.pdf$/i, "");
  return `${clean || "document"}-redacted.pdf`;
}

export async function redactPdfFile(
  file: File,
  rules: RedactionRule[],
  options: ProcessOptions,
  onProgress: (progress: ProcessProgress) => void
): Promise<ProcessResult> {
  const data = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  onProgress({ page: 0, totalPages: pdf.numPages, message: "Reading text" });

  const spans = await extractTextSpans(pdf);
  const hits = dedupeHits([
    ...detectLabelValues(spans, rules, options),
    ...detectGlobalPatterns(spans, rules, options),
    ...detectCustomValues(spans, options)
  ]);

  let outputPdf: jsPDF | null = null;

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    onProgress({ page: pageNumber, totalPages: pdf.numPages, message: `Rendering page ${pageNumber}` });
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const canvas = await renderRedactedPage(page, hits, pageNumber - 1);
    const image = canvas.toDataURL("image/jpeg", 0.95);
    const orientation = viewport.width > viewport.height ? "landscape" : "portrait";

    if (!outputPdf) {
      outputPdf = new jsPDF({
        unit: "pt",
        format: [viewport.width, viewport.height],
        orientation
      });
    } else {
      outputPdf.addPage([viewport.width, viewport.height], orientation);
    }

    outputPdf.addImage(image, "JPEG", 0, 0, viewport.width, viewport.height);
  }

  if (!outputPdf) throw new Error("The PDF had no pages.");

  const blob = outputPdf.output("blob");
  return {
    fileName: file.name,
    outputName: outputName(file.name),
    blob,
    hits
  };
}
