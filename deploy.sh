#!/bin/bash
set -e

echo "=== 1. Entering project directory ==="
cd /home/myhsu/Devel/qigong-line-bot

echo "=== 2. Pulling latest code from GitHub ==="
git fetch origin main
git reset --hard origin/main

echo "=== 3. Installing dependencies & building TypeScript ==="
npm install
npm run build

echo "=== 4. Reloading PM2 process ==="
pm2 restart qigong-line-bot || pm2 restart all
pm2 save

echo "=== Deploy to ubuntu1 successfully completed! ==="
