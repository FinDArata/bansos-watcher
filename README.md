# Bansos Watcher

Notifikasi otomatis ke Discord channel ketika daftar bansos di [bansos.dev](https://bansos.dev/list/) bertambah atau berkurang.

Jalan setiap 30 menit via GitHub Actions (cloud, tidak perlu PC nyala).

## Cara kerja

1. GitHub Actions menjalankan scripts/check-bansos.mjs setiap 30 menit.
2. Script fetch HTML bansos.dev/list/, parse kartu bansos (berdasarkan slug dari URL /list/<slug>/).
3. Bandingkan himpunan slug dengan state.json (commit sebelumnya).
4. Jika ada slug baru atau hilang, kirim embed Discord ke webhook dan update state.json.
5. state.json di-commit balik ke repo.

## Setup

### 1. Set Discord webhook secret

1. Buka repo di GitHub.
2. Pergi ke Settings Secrets and variables Actions New repository secret.
3. Name: DISCORD_WEBHOOK_URL
4. Value: paste webhook URL channel #bansos-alert kamu.

### 2. Push ke GitHub

`
git init
git add .
git commit -m feat: initial bansos watcher
git branch -M main
git remote add origin https://github.com/FinDArata/bansos-watcher.git
git push -u origin main
`

### 3. Trigger run pertama

1. Buka tab Actions di repo.
2. Pilih workflow Bansos Watcher.
3. Klik Run workflow.
4. Cek channel Discord #bansos-alert, harusnya muncul embed pertama dengan daftar lengkap bansos yang ada saat ini.

## File

- .github/workflows/bansos-watcher.yml schedule + manual trigger.
- scripts/check-bansos.mjs fetch, parse, diff, kirim Discord.
- state.json himpunan slug yang sudah pernah dilihat.
- .gitignore exclude noise.

## Ubah interval

Edit .github/workflows/bansos-watcher.yml, field cron:

- */15 * * * *  15 menit
- 0 */2 * * *   2 jam (08:00, 10:00, dst)
- 0 8,12,16,20 * * *  4x sehari

## Verifikasi lokal

DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/... node scripts/check-bansos.mjs

