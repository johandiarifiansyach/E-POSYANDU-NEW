# Frontend

Antarmuka E-Posyandu dibangun dengan HTML5, Tailwind CSS, dan TypeScript native. Komponen di `src/pages` membuat `HTMLElement` dan `SVGElement` secara langsung melalui utilitas kecil di `src/native/dom.ts`; frontend tidak memakai React, JSX/TSX, maupun virtual DOM.

Service Worker menyimpan app shell dan aset build yang memiliki hash. Data halaman disimpan di IndexedDB, sedangkan perubahan offline masuk antrean idempotent dan dikirim melalui endpoint sinkronisasi saat koneksi tersedia.

```bash
npm run dev
npm run typecheck
npm run build
```
