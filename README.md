# SocialPilot

Publishing multi-akun dan multi-platform: Threads, Instagram, dan Facebook Page. Next.js + SQLite; satu dependency runtime tambahan, `sharp`, untuk menyesuaikan gambar ke aturan Instagram dan Facebook.

## Fitur

- Dashboard terproteksi password
- Banyak akun di banyak platform: Threads, Instagram (akun Business/Creator), dan Facebook Page. Tiap akun dihubungkan lewat OAuth platformnya, tokennya tersimpan terenkripsi AES-256-GCM
- Token Threads dan Instagram (60 hari) diperpanjang otomatis sekitar seminggu sekali; token Page Facebook tidak kedaluwarsa
- Tiap akun memilih jenis post yang diterima otomatis (Berita, Affiliate, keduanya, atau tidak sama sekali). Post dari Hermes tanpa `accountId` masuk ke semua akun yang cocok
- Composer: teks + gambar atau video, dengan pratinjau post di tiap platform. Di Threads, >500 karakter jadi balasan berantai; di platform lain teks jadi satu post dan dipotong sesuai batasnya (Instagram 2.200 karakter), baris `Sumber:` tetap dipertahankan. Post masuk antrean, dijadwalkan di waktu tertentu, atau langsung terbit
- Antrean per akun: tiap akun punya ritme sendiri dengan jeda acak 5–30 menit setelah slot antreannya yang terakhir, dedup per `source_url` untuk berita per akun
- Jenis post `news` (berita) dan `affiliate`; dashboard bisa difilter per jenis dan dicari per caption, tiap daftar berhalaman 25 post
- Worker tick: maksimal 1 post per akun per panggilan, akun-akun berjalan bersamaan; retry 3x dengan jeda 10 lalu 20 menit, klaim atomic
- Insight per post dari tiap platform (views, likes, balasan/komentar, reposts, quotes, shares), dibandingkan per jenis dan bisa difilter per platform di dashboard dan lewat `GET /api/insights`
- Antrean akun dijeda otomatis kalau platform menolak tokennya, sampai akun dihubungkan ulang; akun lain tetap jalan. Batas harian Instagram dan rate limit menunda post 1 jam tanpa menghabiskan percobaannya
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

Tanpa `threads_manage_replies`, post >500 karakter gagal di bagian kedua. Tanpa `threads_delete`, bagian yang sudah tayang dari chain yang putus tidak bisa dihapus otomatis dan harus dihapus manual. Tanpa `threads_manage_insights`, posting tetap jalan tapi halaman Analitik kosong dan feed crew menampilkan `Insight belum bisa dibaca` (dicoba lagi tiap jam). Setelah menambah permission, hubungkan ulang akun supaya tokennya membawa izin baru.

Threads menolak HTTP dan IP LAN. Harus domain HTTPS.

### 2b. Platform lain (opsional)

Isi hanya platform yang dipakai. Platform yang env-nya belum lengkap tampil abu-abu di bagian **Hubungkan channel** (halaman **Akun & rute**) beserta env yang kurang. Semua callback memakai `PUBLIC_APP_URL` (atau origin `THREADS_REDIRECT_URI`), kecuali di-override dengan `<PLATFORM>_REDIRECT_URI`.

**Instagram** (Instagram API with Instagram Login; akun harus Business atau Creator, tanpa perlu Page Facebook)

