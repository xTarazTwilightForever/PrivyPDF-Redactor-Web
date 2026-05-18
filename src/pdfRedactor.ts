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
  debug?: DebugLogger;
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

export type FieldAnalysis = {
  key: string;
  title: string;
  labels: string[];
  samples: string[];
  count: number;
};

export type DocumentAnalysis = {
  fields: FieldAnalysis[];
  suggestedLabels: string[];
  pageCount: number;
  spanCount: number;
};

export type DebugLogger = (message: string, details?: unknown) => void;

type TextSpan = {
  pageIndex: number;
  text: string;
  rect: Rect;
};

type PdfPageProxy = Awaited<ReturnType<Awaited<ReturnType<typeof pdfjsLib.getDocument>["promise"]>["getPage"]>>;

const renderScale = 2;
const maxFieldAnswerDistance = 95;
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

function stripQuestionPrefix(text: string): string {
  return normalizeText(text).replace(/^\d{1,3}\.?\s+/, "");
}

function debugLog(logger: DebugLogger | undefined, message: string, details?: unknown): void {
  if (logger) {
    logger(message, details);
  }
  if (details === undefined) {
    console.debug(`[PrivyPDF] ${message}`);
  } else {
    console.debug(`[PrivyPDF] ${message}`, details);
  }
}

function isSafariBrowser(): boolean {
  return /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);
}

function pdfDocumentParams(data: ArrayBuffer, disableWorker: boolean): Record<string, unknown> {
  const params: Record<string, unknown> = { data };
  if (disableWorker) {
    params.disableWorker = true;
  }
  return params;
}

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

function isLikelyFieldLabelText(text: string): boolean {
  const clean = text.trim();
  const normalized = normalizeText(clean);
  if (!clean || isFooterOrHeader(clean) || isQuestionNumber(clean)) return false;
  if (clean.length > 120) return false;
  return clean.includes("*") || clean.endsWith("?") || normalized.includes("email") || normalized.includes("name");
}

function isSectionHeadingText(text: string): boolean {
  const clean = text.trim();
  const normalized = normalizeText(clean);
  if (!clean) return false;
  if (clean.includes("'s") || clean.includes("’s")) return true;
  if (/\band\b/i.test(clean)) return true;
  return sectionHeadingWords.some((word) => normalized.includes(word));
}

function isLabelLine(text: string, labels: string[]): boolean {
  const hasRequiredMarker = text.includes("*");
  const clean = stripQuestionPrefix(text);
  if (!clean) return false;

  return labels.some((label) => {
    const labelClean = normalizeText(label);
    if (!labelClean) return false;
    if (clean === labelClean) return true;
    if (!clean.startsWith(`${labelClean} `)) return false;
    const tail = clean.slice(labelClean.length).trim();
    if (hasRequiredMarker) return true;
    if (!tail || tail === "required" || isQuestionNumber(tail)) return true;
    return tail.split(" ").every((part) => part === "required" || isQuestionNumber(part));
  });
}

function isNameValue(text: string): boolean {
  const clean = text.trim();
  const normalized = normalizeText(clean);
  if (!clean || emailPattern.test(clean)) return false;
  if (isQuestionNumber(clean) || isFooterOrHeader(clean)) return false;
  if (isSectionHeadingText(clean)) return false;
  if (/\d/.test(clean) || clean.length > 80) return false;

  const parts = clean.split(/\s+/).filter(Boolean);
  return parts.length >= 1 && parts.length <= 5 && parts.every((part) => /^[A-Za-z][A-Za-z'’.-]*$/.test(part));
}

function matchesValidator(text: string, validator: Validator, regex?: RegExp): boolean {
  const clean = text.trim();
  if (isFooterOrHeader(clean)) return false;
  if (validator !== "free_text" && isLikelyFieldLabelText(clean)) return false;
  if (isSectionHeadingText(clean)) return false;
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

function unionRect(rects: Rect[]): Rect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));

  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(6, bottom - top)
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
  return mergeTextSpansIntoLines(spans);
}

function areSameLine(a: TextSpan, b: TextSpan): boolean {
  if (a.pageIndex !== b.pageIndex) return false;
  const aMiddle = a.rect.y + a.rect.height / 2;
  const bMiddle = b.rect.y + b.rect.height / 2;
  return Math.abs(aMiddle - bMiddle) <= Math.max(3, Math.min(a.rect.height, b.rect.height) * 0.65);
}

function mergeTextSpansIntoLines(spans: TextSpan[]): TextSpan[] {
  const sorted = [...spans].sort((a, b) => {
    if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
    if (Math.abs(a.rect.y - b.rect.y) > 2) return a.rect.y - b.rect.y;
    return a.rect.x - b.rect.x;
  });
  const lines: TextSpan[][] = [];

  for (const span of sorted) {
    const currentLine = lines[lines.length - 1];
    if (currentLine && areSameLine(currentLine[0], span)) {
      currentLine.push(span);
    } else {
      lines.push([span]);
    }
  }

  return lines.map((line) => {
    const ordered = [...line].sort((a, b) => a.rect.x - b.rect.x);
    return {
      pageIndex: ordered[0].pageIndex,
      text: ordered.map((span) => span.text).join(" ").replace(/\s+/g, " ").trim(),
      rect: unionRect(ordered.map((span) => span.rect))
    };
  });
}

