# SocialPilot

Multi-account publishing untuk Threads (Facebook Page menyusul). Next.js + SQLite, tanpa dependency runtime tambahan.

## Fitur

- Dashboard terproteksi password
- OAuth Threads, token 60 hari, tersimpan terenkripsi AES-256-GCM, diperpanjang otomatis sekitar seminggu sekali
- Composer: teks + gambar atau video, >500 karakter otomatis jadi balasan berantai
- Antrean dengan jeda acak 5–30 menit setelah slot antrean terakhir, dedup per `source_url` untuk berita
- Jenis post `news` (berita) dan `affiliate`; dashboard bisa difilter per jenis, tiap daftar berhalaman 10 post
- Worker tick: 1 post per panggilan, retry 3x dengan jeda 10 lalu 20 menit, klaim atomic
- Insight Threads per post (views, likes, replies, reposts, quotes, shares), dibandingkan per jenis di dashboard dan lewat `GET /api/insights`
- Antrean akun dijeda otomatis kalau Threads menolak tokennya, sampai akun dihubungkan ulang
- REST API untuk otomasi (scraper, cron, n8n)

## Deploy

### 1. Siapkan env

```bash
cp .env.example .env
openssl rand -base64 48   # untuk ENCRYPTION_KEY
openssl rand -base64 48   # untuk SESSION_SECRET
openssl rand -base64 32   # untuk API_KEY
```

Isi `.env`, lalu kunci permission:

```bash
chmod 600 .env
```

`ENCRYPTION_KEY` mengenkripsi token akun. **Kalau diganti, semua akun harus connect ulang.**

### 2. Konfigurasi Meta

developers.facebook.com → app → **Threads API → Settings**:

| Field | Isi |
|---|---|
| URL Callback Alihkan | `https://domain.com/api/auth/threads/callback` |
| Hapus Instalan URL Callback | `https://domain.com/api/auth/threads/deauthorize` |
| Hapus URL Callback | `https://domain.com/api/auth/threads/delete` |

Permission wajib: `threads_basic`, `threads_content_publish`, `threads_manage_replies`, `threads_delete`, `threads_manage_insights`.

Tanpa `threads_manage_replies`, post >500 karakter gagal di bagian kedua. Tanpa `threads_delete`, bagian yang sudah tayang dari chain yang putus tidak bisa dihapus otomatis dan harus dihapus manual. Tanpa `threads_manage_insights`, posting tetap jalan tapi kartu Performa kosong dan feed crew menampilkan `Insight belum bisa dibaca` (dicoba lagi tiap jam). Setelah menambah permission, hubungkan ulang akun supaya tokennya membawa izin baru.

Threads menolak HTTP dan IP LAN. Harus domain HTTPS.

### 3. Siapkan Cloudflare R2

Threads mengunduh gambar sendiri dari `imageUrl`. Banyak CDN berita (misalnya `image.cnbcfm.com`) menolak pengunduh Meta dengan 403, dan Threads melaporkannya hanya sebagai `[threads 1]: An unknown error has occurred`. Karena itu app mengunduh gambar lebih dulu dengan user-agent browser, lalu mengunggahnya ke R2. URL R2 itulah yang diberikan ke Threads.

1. **R2 → Create bucket**, misalnya `socialpilot-media`.
2. **Bucket → Settings → Custom Domains**: hubungkan subdomain, misalnya `media.domain.com`. URL `r2.dev` juga bisa, tapi rate-nya dibatasi dan hanya untuk uji.
3. **R2 → Manage API tokens → Create API token**: izin *Object Read & Write*, dibatasi ke bucket ini. Salin Access Key ID dan Secret Access Key ke `R2_ACCESS_KEY_ID` dan `R2_SECRET_ACCESS_KEY`. Account ID ada di halaman R2.
4. **Bucket → Settings → Object lifecycle rules**: hapus objek berawalan `threads/` setelah 7 hari. Threads hanya mengambil gambar saat post dibuat.
5. Jangan pasang Bot Fight Mode atau WAF challenge di domain bucket. Kalau terpasang, pengunduh Meta bisa terblokir lagi.

