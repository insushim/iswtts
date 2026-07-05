import React, { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';
import {
  _registerPdfPump,
  _unregisterPdfPump,
  _failAllPdfRequests,
  type PdfRequest,
} from '../extract/pdfBridge';

// pdf.js를 로드한 숨겨진 WebView. base64 PDF를 받아 페이지별 텍스트를 추출해 돌려준다.
// v1.3: CDN 2원화(cdnjs → jsdelivr 폴백) + 전부 실패 시 fatal 통지(브릿지 타임아웃과 이중 안전망).
// 완전 오프라인(pdf.js 앱 내 번들)은 후속 — 임포트 시에는 인터넷 필요.
const PDFJS_VERSION = '4.6.82';

const HTML = `<!doctype html><html><head><meta charset="utf-8"/>
<script type="module">
  function post(o){ window.ReactNativeWebView.postMessage(JSON.stringify(o)); }
  const CDNS = [
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}',
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build',
  ];
  let pdfjsLib = null;
  (async () => {
    for (const base of CDNS) {
      try {
        pdfjsLib = await import(base + '/pdf.min.mjs');
        pdfjsLib.GlobalWorkerOptions.workerSrc = base + '/pdf.worker.min.mjs';
        post({ ready: true });
        return;
      } catch (e) { /* 다음 CDN 시도 */ }
    }
    post({ fatal: 'pdf.js 로드 실패 — 인터넷 연결을 확인해주세요.' });
  })();
  function b64ToBytes(b64){
    const bin = atob(b64); const len = bin.length; const bytes = new Uint8Array(len);
    for (let i=0;i<len;i++) bytes[i]=bin.charCodeAt(i);
    return bytes;
  }
  window.__extract = async function(id, b64){
    try{
      if (!pdfjsLib) throw new Error('pdf.js 미로드');
      const data = b64ToBytes(b64);
      const pdf = await pdfjsLib.getDocument({ data }).promise;
      let out = [];
      for (let p=1; p<=pdf.numPages; p++){
        const page = await pdf.getPage(p);
        const tc = await page.getTextContent();
        let last = null, line = '';
        for (const it of tc.items){
          const s = it.str || '';
          if (last !== null && Math.abs((it.transform[5]||0) - last) > 2){ out.push(line); line=''; }
          line += s + (it.hasEOL ? '\\n' : ' ');
          last = it.transform ? it.transform[5] : last;
        }
        if (line) out.push(line);
        out.push('');
      }
      post({ id, ok:true, text: out.join('\\n') });
    }catch(e){ post({ id, ok:false, error: String(e && e.message || e) }); }
  };
</script></head><body></body></html>`;

export default function PdfExtractor() {
  const webRef = useRef<WebView>(null);
  const pending = useRef<Map<string, PdfRequest>>(new Map());
  const ready = useRef(false);
  const failed = useRef<string | null>(null); // pdf.js 로드 영구 실패 사유(전 CDN 실패)
  const queue = useRef<PdfRequest[]>([]);

  useEffect(() => {
    const send = (req: PdfRequest) => {
      if (failed.current) {
        req.reject(new Error(failed.current));
        return;
      }
      pending.current.set(req.id, req);
      if (ready.current) fire(req);
      else queue.current.push(req);
    };
    // 두 번째 인자 = 브릿지 타임아웃 시 pending 맵 정리 훅(누수 방지).
    _registerPdfPump(send, (id) => pending.current.delete(id));
    return () => _unregisterPdfPump();
  }, []);

  const fire = (req: PdfRequest) => {
    const js = `window.__extract(${JSON.stringify(req.id)}, ${JSON.stringify(
      req.base64,
    )}); true;`;
    webRef.current?.injectJavaScript(js);
  };

  const onMessage = (e: { nativeEvent: { data: string } }) => {
    let msg: any;
    try {
      msg = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    if (msg.ready) {
      ready.current = true;
      const q = queue.current.splice(0);
      q.forEach(fire);
      return;
    }
    if (msg.fatal) {
      // 모든 CDN 실패 → 대기 중인 요청 전부 즉시 실패(25초 타임아웃을 기다리지 않게).
      failed.current = String(msg.fatal);
      const err = new Error(failed.current);
      const q = queue.current.splice(0);
      q.forEach((r) => r.reject(err));
      pending.current.forEach((r) => r.reject(err));
      pending.current.clear();
      _failAllPdfRequests(err);
      return;
    }
    const req = pending.current.get(msg.id);
    if (!req) return;
    pending.current.delete(msg.id);
    if (msg.ok) req.resolve(msg.text || '');
    else req.reject(new Error(msg.error || 'PDF 추출 실패'));
  };

  return (
    <View style={{ width: 0, height: 0, position: 'absolute', opacity: 0 }} pointerEvents="none">
      <WebView
        ref={webRef}
        originWhitelist={['*']}
        source={{ html: HTML }}
        javaScriptEnabled
        domStorageEnabled
        onMessage={onMessage}
        androidLayerType="software"
      />
    </View>
  );
}