1. developers.facebook.com → app → **Add use case** → *Manage messaging & content on Instagram*. Use case tidak bisa dihapus lagi; kalau tidak bisa digabung dengan app Threads, buat app Meta terpisah.
2. **Instagram → API setup with Instagram login → Set up Instagram business login → Business login settings**: OAuth redirect URI `https://domain.com/api/auth/instagram/callback` (ganti `domain.com` dengan domain dashboard). Lewati langkah *Configure webhooks*: SocialPilot tidak memakai webhook. Form webhook memanggil URL-nya untuk verifikasi, jadi URL callback OAuth yang diisi di sana selalu gagal dengan "URL callback atau token verifikasi tidak dapat divalidasi".
3. Salin *Instagram app ID* dan *Instagram app secret* (beda dari Meta app ID) ke `INSTAGRAM_APP_ID` dan `INSTAGRAM_APP_SECRET`.
4. Selama app belum lolos App Review, tambahkan akun sebagai **Instagram Tester** (App roles), lalu terima undangannya di instagram.com → Settings → Apps and websites → Tester invites.
5. Isi URL deauthorize dan data deletion dengan URL Threads di atas; endpoint-nya sama.

Permission: `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_insights`. Gambar disalin ke R2 sebagai JPEG (Instagram menolak PNG/WebP), dilebarkan dengan bidang putih ke rasio 4:5–1.91:1 (tidak di-crop), lebar 320–1440 px. Video terbit sebagai Reels. Instagram membatasi 50–100 post API per 24 jam per akun (dokumentasi Meta tidak konsisten); begitu tercapai, post ditunda 1 jam dan dicoba lagi. Post Instagram tidak bisa dihapus lewat API ini.

**Facebook Page**

1. developers.facebook.com → **My Apps** → app Threads → menu kiri **Use cases** (Kasus penggunaan) → **Add use case** → *Manage everything on your Page* (Kelola semua hal di Halaman Anda). Menurut dokumentasi Meta, use case ini bisa digabung dengan Threads; kalau opsinya abu-abu, buat app baru dengan use case ini.
2. Menu kiri **Dashboard** → use case Page → **Customize** (Sesuaikan) → **Permissions and features**: **Add** `pages_manage_posts`, `pages_read_engagement`, `read_insights` (`pages_show_list` sudah ada).
3. Menu kiri **Facebook Login for Business → Settings**: Valid OAuth Redirect URIs `https://domain.com/api/auth/facebook/callback` (ganti `domain.com` dengan domain dashboard).
4. **Facebook Login for Business → Configurations → Create configuration**: token *User access token*, masa berlaku *Never* kalau ada, aset Page yang mau dipakai, izin dari langkah 2. Salin *Configuration ID* ke `FACEBOOK_CONFIG_ID`; login lalu memakai `config_id`, bukan `scope`, sesuai anjuran Meta.
5. Menu kiri **App settings → Basic** (Pengaturan aplikasi → Dasar): *App ID* ke `META_FACEBOOK_APP_ID`, *App secret* ke `META_FACEBOOK_APP_SECRET`. Nilainya beda dari `META_THREADS_APP_ID` walaupun app-nya sama.

Permission: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `read_insights`. Saat menyetujui, pilih Page yang mau dikelola: satu kali connect menambahkan semua Page yang bisa kamu posting, masing-masing sebagai akun sendiri. Token Page tidak kedaluwarsa, jadi tidak ada perpanjangan; connect ulang kalau password Facebook diganti atau izin dicabut. Teks dikirim utuh, gambar disalin ke R2 sebagai JPEG (batas Facebook 4 MB).

### 3. Siapkan Cloudflare R2

Threads mengunduh gambar sendiri dari `imageUrl`. Banyak CDN berita (misalnya `image.cnbcfm.com`) menolak pengunduh Meta dengan 403, dan Threads melaporkannya hanya sebagai `[threads 1]: An unknown error has occurred`. Karena itu app mengunduh gambar lebih dulu dengan user-agent browser, lalu mengunggahnya ke R2. URL R2 itulah yang diberikan ke Threads.