Tanpa lima env `R2_*`, post bergambar langsung gagal dengan `R2 not configured` tanpa dicoba ulang otomatis. Env hanya dibaca saat proses start, jadi setelah mengisinya restart app (`systemctl restart socialpilot`, atau `docker compose up -d` karena `docker compose restart` tidak membaca ulang `env_file`), lalu klik **Proses ulang** di dashboard. Hanya JPEG/PNG maksimal 8 MB yang diterima. WebP, AVIF, dan GIF ditolak dengan pesan yang menyebut formatnya. CDN yang menjawab file tidak ada dengan HTTP 200 dan body kosong atau HTML (misalnya `cdn.antaranews.com`) menghasilkan `image download failed … Does the file exist?` beserta URL-nya, dan post itu dicoba ulang otomatis. Video tidak disalin; `videoUrl` tetap diberikan langsung ke Threads.

### 4. Jalankan

Docker:

```bash
docker compose up -d --build
```

Systemd:

```bash
npm ci && npm run build
sudo cp deploy/socialpilot*.service deploy/socialpilot-worker.timer /etc/systemd/system/
sudo systemctl enable --now socialpilot socialpilot-worker.timer
```

PM2:

```bash
npm ci && npm run build
pm2 start scripts/start.mjs --name socialpilot -- --with-worker
pm2 save
```

Jangan arahkan PM2 atau process manager lain ke `.next/standalone/server.js`. File itu pindah ke `.next/standalone`, sehingga `.env` dan `.env.local` di root tidak terbaca, dan `DATABASE_PATH` relatif menunjuk ke folder yang dihapus setiap `npm run build`.

Reverse proxy: lihat `deploy/nginx.conf`. Wajib meneruskan `X-Forwarded-For` — rate limit login bergantung padanya.

### 5. Hubungkan akun

Buka `https://domain.com`, login, klik **Tambah akun Threads**.

Buka dashboard lewat domain yang sama dengan `THREADS_REDIRECT_URI`, bukan `localhost` atau IP. Callback hanya menerima akun kalau cookie login dan cookie `state` OAuth ikut kembali, dan cookie itu terikat ke domain. Kalau penukaran ke token 60 hari gagal, akun tidak disimpan.

## API

Semua endpoint butuh `Authorization: Bearer $API_KEY` atau cookie sesi.

Antrekan artikel dari scraper:

```bash
curl -X POST https://domain.com/api/posts \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"caption":"...","imageUrl":"https://...","sourceUrl":"https://...","kind":"news"}]}'
```

`kind` wajib di setiap item: `news` (berita, sertakan `sourceUrl` artikelnya) atau `affiliate`, persis huruf kecil. Item tanpa `kind` atau dengan nilai lain menolak seluruh batch (HTTP 400, `items_with_invalid_kind` menyebut nomor itemnya), dan tidak ada yang masuk antrean. `sourceUrl` berita yang sama tidak akan diantrekan dua kali; affiliate boleh berulang. Tiap item butuh tepat satu `imageUrl` atau `videoUrl` (HTTPS publik). `scheduledAt` opsional (ISO, boleh dengan offset seperti `+07:00`; tanpa zona dianggap UTC). Satu item yang tidak valid menolak seluruh batch.

Publish langsung:

```bash
curl -X POST https://domain.com/api/publish/threads \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"text":"...","imageUrl":"https://...","kind":"news"}'
```

`kind` juga wajib di sini, dengan nilai yang sama.

Insight performa (untuk dashboard dan crew):

```bash
curl "https://domain.com/api/insights?days=7&kind=news" -H "Authorization: Bearer $API_KEY"
```

