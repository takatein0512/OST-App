#!/bin/bash
# ダブルクリックで起動。ターミナルを閉じると止まります。
cd "$(dirname "$0")" || exit 1

# 文字起こし用の Ollama が動いていなければ先に起動する
if ! curl -s http://localhost:11434/api/version >/dev/null 2>&1; then
  echo "Ollama を起動しています..."
  ollama serve >/dev/null 2>&1 &
  sleep 3
fi

open "http://localhost:5173/"
node server.js