1. **R2 → Create bucket**, misalnya `socialpilot-media`.
2. **Bucket → Settings → Custom Domains**: hubungkan subdomain, misalnya `media.domain.com`. URL `r2.dev` juga bisa, tapi rate-nya dibatasi dan hanya untuk uji.
3. **R2 → Manage API tokens → Create API token**: izin *Object Read & Write*, dibatasi ke bucket ini. Salin Access Key ID dan Secret Access Key ke `R2_ACCESS_KEY_ID` dan `R2_SECRET_ACCESS_KEY`. Account ID ada di halaman R2.
4. **Bucket → Settings → Object lifecycle rules**: hapus objek berawalan `threads/`, `instagram/`, dan `facebook/` setelah 7 hari (atau satu aturan tanpa prefix kalau bucket ini khusus SocialPilot). Platform hanya mengambil gambar saat post dibuat.
5. Jangan pasang Bot Fight Mode atau WAF challenge di domain bucket. Kalau terpasang, pengunduh Meta bisa terblokir lagi.

Tanpa lima env `R2_*`, post bergambar Threads, Instagram, dan Facebook langsung gagal dengan `R2 not configured` tanpa dicoba ulang otomatis. Env hanya dibaca saat proses start, jadi setelah mengisinya restart app (`systemctl restart socialpilot`, atau `docker compose up -d` karena `docker compose restart` tidak membaca ulang `env_file`), lalu klik **Coba lagi** di tab **Gagal** halaman **Konten**. Untuk Threads hanya JPEG/PNG maksimal 8 MB yang diterima; WebP, AVIF, dan GIF ditolak dengan pesan yang menyebut formatnya. Untuk Instagram dan Facebook format itu dikonversi ke JPEG. CDN yang menjawab file tidak ada dengan HTTP 200 dan body kosong atau HTML (misalnya `cdn.antaranews.com`) menghasilkan `image download failed … Does the file exist?` beserta URL-nya, dan post itu dicoba ulang otomatis. Video tidak disalin: `videoUrl` diberikan langsung ke Threads, Instagram, dan Facebook.

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

Buka `https://domain.com`, login, buka **Akun**, lalu pilih platformnya di **Hubungkan channel** (juga ada di menu profil, kanan atas). Untuk menambah akun kedua di platform yang sama, keluar dulu dari akun pertama di browser (threads.net, instagram.com), lalu hubungkan lagi.

Dashboard punya empat halaman di bar atas (di ponsel, bar bawah):

- **Beranda**: yang perlu perhatian (token hampir habis, antrean kosong, post gagal), angka hari ini, aktivitas 14 hari, post berikutnya, status tiap channel, dan post terbaik minggu ini.
- **Konten**: channel di kiri, lalu tab **Antrean**, **Gagal**, dan **Terbit**, dikelompokkan per hari, dengan pencarian caption dan filter jenis. Klik post untuk detailnya (media, caption per bagian chain, performa, alasan gagal) beserta **Coba lagi** dan **Hapus**.
- **Analitik**: Berita dan Affiliate berdampingan untuk 7, 30, atau 90 hari, untuk semua channel, satu platform, atau satu akun; post terbit per hari; post teratas dan terendah.
- **Akun & rute**: kartu tiap akun dengan masa berlaku token, switch **Berita** dan **Affiliate** untuk post dari Hermes yang masuk otomatis, dan switch **Akun aktif**; lalu ringkasan alur otomatis per jenis, grup, dan tombol hubungkan. Akun lama menerima kedua jenis; akun baru juga, sampai diubah.

**Grup akun.** Di **Akun & rute**, klik **Grup baru** dan beri nama, lalu atur jenis post (Berita, Affiliate, atau semua jenis), cara membagi, dan anggotanya. Satu akun boleh masuk banyak grup.

- **Bersamaan** (`same`): anggota grup memposting tiap item jenis itu bersama-sama, dengan caption, berita, atau produk yang sama.
- **Bergantian** (`split`): tiap item jenis itu hanya diposting satu anggota grup, yaitu yang antreannya paling cepat kosong. Jadi anggotanya memposting berita atau produk berbeda, dan berita yang sudah pernah diposting salah satu anggota tidak diposting anggota lain.

Semua grup berlaku sekaligus. Contoh dengan akun Threads 247, IG 247, FB Usaha Jaya, dan FB Media Internet:

| Grup | Anggota | Jenis | Cara membagi |
|---|---|---|---|
| A | Threads 247, FB Usaha Jaya | Affiliate | Bergantian |
| B | Threads 247, IG 247 | Berita | Bersamaan |
| C | Threads 247, FB Media Internet | Berita | Bergantian |

Hasilnya, tiap berita terbit di Threads + IG (grup B), atau di FB Media Internet (grup C), bergantian. Tiap produk terbit di Threads atau FB Usaha Jaya (grup A). Pembagian mengikuti antrean yang paling cepat kosong, jadi tidak selalu persis selang-seling: akun yang antreannya sudah panjang mendapat lebih sedikit.

Anggota yang tidak menerima jenis itu (switch Berita/Affiliate di kartu akunnya) dilewati. Akun yang tidak ada di grup mana pun untuk jenis itu menerima semua item jenis itu, seperti sebelumnya. Menghapus grup tidak menghapus akunnya.

**Buat post** di bar atas (di ponsel, tombol + di bar bawah) membuka composer: pilih channel, atau satu grup sekaligus lewat **Pilih cepat**, lalu jenis, caption, dan URL media. Panel kanan menampilkan pratinjau di tiap platform yang dipilih, termasuk pembagian chain Threads. **Tambah ke antrean** menaruhnya di antrean tiap channel; **Atur waktu** menjadwalkannya di jam tertentu (WIB); **Terbitkan sekarang** langsung terbit ke satu channel. Drafnya tersimpan di browser walau composer ditutup atau halaman dimuat ulang.

Buka dashboard lewat domain yang sama dengan `PUBLIC_APP_URL` / `THREADS_REDIRECT_URI`, bukan `localhost` atau IP. Callback hanya menerima akun kalau cookie login dan cookie `state` OAuth ikut kembali, dan cookie itu terikat ke domain. Kalau penukaran ke token 60 hari gagal, akun tidak disimpan.

## API

Semua endpoint butuh `Authorization: Bearer $API_KEY` atau cookie sesi.

Antrekan artikel dari scraper:

```bash
curl -X POST https://domain.com/api/posts \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"caption":"...","imageUrl":"https://...","sourceUrl":"https://...","kind":"news"}]}'
```

Item tanpa `accountId` masuk ke akun aktif yang menerima jenisnya (switch Berita/Affiliate di kartu akun), sesuai grup jenis itu (lihat **Grup akun** di atas), masing-masing di antrean akunnya sendiri. Item yang tidak cocok dengan akun mana pun dilewati dan nomornya ada di `no_target`. Item dengan `accountId` hanya masuk ke akun itu, tanpa melihat grup. `captions` opsional mengganti caption untuk platform tertentu, misalnya `"captions":{"instagram":"versi pendek…","facebook":"…"}`; platform tanpa versi sendiri memakai `caption` dan dipotong otomatis.

`kind` wajib di setiap item: `news` (berita, sertakan `sourceUrl` artikelnya) atau `affiliate`, persis huruf kecil. Item tanpa `kind` atau dengan nilai lain menolak seluruh batch (HTTP 400, `items_with_invalid_kind` menyebut nomor itemnya), dan tidak ada yang masuk antrean. `sourceUrl` berita yang sama tidak akan diantrekan dua kali ke akun yang sama (`skipped_duplicates`); affiliate boleh berulang. Tiap item butuh tepat satu `imageUrl` atau `videoUrl` (HTTPS publik). `scheduledAt` opsional (ISO, boleh dengan offset seperti `+07:00`; tanpa zona dianggap UTC). Satu item yang tidak valid menolak seluruh batch.

Publish langsung ke satu akun, platform apa pun:

```bash
curl -X POST https://domain.com/api/publish \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"text":"...","imageUrl":"https://...","kind":"news","accountId":3}'
```

