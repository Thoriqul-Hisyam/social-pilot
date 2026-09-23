# SocialPilot

Multi-account publishing untuk Threads (Facebook Page menyusul). Next.js + SQLite, tanpa dependency runtime tambahan.

## Fitur

- Dashboard terproteksi password
- OAuth Threads, token 60 hari, tersimpan terenkripsi AES-256-GCM
- Composer: teks + gambar, >500 karakter otomatis jadi balasan berantai
- Antrean dengan jeda acak 5–30 menit, dedup per `source_url`
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

### 3. Jalankan

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

### 4. Hubungkan akun

Buka `https://domain.com`, login, klik **Tambah akun Threads**.

## API

Semua endpoint butuh `Authorization: Bearer $API_KEY` atau cookie sesi.

Antrekan artikel dari scraper:

```bash
curl -X POST https://domain.com/api/posts \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"caption":"...","imageUrl":"https://...","sourceUrl":"https://..."}]}'
```

`sourceUrl` yang sama tidak akan diantrekan dua kali.

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
npm test          # 39 assertions: crypto, DB, dedup, atomic claim, retry, text split
npm run build     # type check + production build
```

Smoke test terhadap server yang sedang jalan (memverifikasi auth benar-benar memblokir):

```bash
sh scripts/setup-test-env.sh   # generate secret lokal
npm run dev -- --port 7949 &
sh scripts/smoke.sh            # 16 pemeriksaan HTTP
```

Catatan: `Dockerfile` dan `docker-compose.yml` belum pernah dieksekusi di mesin build ini (daemon Docker tidak tersedia). Build Next standalone sudah terverifikasi; jalankan `docker build` sekali di server sebelum mengandalkannya.

## Catatan operasional

- `imageUrl` harus URL publik HTTPS. Path lokal ditolak Threads.
- Batas teks Threads 500 karakter per post; sisanya jadi balasan.
- Token kedaluwarsa 60 hari. Dashboard menampilkan tanggalnya; connect ulang sebelum lewat.
- Backup: cukup salin file di volume `/app/data`.

## Belum ada

- Facebook Page publishing (skema DB sudah siap)
- Refresh token otomatis
- Analytics engagement
