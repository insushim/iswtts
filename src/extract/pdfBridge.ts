// PDF 추출은 숨겨진 WebView(pdf.js)에서 수행된다. 호출부와 컴포넌트를 분리하는 브릿지.
export type PdfRequest = {
  id: string;
  base64: string;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
};

// WebView 미마운트/pdf.js 로드 실패/CDN 차단 시 Promise가 영구 pending 되는 것을 막는 상한.
// (임포트 스피너가 영원히 도는 CRITICAL 방지 — 초과 시 명시적 실패로 사용자에게 알린다.)
const PDF_TIMEOUT_MS = 25000;

let pump: ((req: PdfRequest) => void) | null = null;
// 타임아웃 시 PdfExtractor 쪽 pending 맵도 함께 정리하기 위한 취소 훅.
let canceller: ((id: string) => void) | null = null;
const backlog: PdfRequest[] = [];

export function _registerPdfPump(fn: (req: PdfRequest) => void, cancel?: (id: string) => void) {
  pump = fn;
  canceller = cancel ?? null;
  while (backlog.length) fn(backlog.shift()!);
}
export function _unregisterPdfPump() {
  pump = null;
  canceller = null;
}

// pdf.js 로드가 영구 실패로 확정됐을 때(모든 CDN 실패) 대기 전체를 즉시 실패시킨다.
export function _failAllPdfRequests(err: Error) {
  while (backlog.length) backlog.shift()!.reject(err);
}

export function extractPdf(base64: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const id = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    let settled = false;
    const timer = setTimeout(() => {
      const bi = backlog.indexOf(req);
      if (bi >= 0) backlog.splice(bi, 1);
      canceller?.(id);
      finish(() =>
        reject(new Error('PDF 추출 시간 초과 — 인터넷 연결을 확인한 뒤 다시 시도해주세요.')),
      );
    }, PDF_TIMEOUT_MS);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req: PdfRequest = {
      id,
      base64,
      resolve: (text) => finish(() => resolve(text)),
      reject: (err) => finish(() => reject(err)),
    };
    if (pump) pump(req);
    else backlog.push(req);
  });
}
