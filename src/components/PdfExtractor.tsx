import React, { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';
import {
  _registerPdfPump,
  _unregisterPdfPump,
  type PdfRequest,
} from '../extract/pdfBridge';

// pdf.js를 로드한 숨겨진 WebView. base64 PDF를 받아 페이지별 텍스트를 추출해 돌려준다.
// v1: pdf.js를 CDN에서 로드(임포트 시 인터넷 필요). 오프라인 PDF는 후속(번들 pdf.js).
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82';

const HTML = `<!doctype html><html><head><meta charset="utf-8"/>
<script src="${PDFJS}/pdf.min.mjs" type="module"></script>
<script type="module">
  import * as pdfjsLib from '${PDFJS}/pdf.min.mjs';
  pdfjsLib.GlobalWorkerOptions.workerSrc = '${PDFJS}/pdf.worker.min.mjs';
  function post(o){ window.ReactNativeWebView.postMessage(JSON.stringify(o)); }
  function b64ToBytes(b64){
    const bin = atob(b64); const len = bin.length; const bytes = new Uint8Array(len);
    for (let i=0;i<len;i++) bytes[i]=bin.charCodeAt(i);
    return bytes;
  }
  window.__extract = async function(id, b64){
    try{
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
  post({ ready:true });
</script></head><body></body></html>`;

export default function PdfExtractor() {
  const webRef = useRef<WebView>(null);
  const pending = useRef<Map<string, PdfRequest>>(new Map());
  const ready = useRef(false);
  const queue = useRef<PdfRequest[]>([]);

  useEffect(() => {
    const send = (req: PdfRequest) => {
      pending.current.set(req.id, req);
      if (ready.current) fire(req);
      else queue.current.push(req);
    };
    _registerPdfPump(send);
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