`kind` juga wajib di sini, dengan nilai yang sama. `accountId` boleh dihilangkan kalau hanya ada satu akun aktif. `/api/publish/threads` tetap jalan seperti dulu, khusus akun Threads.

Insight performa (untuk dashboard dan crew):

```bash
curl "https://domain.com/api/insights?days=7&kind=news&platform=instagram" -H "Authorization: Bearer $API_KEY"
```

`days` 1–90 (default 7), `kind`, `platform` (`threads`, `instagram`, `facebook`), dan `account` (id akun) opsional. Tanpa `platform`, angka semua platform dijumlahkan; views tiap platform dihitung berbeda, jadi bandingkan per platform. Hasilnya per jenis: `posts`, `covered` (post yang sudah terbaca), `errors` (post yang pembacaan terakhirnya gagal), `gone` (post yang sudah dihapus di Threads; tidak dibaca lagi dan tidak ikut di angka lain), total `views`/`likes`/`replies`/`reposts`/`quotes`/`shares`, `avg_views`, `avg_likes`, dan `engagement_rate` = (likes + replies + reposts + quotes + shares) / views. Ditambah `top` dan `bottom` (5 post, caption 120 karakter; `bottom` melewati post yang belum berumur sehari), serta `top_by_kind` dan `bottom_by_kind` per jenis. Angka diambil worker tick, 20 post per tick: post yang belum pernah terbaca lebih dulu (terbaru dulu, termasuk riwayat lama), lalu dibaca ulang tiap 3 jam di hari pertamanya dan tiap 12 jam sampai berumur seminggu. Pembacaan yang gagal dicoba lagi tiap jam sampai post berumur 30 hari. Kalau server tidak tersambung ke Threads, batch berhenti tanpa menandai post gagal dan dicoba lagi di tick berikutnya. Setelah akun dihubungkan ulang, riwayat lama butuh beberapa jam sampai terbaca semua; selama itu angka 30 hari masih didominasi post terbaru. Untuk chain, yang dibaca post akarnya; balasan tidak dijumlahkan Threads.

Aktivitas harian dan antrean tiap akun (untuk Beranda dan grafik dashboard):

```bash
curl "https://domain.com/api/activity?days=14" -H "Authorization: Bearer $API_KEY"
```

`days` 1–90 (default 14); `platform` dan `account` opsional mempersempit `days` seperti di insight. `days[]` berisi tiap hari kalender WIB, hari ini terakhir, termasuk hari kosong: post terbit per jenis (`news`, `affiliate`) dan `failed`. `accounts[]` selalu semua akun: `queued`, `failed`, `next_at` dan `queue_ends_at` (slot antrean pertama dan terakhir), `published_at` (terbit terakhir), dan `published_24h`.

Daftar post untuk dashboard: `GET /api/posts?view=queue|failed|history`, dengan `kind`, `account`, `q` (teks di caption), `page`, dan `limit` (maksimal 100) opsional.

Daftar akun dan routing-nya (hanya baca; mengubahnya tetap dari dashboard):

```bash
curl https://domain.com/api/accounts -H "Authorization: Bearer $API_KEY"
```

Hasilnya `accounts[]` (`id`, `platform`, `username`, `enabled`, `auto_news`, `auto_affiliate`, `token_expires_at`, `token_invalid_at`; token tidak pernah ikut), `groups[]` (`id`, `name`, `kind`: `news`, `affiliate` atau `all`, `mode`: `same` atau `split`, `account_ids`), dan `platforms[]` (platform yang bisa dihubungkan beserta env yang masih kurang). `token_invalid_at` terisi berarti antrean akun itu dijeda. Grup hanya bisa diubah dari dashboard.

Hapus post:

```bash
curl -X DELETE https://domain.com/api/posts/123 -H "Authorization: Bearer $API_KEY"
```

