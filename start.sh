#!/bin/bash
echo "===================================================="
echo "          CASER.ONE CLONE - LOCAL LAUNCHER"
echo "===================================================="
echo ""

if ! command -v node &> /dev/null; then
    echo "[!] Node.js not found! Please install Node.js: https://nodejs.org"
    exit 1
fi

if [ ! -d "node_modules" ]; then
    echo "[*] Installing dependencies (first run only)..."
    npm install
fi

echo ""
echo "[*] Starting Caser server on http://localhost:3000 ..."
echo "[*] Open your browser and go to: http://localhost:3000/ru/cases"
echo ""

if which xdg-open > /dev/null; then
  xdg-open http://localhost:3000/ru/cases &
elif which open > /dev/null; then
  open http://localhost:3000/ru/cases &
fi

node server.js
