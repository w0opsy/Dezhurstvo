ДЕЖУРСТВО — СЕРВЕРНАЯ ВЕРСИЯ (аккаунты по паролю + общий рейтинг)

Что внутри
  server.js        — сервер на Node.js без внешних библиотек
  install.sh       — установка одной командой (Node.js, HTTPS, автозапуск, бот)
  bot.js           — Telegram-бот (запускается сам, если задан BOT_TOKEN)
  public/          — сама игра (index.html), иконка и манифест для «На экран Домой»
  data/db.json     — появится после запуска: аккаунты (пароли хешированы) и прогресс. Его нужно бэкапить.

Проверить у себя на компьютере
  1. Установите Node.js 18+ с nodejs.org
  2. В папке сервера: node server.js
  3. Откройте http://localhost:8080 — с телефона в той же Wi-Fi: http://IP-компьютера:8080

БЫСТРАЯ УСТАНОВКА С TELEGRAM-БОТОМ: sudo bash install.sh ТОКЕН_БОТА  — подробно в TELEGRAM.txt.
Ниже — ручная установка без скрипта.

ВЫЛОЖИТЬ В ИНТЕРНЕТ (VPS, ~200–400 ₽/мес: Timeweb Cloud, Selectel, REG.RU, Beget)
  1. Купите VPS с Ubuntu 22.04/24.04 (1 ядро, 1 ГБ RAM хватит с запасом).
     Желательно домен (~200 ₽/год) и A-запись на IP сервера — для HTTPS.
  2. Подключитесь:          ssh root@IP_СЕРВЕРА
  3. Установите Node.js:    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
                            apt install -y nodejs
  4. Загрузите папку (с вашего компьютера; на Windows можно WinSCP):
                            scp -r dezhurstvo-server root@IP_СЕРВЕРА:/opt/
  5. Автозапуск — создайте файл /etc/systemd/system/dezhurstvo.service:

        [Unit]
        Description=Dezhurstvo
        After=network.target
        [Service]
        WorkingDirectory=/opt/dezhurstvo-server
        ExecStart=/usr/bin/node server.js
        Environment=PORT=8080
        # для Telegram-бота (см. TELEGRAM.txt), иначе удалите эти две строки:
        Environment=BOT_TOKEN=токен_от_BotFather
        Environment=WEBAPP_URL=https://игра.вашдомен.ru/
        Restart=always
        [Install]
        WantedBy=multi-user.target

     затем:                 systemctl enable --now dezhurstvo
  6. HTTPS через Caddy (сертификат получит сам):
                            apt install -y caddy
     в файле /etc/caddy/Caddyfile оставьте:
        игра.вашдомен.ru {
            reverse_proxy localhost:8080
        }
                            systemctl reload caddy
     Без домена игра будет доступна по http://IP_СЕРВЕРА:8080 (откройте порт: ufw allow 8080),
     но «Установить на экран» на iPhone и звук работают надёжнее по HTTPS.
  7. Друзьям — ссылка. На телефоне: Поделиться → «На экран Домой» — откроется как приложение.

Обновление игры: замените public/index.html новым файлом — перезапуск не нужен.
Бэкап: копируйте data/db.json (например, раз в день через cron).
