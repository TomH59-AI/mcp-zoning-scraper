declare module "pdf-parse/lib/pdf-parse.js" {
  type PdfResult = { text: string; numpages?: number; info?: Record<string, unknown> };
  export default function pdfParse(data: Buffer | Uint8Array): Promise<PdfResult>;
}