`days` 1–90 (default 7), `kind` opsional. Hasilnya per jenis: `posts`, `covered` (post yang sudah terbaca), `errors` (post yang pembacaan terakhirnya gagal), `gone` (post yang sudah dihapus di Threads; tidak dibaca lagi dan tidak ikut di angka lain), total `views`/`likes`/`replies`/`reposts`/`quotes`/`shares`, `avg_views`, `avg_likes`, dan `engagement_rate` = (likes + replies + reposts + quotes + shares) / views. Ditambah `top` dan `bottom` (5 post, caption 120 karakter; `bottom` melewati post yang belum berumur sehari), serta `top_by_kind` dan `bottom_by_kind` per jenis. Angka diambil worker tick, 20 post per tick: post yang belum pernah terbaca lebih dulu (terbaru dulu, termasuk riwayat lama), lalu dibaca ulang tiap 3 jam di hari pertamanya dan tiap 12 jam sampai berumur seminggu. Pembacaan yang gagal dicoba lagi sehari sekali sampai post berumur 30 hari. Setelah akun dihubungkan ulang, riwayat lama butuh beberapa jam sampai terbaca semua; selama itu angka 30 hari masih didominasi post terbaru. Untuk chain, yang dibaca post akarnya; balasan tidak dijumlahkan Threads.

Tick manual:

```bash
curl -X POST https://domain.com/api/worker/tick -H "Authorization: Bearer $API_KEY"
```

Health check (tanpa auth):

```bash
curl https://domain.com/api/health
```

## Test

```bash
npm test            # 125 assertions: crypto, DB, migrasi kind, refresh token, jeda token, insight, post dihapus di Threads, dedup, paginasi, jeda retry, atomic claim, retry, queue tail, text split, preview, R2 signing, image sniffing
npm run typecheck   # tsc --noEmit
npm run build       # production build
```

Smoke test terhadap server yang sedang jalan (memverifikasi auth, OAuth state, validasi antrean, rate limit login):

```bash
sh scripts/setup-test-env.sh   # generate secret lokal
npm run dev -- --port 7949 &
sh scripts/smoke.sh            # 29 pemeriksaan HTTP; SP_TMP=<dir> untuk ganti /tmp
```

`setup-test-env.sh` menimpa `ENCRYPTION_KEY` di `.env.local`, jadi token akun yang tersimpan tidak bisa dibaca lagi. Di mesin yang sudah punya akun terhubung, berikan secret uji dan `DATABASE_PATH` sementara lewat environment variable saja; nilai itu menang atas `.env.local`.

Catatan: `Dockerfile` dan `docker-compose.yml` belum pernah dieksekusi di mesin build ini (daemon Docker tidak tersedia). Build Next standalone sudah terverifikasi; jalankan `docker build` sekali di server sebelum mengandalkannya.

## Catatan operasional

- `imageUrl` harus URL publik HTTPS. Path lokal ditolak Threads. Gambar disalin ke R2 sebelum dikirim (lihat langkah 3).
- Error kode 1/2 dari Threads saat membuat container dicoba ulang dua kali (jeda 5 dan 15 detik). Error Threads menyertakan `fbtrace_id` untuk dilaporkan ke Meta.
- Batas teks Threads 500 karakter per post; sisanya jadi balasan.
- Kalau Threads menolak token (kode 190, misalnya izin dicabut atau password akun diganti), antrean akun itu dijeda: post tidak dihabiskan percobaannya, dashboard menampilkan banner merah, dan antrean jalan lagi begitu akun dihubungkan ulang.
- Token kedaluwarsa 60 hari. Worker tick memperpanjangnya otomatis begitu sisa masa berlakunya di bawah 53 hari. Kalau gagal, feed crew menampilkan `Token @… gagal diperpanjang` dan dicoba lagi 12 jam kemudian. Dashboard tetap menampilkan tanggal kedaluwarsa; connect ulang kalau perpanjangan terus gagal.
- Backup: cukup salin file di volume `/app/data`.

## Belum ada

- Facebook Page publishing (skema DB sudah siap)
