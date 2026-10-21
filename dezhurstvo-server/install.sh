#!/usr/bin/env bash
# Установка «Дежурства» с Telegram-ботом и рейтингом на чистый VPS (Ubuntu 22.04/24.04).
# Запуск из папки сервера:   sudo bash install.sh ТОКЕН_БОТА [свой_домен|-] [адрес_игры_на_GitHub_Pages]
#   Игра на GitHub Pages, рейтинг здесь:   bash install.sh ТОКЕН - https://ник.github.io/Репозиторий/
# Без домена адрес будет вида https://1-2-3-4.sslip.io — HTTPS-сертификат Caddy получит сам.
set -e
TOKEN="$1"; DOMAIN="$2"; GAME="$3"; [ "$DOMAIN" = "-" ] && DOMAIN=""
if [ -z "$TOKEN" ]; then echo "Использование: sudo bash install.sh ТОКЕН_БОТА [домен]"; exit 1; fi
if [ "$(id -u)" != "0" ]; then echo "Нужны права root: sudo bash install.sh ..."; exit 1; fi
DIR="$(cd "$(dirname "$0")" && pwd)"
export DEBIAN_FRONTEND=noninteractive

echo "== 1/5 Адрес сервера"
IP="$(curl -4 -fsS --max-time 8 https://api.ipify.org || curl -4 -fsS --max-time 8 https://ifconfig.me || hostname -I | awk '{print $1}')"
[ -z "$DOMAIN" ] && DOMAIN="$(echo "$IP" | tr . -).sslip.io"
URL="https://$DOMAIN/"
echo "   IP $IP → $URL"

echo "== 2/5 Node.js"
NODEV=$(node -v 2>/dev/null | tr -d v | cut -d. -f1 || echo 0)
if [ "${NODEV:-0}" -lt 18 ]; then
  apt-get update -qq
  (curl -fsSL --max-time 30 https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y -qq nodejs) || apt-get install -y -qq nodejs
fi
NODEV=$(node -v 2>/dev/null | tr -d v | cut -d. -f1 || echo 0)
if [ "${NODEV:-0}" -lt 18 ]; then echo "Не удалось поставить Node.js 18+ — установите вручную и запустите скрипт снова."; exit 1; fi
echo "   $(node -v)"

echo "== 3/5 Caddy (HTTPS)"
if ! command -v caddy >/dev/null; then
  apt-get install -y -qq caddy 2>/dev/null || {
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy; }
fi
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
    encode gzip
    reverse_proxy localhost:8080
}
CADDY
systemctl enable -q caddy; systemctl restart caddy

echo "== 4/5 Сервис игры и бота"
umask 077
cat > /etc/dezhurstvo.env <<ENV
PORT=8080
BOT_TOKEN=$TOKEN
PUBLIC_URL=$URL
GAME_URL=$GAME
ENV
umask 022
cat > /etc/systemd/system/dezhurstvo.service <<UNIT
[Unit]
Description=Dezhurstvo game + Telegram bot
After=network-online.target
[Service]
WorkingDirectory=$DIR
EnvironmentFile=/etc/dezhurstvo.env
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload; systemctl enable -q dezhurstvo; systemctl restart dezhurstvo

echo "== 5/5 Порты"
if command -v ufw >/dev/null && ufw status | grep -q active; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow OpenSSH >/dev/null; fi

sleep 4
echo
journalctl -u dezhurstvo -n 5 --no-pager | sed 's/^/   /'
echo
if [ -n "$GAME" ]; then echo "Готово. Сервер рейтинга: $URL   Кнопка «Играть»: $GAME?api=$URL"; else echo "Готово. Игра: $URL"; fi
echo "Откройте бота в Telegram и отправьте /start — кнопка «Играть» уже ведёт на этот адрес."
echo "Вход через Telegram в обычном браузере: @BotFather → /setdomain → ваш бот → $DOMAIN"
echo "Если сертификат ещё не выдан, подождите минуту: journalctl -u caddy -n 20"
echo "Бэкап рейтинга и прогресса: $DIR/data/db.json"
