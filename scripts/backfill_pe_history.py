#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
台股本益比歷史一次性回填工具（非每日排程的一部分）

證交所「市場交易月報」的月報表檔（.../02/001/{YYYYMM}_C02001.zip）每份只附
「近 3 個年度＋當月」4 欄快照，沒有單一端點能一次取得完整歷史序列，因此完整
歷史用這支腳本逐月下載回填一次，寫入 data/dashboard.json 的 pe_history 欄位；
之後 scripts/fetch_data.py 每次執行只需再補抓「最新一個月」疊加上去即可，不必
每天重覆下載解析兩百多個月的歷史檔案。

執行方式（通常不需要重跑，除非要重建歷史或往更早年份延伸）：
    python scripts/backfill_pe_history.py [起始年月 YYYYMM，預設 200701]

下載約兩百多個月的檔案，逐月請求並帶退避重試以避免觸發證交所的速率限制，
整個過程約需數分鐘。完成後會直接把結果寫回 data/dashboard.json。
"""
import io
import json
import os
import sys
import time
import zipfile
from datetime import date, datetime, timezone

import requests
import xlrd

UA = {"User-Agent": "Mozilla/5.0 (compatible; tw-macro-dashboard-backfill/1.0)"}
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_PATH = os.path.join(ROOT, "data", "dashboard.json")


def log(msg):
    print(f"[backfill] {msg}", file=sys.stderr, flush=True)


def fetch_month_pe(ym):
    url = f"https://www.twse.com.tw/staticFiles/inspection/inspection/02/001/{ym}_C02001.zip"
    r = requests.get(url, headers=UA, timeout=20)
    if r.status_code in (428, 429):
        raise RuntimeError(f"rate limited: HTTP {r.status_code}")
    if r.status_code != 200 or not r.content.startswith(b"PK"):
        return None
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    names = [n for n in zf.namelist() if n.lower().endswith((".xls", ".xlsx"))]
    if not names:
        return None
    wb = xlrd.open_workbook(file_contents=zf.read(names[0]))
    sheet = next((s for s in wb.sheets() if "本益比" in s.name), None)
    if sheet is None:
        return None
    for r_idx in range(sheet.nrows):
        row = sheet.row_values(r_idx)
        # 用 startswith 而非 in 比對，避免命中同一工作表標題列裡也含「本益比」字樣
        if row and str(row[0]).strip().startswith("本益比") and len(row) > 1:
            val = row[-1]
            return round(val, 2) if isinstance(val, (int, float)) and val > 0 else None
    return None


def month_range(start_ym, end_ym):
    y, m = int(start_ym[:4]), int(start_ym[4:])
    ey, em = int(end_ym[:4]), int(end_ym[4:])
    out = []
    while (y, m) <= (ey, em):
        out.append(f"{y}{m:02d}")
        m += 1
        if m > 12:
            m = 1
            y += 1
    return out


def main():
    start_ym = sys.argv[1] if len(sys.argv) > 1 else "200701"
    today = date.today()
    end_ym = f"{today.year}{today.month:02d}"
    months = month_range(start_ym, end_ym)
    log(f"backfilling {len(months)} months: {months[0]}..{months[-1]}")

    existing = {}
    if os.path.exists(DATA_PATH):
        with open(DATA_PATH, encoding="utf-8") as f:
            existing = json.load(f)
    pe_history = {r["period"]: r["pe_ratio"] for r in existing.get("pe_history", [])}

    for ym in months:
        val = None
        for attempt in range(5):
            try:
                val = fetch_month_pe(ym)
                break
            except Exception as e:
                backoff = 8 * (attempt + 1)
                log(f"  {ym} attempt {attempt + 1} failed ({e}), backing off {backoff}s")
                time.sleep(backoff)
        period = f"{ym[:4]}-{ym[4:]}"
        if val is not None:
            pe_history[period] = val
            log(f"  {period} -> {val}")
        else:
            log(f"  {period} -> no data")
        time.sleep(1.0)  # 避免觸發證交所的速率限制

    existing["pe_history"] = [{"period": p, "pe_ratio": v} for p, v in sorted(pe_history.items())]
    existing.setdefault("meta", {})["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    os.makedirs(os.path.dirname(DATA_PATH), exist_ok=True)
    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(existing, f, ensure_ascii=False, indent=2)
    log(f"wrote {len(existing['pe_history'])} pe_history points into {DATA_PATH}")


if __name__ == "__main__":
    main()