function findValueAfterLabel(labelSpan: TextSpan, spans: TextSpan[], rule: RedactionRule): TextSpan | undefined {
  const candidates = spans
    .filter((candidate) => {
      if (candidate.pageIndex !== labelSpan.pageIndex) return false;
      if (candidate === labelSpan) return false;
      if (candidate.rect.y <= labelSpan.rect.y) return false;
      const yDistance = candidate.rect.y - labelSpan.rect.y;
      if (yDistance > maxFieldAnswerDistance) return false;
      if (isLikelyFieldLabelText(candidate.text)) return false;
      return matchesValidator(candidate.text, rule.validator, rule.regex);
    })
    .sort((a, b) => {
      const yDelta = a.rect.y - labelSpan.rect.y - (b.rect.y - labelSpan.rect.y);
      if (Math.abs(yDelta) > 2) return yDelta;
      return Math.abs(a.rect.x - labelSpan.rect.x) - Math.abs(b.rect.x - labelSpan.rect.x);
    });

  return candidates[0];
}

function analyzeFields(spans: TextSpan[], rules: RedactionRule[]): FieldAnalysis[] {
  return rules.map((rule) => {
    const labels = spans.filter((span) => isLabelLine(span.text, rule.labels));
    const values = labels
      .map((label) => findValueAfterLabel(label, spans, rule))
      .filter((value): value is TextSpan => Boolean(value));
    const uniqueLabels = [...new Set(labels.map((label) => label.text.trim()))];
    const uniqueSamples = [...new Set(values.map((value) => value.text.trim()))].slice(0, 3);
    return {
      key: rule.key,
      title: rule.title,
      labels: uniqueLabels,
      samples: uniqueSamples,
      count: uniqueLabels.length
    };
  });
}

function collectSuggestedLabels(spans: TextSpan[], rules: RedactionRule[]): string[] {
  const knownLabels: string[] = [];
  for (const rule of rules) {
    for (const label of rule.labels) {
      knownLabels.push(normalizeText(label));
    }
  }
  const isKnownLabel = (text: string) => {
    const clean = stripQuestionPrefix(text);
    return knownLabels.some((label) => clean === label || clean.startsWith(`${label} `));
  };
  return [
    ...new Set(
      spans
        .map((span) => span.text.trim())
        .filter((text) => isLikelyFieldLabelText(text))
        .filter((text) => !isKnownLabel(text))
    )
  ].slice(0, 12);
}

function detectLabelValues(spans: TextSpan[], rules: RedactionRule[], options: ProcessOptions): RedactionHit[] {
  const selected = new Set(options.selectedKeys);
  const hits: RedactionHit[] = [];

  for (const rule of rules) {
    if (!selected.has(rule.key)) continue;
    const labels = spans.filter((span) => isLabelLine(span.text, rule.labels));
    debugLog(options.debug, `Rule "${rule.key}" matched ${labels.length} label(s).`, labels.map((label) => label.text));

    for (const labelSpan of labels) {
      const value = findValueAfterLabel(labelSpan, spans, rule);

      if (value) {
        debugLog(options.debug, `Rule "${rule.key}" selected value after "${labelSpan.text}".`, value.text);
        hits.push({
          pageIndex: value.pageIndex,
          rect: padRect(value.rect, options.padding),
          reason: rule.key,
          text: value.text
        });
      } else {
        debugLog(options.debug, `Rule "${rule.key}" did not find a safe answer after "${labelSpan.text}".`);
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
    const shouldScan = rule.key === "email" || (options.allRegex && rule.regex);
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
  const disableWorker = isSafariBrowser();
  debugLog(options.debug, `Loading PDF "${file.name}".`, { disableWorker, bytes: data.byteLength });
  const pdf = await pdfjsLib.getDocument(pdfDocumentParams(data, disableWorker) as never).promise;
  onProgress({ page: 0, totalPages: pdf.numPages, message: "Reading text" });

  const spans = await extractTextSpans(pdf);
  debugLog(options.debug, `Extracted ${spans.length} text span(s).`);
  const hits = dedupeHits([
    ...detectLabelValues(spans, rules, options),
    ...detectGlobalPatterns(spans, rules, options),
    ...detectCustomValues(spans, options)
  ]);
  debugLog(options.debug, `Detected ${hits.length} redaction box(es).`, hits.map((hit) => ({ reason: hit.reason, text: hit.text })));

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

export async function analyzePdfFiles(
  files: File[],
  rules: RedactionRule[],
  debug?: DebugLogger
): Promise<DocumentAnalysis> {
  const fields = new Map<string, FieldAnalysis>();
  const suggested = new Set<string>();
  let pageCount = 0;
  let spanCount = 0;

  for (const file of files) {
    const data = await file.arrayBuffer();
    const disableWorker = isSafariBrowser();
    debugLog(debug, `Analyzing PDF "${file.name}".`, { disableWorker, bytes: data.byteLength });
    const pdf = await pdfjsLib.getDocument(pdfDocumentParams(data, disableWorker) as never).promise;
    const spans = await extractTextSpans(pdf);
    pageCount += pdf.numPages;
    spanCount += spans.length;

    for (const item of analyzeFields(spans, rules)) {
      const previous = fields.get(item.key);
      if (!previous) {
        fields.set(item.key, item);
      } else {
        previous.count += item.count;
        previous.labels = [...new Set([...previous.labels, ...item.labels])];
        previous.samples = [...new Set([...previous.samples, ...item.samples])].slice(0, 3);
      }
    }

    for (const label of collectSuggestedLabels(spans, rules)) {
      suggested.add(label);
    }
  }

  const result = {
    fields: rules.map((rule) => fields.get(rule.key) ?? {
      key: rule.key,
      title: rule.title,
      labels: [],
      samples: [],
      count: 0
    }),
    suggestedLabels: [...suggested].slice(0, 12),
    pageCount,
    spanCount
  };
  debugLog(debug, "Document analysis complete.", result);
  return result;
}
