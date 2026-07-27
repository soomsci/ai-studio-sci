#!/bin/bash
# 더블클릭하면 수집기가 켜지고 브라우저가 열립니다.
cd "$(dirname "$0")"
# 이미 켜져 있으면(5050 사용 중) 새로 켜지 않고 브라우저만 엽니다.
if lsof -ti:5050 >/dev/null 2>&1; then
  echo "수집기가 이미 켜져 있어요. 브라우저를 엽니다."
else
  echo "수집기를 켜는 중… (이 창은 닫지 마세요. 닫으면 수집기가 꺼집니다)"
  python3 main.py &
  sleep 3
fi
open "http://127.0.0.1:5050"
echo ""
echo "측정을 마치면 이 창에서 Ctrl+C 를 누르거나 창을 닫으면 수집기가 꺼집니다."
wait
