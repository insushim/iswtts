// PDF 추출은 숨겨진 WebView(pdf.js)에서 수행된다. 호출부와 컴포넌트를 분리하는 브릿지.
export type PdfRequest = {
  id: string;
  base64: string;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
};

let pump: ((req: PdfRequest) => void) | null = null;
const backlog: PdfRequest[] = [];

export function _registerPdfPump(fn: (req: PdfRequest) => void) {
  pump = fn;
  while (backlog.length) fn(backlog.shift()!);
}
export function _unregisterPdfPump() {
  pump = null;
}

export function extractPdf(base64: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const req: PdfRequest = {
      id: `${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      base64,
      resolve,
      reject,
    };
    if (pump) pump(req);
    else backlog.push(req);
  });
}
