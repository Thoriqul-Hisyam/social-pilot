# SocialPilot

Multi-account publishing untuk Threads (Facebook Page menyusul). Next.js + SQLite, tanpa dependency runtime tambahan.

## Fitur

- Dashboard terproteksi password
- OAuth Threads, token 60 hari, tersimpan terenkripsi AES-256-GCM
- Composer: teks + gambar atau video, >500 karakter otomatis jadi balasan berantai
- Antrean dengan jeda acak 5–30 menit setelah slot antrean terakhir, dedup per `source_url`
- Worker tick: 1 post per panggilan, retry 3x, klaim atomic
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

Permission wajib: `threads_basic`, `threads_content_publish`, `threads_manage_replies`, `threads_delete`.

Tanpa `threads_manage_replies`, post >500 karakter gagal di bagian kedua. Tanpa `threads_delete`, bagian yang sudah tayang dari chain yang putus tidak bisa dihapus otomatis dan harus dihapus manual.

Threads menolak HTTP dan IP LAN. Harus domain HTTPS.

### 3. Siapkan Cloudflare R2

Threads mengunduh gambar sendiri dari `imageUrl`. Banyak CDN berita (misalnya `image.cnbcfm.com`) menolak pengunduh Meta dengan 403, dan Threads melaporkannya hanya sebagai `[threads 1]: An unknown error has occurred`. Karena itu app mengunduh gambar lebih dulu dengan user-agent browser, lalu mengunggahnya ke R2. URL R2 itulah yang diberikan ke Threads.

1. **R2 → Create bucket**, misalnya `socialpilot-media`.
2. **Bucket → Settings → Custom Domains**: hubungkan subdomain, misalnya `media.domain.com`. URL `r2.dev` juga bisa, tapi rate-nya dibatasi dan hanya untuk uji.
3. **R2 → Manage API tokens → Create API token**: izin *Object Read & Write*, dibatasi ke bucket ini. Salin Access Key ID dan Secret Access Key ke `R2_ACCESS_KEY_ID` dan `R2_SECRET_ACCESS_KEY`. Account ID ada di halaman R2.
4. **Bucket → Settings → Object lifecycle rules**: hapus objek berawalan `threads/` setelah 7 hari. Threads hanya mengambil gambar saat post dibuat.
5. Jangan pasang Bot Fight Mode atau WAF challenge di domain bucket. Kalau terpasang, pengunduh Meta bisa terblokir lagi.

Tanpa lima env `R2_*`, post bergambar gagal permanen dengan `R2 not configured`. Setelah env diisi, post itu bisa di-retry dari dashboard. Hanya JPEG/PNG maksimal 8 MB yang diterima. WebP, AVIF, dan GIF ditolak dengan pesan yang menyebut formatnya. Video tidak disalin; `videoUrl` tetap diberikan langsung ke Threads.

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
  -d '{"items":[{"caption":"...","imageUrl":"https://...","sourceUrl":"https://..."}]}'
```

`sourceUrl` yang sama tidak akan diantrekan dua kali. Tiap item butuh tepat satu `imageUrl` atau `videoUrl` (HTTPS publik). `scheduledAt` opsional (ISO, boleh dengan offset seperti `+07:00`; tanpa zona dianggap UTC). Satu item yang tidak valid menolak seluruh batch.

Publish langsung:

```bash
curl -X POST https://domain.com/api/publish/threads \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"text":"...","imageUrl":"https://..."}'
```

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
npm test            # 58 assertions: crypto, DB, dedup, atomic claim, retry, queue tail, text split, preview, R2 signing, image sniffing
npm run typecheck   # tsc --noEmit
npm run build       # production build
```

Smoke test terhadap server yang sedang jalan (memverifikasi auth, OAuth state, validasi antrean, rate limit login):

```bash
sh scripts/setup-test-env.sh   # generate secret lokal
npm run dev -- --port 7949 &
sh scripts/smoke.sh            # 25 pemeriksaan HTTP; SP_TMP=<dir> untuk ganti /tmp
```

`setup-test-env.sh` menimpa `ENCRYPTION_KEY` di `.env.local`, jadi token akun yang tersimpan tidak bisa dibaca lagi. Di mesin yang sudah punya akun terhubung, berikan secret uji dan `DATABASE_PATH` sementara lewat environment variable saja; nilai itu menang atas `.env.local`.

Catatan: `Dockerfile` dan `docker-compose.yml` belum pernah dieksekusi di mesin build ini (daemon Docker tidak tersedia). Build Next standalone sudah terverifikasi; jalankan `docker build` sekali di server sebelum mengandalkannya.

## Catatan operasional

- `imageUrl` harus URL publik HTTPS. Path lokal ditolak Threads. Gambar disalin ke R2 sebelum dikirim (lihat langkah 3).
- Error kode 1/2 dari Threads saat membuat container dicoba ulang dua kali (jeda 5 dan 15 detik). Error Threads menyertakan `fbtrace_id` untuk dilaporkan ke Meta.
- Batas teks Threads 500 karakter per post; sisanya jadi balasan.
- Token kedaluwarsa 60 hari. Dashboard menampilkan tanggalnya; connect ulang sebelum lewat.
- Backup: cukup salin file di volume `/app/data`.

## Belum ada

- Facebook Page publishing (skema DB sudah siap)
- Refresh token otomatis
- Analytics engagement