Post yang sudah terbit dihapus di platformnya lebih dulu (Threads: semua bagian chain; Facebook: post Page), dan catatannya baru dihapus kalau itu berhasil. Kalau platform menolak, catatan tetap ada dan alasannya di `error` (HTTP 502). Instagram tidak bisa menghapus lewat API: hanya catatannya yang hilang (`manual: true`), hapus post-nya manual di aplikasi Instagram. Post yang sudah ditandai dihapus di platformnya cukup dihapus catatannya. Post di antrean atau yang gagal hanya dihapus catatannya, ditambah bagian chain Threads yang sempat tayang (`still_live` menyebut yang gagal dihapus). Di dashboard, **Hapus** ada di tiap post halaman **Konten**: ikon tempat sampah di barisnya, atau di panel detail post.

Tick manual (hasilnya `results`, satu entri per post yang dikirim):

```bash
curl -X POST https://domain.com/api/worker/tick -H "Authorization: Bearer $API_KEY"
```

Health check (tanpa auth):

```bash
curl https://domain.com/api/health
```

## Test

```bash
npm test            # ~180 assertions: crypto, DB, migrasi, routing per akun, klaim per akun, refresh token, jeda token, insight, dedup, paginasi, retry, queue tail, pemotongan teks per platform, konversi gambar, adapter Instagram/Facebook (fetch di-stub), R2 signing
npm run typecheck   # tsc --noEmit
npm run build       # production build
```

Smoke test terhadap server yang sedang jalan (memverifikasi auth, OAuth state, validasi antrean, rate limit login):

```bash
sh scripts/setup-test-env.sh   # generate secret lokal
npm run dev -- --port 7949 &
sh scripts/smoke.sh            # 32 pemeriksaan HTTP; SP_TMP=<dir> untuk ganti /tmp
```

`setup-test-env.sh` menimpa `ENCRYPTION_KEY` di `.env.local`, jadi token akun yang tersimpan tidak bisa dibaca lagi. Di mesin yang sudah punya akun terhubung, berikan secret uji dan `DATABASE_PATH` sementara lewat environment variable saja; nilai itu menang atas `.env.local`.

Catatan: `Dockerfile` dan `docker-compose.yml` belum pernah dieksekusi di mesin build ini (daemon Docker tidak tersedia). Build Next standalone sudah terverifikasi; jalankan `docker build` sekali di server sebelum mengandalkannya.

## Catatan operasional

- `imageUrl` harus URL publik HTTPS. Path lokal ditolak Threads. Gambar disalin ke R2 sebelum dikirim (lihat langkah 3).
- Error kode 1/2 dari Threads saat membuat container dicoba ulang dua kali (jeda 5 dan 15 detik). Error Threads menyertakan `fbtrace_id` untuk dilaporkan ke Meta.
- Batas teks Threads 500 karakter per post; sisanya jadi balasan.
- Kalau platform menolak token (Meta kode 190, misalnya izin dicabut atau password akun diganti), antrean akun itu dijeda: post tidak dihabiskan percobaannya, dashboard menampilkan banner merah, dan antrean jalan lagi begitu akun dihubungkan ulang. Akun lain tidak ikut berhenti.
- Token Threads dan Instagram kedaluwarsa 60 hari. Worker tick memperpanjangnya otomatis begitu sisa masa berlakunya di bawah 53 hari. Kalau gagal, feed crew menampilkan `Token @… gagal diperpanjang` dan dicoba lagi 12 jam kemudian. Dashboard tetap menampilkan tanggal kedaluwarsa; connect ulang kalau perpanjangan terus gagal.
- Backup: cukup salin file di volume `/app/data`.

## Belum diuji ke API sungguhan

Adapter Instagram dan Facebook ditulis dari dokumentasi resmi (Oktober 2026) dan diuji dengan fetch tiruan; belum pernah terbit ke akun sungguhan. Saat menghubungkan akun pertama tiap platform, terbitkan satu post lewat **Terbitkan sekarang** dulu dan cek feed crew. Yang paling mungkin perlu disesuaikan: insight video Facebook (`video_insights` `total_video_views`).
