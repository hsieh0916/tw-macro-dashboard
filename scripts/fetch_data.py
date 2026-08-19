#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
台灣總經儀表板 - 資料擷取腳本

從官方公開資料來源擷取以下時間序列，彙整為單一 data/dashboard.json 供前端網頁讀取：
  - GDP 經濟成長率（年增率，季資料）           行政院主計總處
  - 景氣對策信號 / 領先・同時・落後指標          國家發展委員會
  - 製造業 PMI / 非製造業 NMI                   國發會（中經院調查）
  - PMI 未來六個月展望指數（最佳努力擷取）        中華經濟研究院新聞稿
  - 貨幣總計數 M1A / M1B / M2 年增率            中央銀行
  - 台股加權指數、外資買賣超、美元兌台幣匯率      FinMind 公開 API

設計原則：任何單一來源擷取失敗都不應讓整個流程中斷；失敗時沿用上次寫入的舊資料，
並把警告訊息記錄在 meta.warnings，方便從網頁或 Actions log 察覺問題。

執行方式：
    python scripts/fetch_data.py
由 .github/workflows/update-data.yml 排程自動執行。
"""
import csv
import io
import json
import os
import re
import sys
import tempfile
import zipfile
from datetime import datetime, timezone

import certifi
import requests

UA = {"User-Agent": "Mozilla/5.0 (compatible; tw-macro-dashboard/1.0; +https://github.com)"}
TIMEOUT = 30
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_PATH = os.path.join(ROOT, "data", "dashboard.json")
EXTRA_CERTS_DIR = os.path.join(ROOT, "scripts", "certs")

FINMIND_URL = "https://api.finmindtrade.com/api/v4/data"
CIER_LIST_URL = "https://www.cier.edu.tw/focus-ch/"


def log(msg):
    print(f"[fetch] {msg}", file=sys.stderr, flush=True)


_CA_BUNDLE_CACHE = None


def ca_bundle():
    """某些 .gov.tw 站台（例如 ws.dgbas.gov.tw，其憑證由 TWCA Secure SSL
    Certification Authority 簽發）伺服器端未附上完整的中繼憑證，導致
    certifi 預設信任清單在 Linux/CI 環境下 TLS 驗證失敗——瀏覽器與 Windows
    通常會自動補上缺漏的中繼憑證（AIA chasing），因此本機不易察覺此問題。
    這裡把 scripts/certs/ 內手動蒐集、來自憑證機關官方網站的中繼／根憑證
    疊加到 certifi 的信任清單上，補齊該站的憑證鏈，而非關閉憑證驗證。"""
    global _CA_BUNDLE_CACHE
    if _CA_BUNDLE_CACHE and os.path.exists(_CA_BUNDLE_CACHE):
        return _CA_BUNDLE_CACHE
    combined = os.path.join(tempfile.gettempdir(), "tw-macro-ca-bundle.pem")
    with open(combined, "wb") as out, open(certifi.where(), "rb") as base:
        out.write(base.read())
        if os.path.isdir(EXTRA_CERTS_DIR):
            for name in sorted(os.listdir(EXTRA_CERTS_DIR)):
                if name.endswith(".pem"):
                    out.write(b"\n")
                    out.write(open(os.path.join(EXTRA_CERTS_DIR, name), "rb").read())
    _CA_BUNDLE_CACHE = combined
    return combined


def safe_get(url, **kw):
    kw.setdefault("verify", ca_bundle())
    r = requests.get(url, headers=UA, timeout=TIMEOUT, **kw)
    r.raise_for_status()
    return r


def resolve_datagovtw_url(dataset_id):
    """回傳 data.gov.tw 資料集目前實際的下載網址（動態解析，避免硬編碼過期連結）。"""
    r = safe_get(f"https://data.gov.tw/api/v2/rest/dataset/{dataset_id}")
    dist = r.json()["result"]["distribution"]
    for d in dist:
        if str(d.get("resourceFormat", "")).upper() == "CSV" and d.get("resourceDownloadUrl"):
            return d["resourceDownloadUrl"]
    return dist[0]["resourceDownloadUrl"]


def _num(s):
    if s is None:
        return None
    s = s.strip()
    if s in ("", "-", "NA", "N/A"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# 景氣對策信號 + 領先/同時/落後指標  (國發會，data.gov.tw dataset 6099)
# ---------------------------------------------------------------------------
def fetch_business_signal():
    log("fetching NDC 景氣指標及燈號 (dataset 6099)")
    url = resolve_datagovtw_url(6099)
    raw = safe_get(url).content

    if raw[:2] == b"PK":  # ZIP bundle
        zf = zipfile.ZipFile(io.BytesIO(raw))
        member = next(n for n in zf.namelist() if "景氣指標與燈號" in n and not n.startswith("schema"))
        text = zf.read(member).decode("utf-8-sig")
    else:
        text = raw.decode("utf-8-sig")

    rows = list(csv.reader(io.StringIO(text)))
    out = []
    for row in rows[1:]:
        if not row or not row[0].strip():
            continue
        date = row[0].strip()
        if not re.match(r"^\d{6}$", date):
            continue
        period = f"{date[:4]}-{date[4:]}"
        vals = [_num(x) for x in row[1:9]]
        while len(vals) < 8:
            vals.append(None)
        out.append({
            "period": period,
            "leading_index": vals[0],
            "leading_index_notrend": vals[1],
            "coincident_index": vals[2],
            "coincident_index_notrend": vals[3],
            "lagging_index": vals[4],
            "lagging_index_notrend": vals[5],
            "score": vals[6],
            "light": row[8].strip() if len(row) > 8 else None,
        })
    out.sort(key=lambda x: x["period"])
    log(f"  -> {len(out)} monthly points, latest {out[-1] if out else None}")
    return out


# ---------------------------------------------------------------------------
# PMI / NMI  (國發會，data.gov.tw dataset 6100)
# ---------------------------------------------------------------------------
def fetch_pmi():
    log("fetching NDC PMI/NMI (dataset 6100)")
    url = resolve_datagovtw_url(6100)
    text = safe_get(url).content.decode("utf-8-sig")
    rows = list(csv.reader(io.StringIO(text)))
    out = []
    for row in rows[1:]:
        if not row or not row[0].strip():
            continue
        date = row[0].strip()
        if not re.match(r"^\d{6}$", date):
            continue
        period = f"{date[:4]}-{date[4:]}"
        out.append({
            "period": period,
            "pmi": _num(row[1]) if len(row) > 1 else None,
            "nmi": _num(row[2]) if len(row) > 2 else None,
        })
    out.sort(key=lambda x: x["period"])
    log(f"  -> {len(out)} monthly points, latest {out[-1] if out else None}")
    return out


# ---------------------------------------------------------------------------
# GDP 經濟成長率（年增率，季資料）  (主計總處 DGBAS)
# ---------------------------------------------------------------------------
def fetch_gdp():
    log("fetching DGBAS quarterly GDP growth rate (na8101a1q.xml)")
    url = "https://ws.dgbas.gov.tw/001/Upload/461/relfile/11525/230514/na8101a1q.xml"
    text = safe_get(url).content.decode("utf-8")
    blocks = re.findall(r"<Obs>.*?</Obs>", text, re.S)
    out = []
    for b in blocks:
        item = re.search(r"<Item>([^<]*)</Item>", b)
        period = re.search(r"<TIME_PERIOD>([^<]*)</TIME_PERIOD>", b)
        freq = re.search(r"<FREQ>([^<]*)</FREQ>", b)
        typ = re.search(r"<TYPE>([^<]*)</TYPE>", b)
        value = re.search(r"<Item_VALUE>([^<]*)</Item_VALUE>", b)
        if not (item and period and freq and typ and value):
            continue
        if item.group(1) != "經濟成長率(%)" or freq.group(1) != "Q" or typ.group(1) != "原始值":
            continue
        v = _num(value.group(1))
        if v is None:
            continue
        m = re.match(r"^(\d{4})Q(\d)$", period.group(1))
        if not m:
            continue
        out.append({"period": f"{m.group(1)}-Q{m.group(2)}", "yoy_pct": round(v, 2)})
    out.sort(key=lambda x: x["period"])
    log(f"  -> {len(out)} quarterly points, latest {out[-1] if out else None}")
    return out


# ---------------------------------------------------------------------------
# 貨幣總計數 M1A / M1B / M2 年增率  (中央銀行)
# ---------------------------------------------------------------------------
def fetch_money_supply():
    log("fetching CBC M1B/M2 monthly (EF17M01.csv)")
    url = "https://www.cbc.gov.tw/public/data/OpenData/%E7%B6%93%E7%A0%94%E8%99%95/EF17M01.csv"
    text = safe_get(url).content.decode("utf-8-sig")
    rows = list(csv.reader(io.StringIO(text)))
    out = []
    for row in rows[1:]:
        if not row or not row[0].strip():
            continue
        m = re.match(r"^(\d{4})M(\d{2})$", row[0].strip())
        if not m:
            continue
        period = f"{m.group(1)}-{m.group(2)}"

        def col(i):
            return _num(row[i]) if len(row) > i else None

        m1a_yoy, m1b_yoy, m2_yoy = col(26), col(28), col(30)
        out.append({
            "period": period,
            "m1a_yoy": round(m1a_yoy, 2) if m1a_yoy is not None else None,
            "m1b_yoy": round(m1b_yoy, 2) if m1b_yoy is not None else None,
            "m2_yoy": round(m2_yoy, 2) if m2_yoy is not None else None,
            "m1b_m2_gap": round(m1b_yoy - m2_yoy, 2) if (m1b_yoy is not None and m2_yoy is not None) else None,
        })
    out.sort(key=lambda x: x["period"])
    log(f"  -> {len(out)} monthly points, latest {out[-1] if out else None}")
    return out


# ---------------------------------------------------------------------------
# FinMind：TAIEX 加權指數 / 外資買賣超 / 美元兌台幣匯率
# ---------------------------------------------------------------------------
def finmind_get(dataset, data_id=None, start_date="2005-01-01"):
    params = {"dataset": dataset, "start_date": start_date}
    if data_id:
        params["data_id"] = data_id
    j = safe_get(FINMIND_URL, params=params).json()
    if j.get("status") != 200:
        raise RuntimeError(f"FinMind {dataset} error: {j.get('msg')}")
    return j.get("data", [])


def fetch_taiex():
    log("fetching TAIEX weighted index (FinMind TaiwanStockPrice)")
    rows = finmind_get("TaiwanStockPrice", data_id="TAIEX", start_date="2005-01-01")
    by_month = {}
    for row in rows:
        by_month[row["date"][:7]] = row["close"]  # 資料為升冪，後者覆蓋前者 = 當月最後一筆
    monthly = [{"period": k, "close": round(v, 1)} for k, v in sorted(by_month.items())]
    daily_recent = [{"date": r["date"], "close": r["close"]} for r in rows[-260:]]
    log(f"  -> {len(monthly)} monthly points, latest {monthly[-1] if monthly else None}")
    return {"monthly": monthly, "daily_recent": daily_recent}


def fetch_foreign_flow():
    log("fetching foreign investor net buy/sell (FinMind TaiwanStockTotalInstitutionalInvestors)")
    rows = finmind_get("TaiwanStockTotalInstitutionalInvestors", start_date="2012-01-01")
    by_month = {}
    for row in rows:
        if row.get("name") != "Foreign_Investor":
            continue
        period = row["date"][:7]
        by_month[period] = by_month.get(period, 0) + (row["buy"] - row["sell"])
    out = [{"period": k, "net_ntd_100m": round(v / 1e8, 1)} for k, v in sorted(by_month.items())]
    log(f"  -> {len(out)} monthly points, latest {out[-1] if out else None}")
    return out


def fetch_fx():
    log("fetching USD/TWD spot rate (FinMind TaiwanExchangeRate)")
    rows = finmind_get("TaiwanExchangeRate", data_id="USD", start_date="2005-01-01")
    by_month = {}
    for row in rows:
        spot_buy, spot_sell = row.get("spot_buy"), row.get("spot_sell")
        if spot_buy in (None, "-", 0) or spot_sell in (None, "-", 0):
            continue
        by_month[row["date"][:7]] = (spot_buy + spot_sell) / 2
    out = [{"period": k, "usdtwd": round(v, 3)} for k, v in sorted(by_month.items())]
    log(f"  -> {len(out)} monthly points, latest {out[-1] if out else None}")
    return out


# ---------------------------------------------------------------------------
# PMI 未來六個月展望指數 —— 最佳努力擷取（中經院新聞稿無結構化開放資料，
# 以正規表示式解析新聞稿內文；解析失敗時完全不影響其他資料，並沿用舊值）
# ---------------------------------------------------------------------------
def fetch_pmi_outlook(existing):
    log("attempting best-effort scrape of PMI six-month outlook index (CIER press releases)")
    try:
        html = safe_get(CIER_LIST_URL).text
    except Exception as e:
        log(f"  -> could not load CIER article list: {e}")
        return existing, f"擷取失敗（無法讀取列表頁）：{e}"

    links, seen = [], set()
    for href in re.findall(r'href="(https://www\.cier\.edu\.tw/focus-ch/\d+/)"', html):
        if href not in seen:
            seen.add(href)
            links.append(href)

    now = datetime.now(timezone.utc)
    for link in links[:25]:
        try:
            text = re.sub(r"<[^>]+>", " ", safe_get(link).text)
            text = re.sub(r"&nbsp;", " ", text)
            if "未來六個月展望指數" not in text or "製造業" not in text:
                continue
            mm = re.search(r"(\d{1,2})月.{0,25}?製造業", text)
            val = re.search(r"未來六個月展望指數.{0,20}?(?:至|為|達|來到)\s*([\d]{2}(?:\.\d)?)", text)
            if not (mm and val):
                continue
            month = int(mm.group(1))
            year = now.year if month <= now.month else now.year - 1
            period = f"{year}-{month:02d}"
            value = float(val.group(1))
            merged = {p["period"]: p["value"] for p in existing}
            merged[period] = value
            result = [{"period": k, "value": v} for k, v in sorted(merged.items())]
            log(f"  -> scraped {period} = {value} from {link}")
            return result, None
        except Exception:
            continue

    log("  -> no matching figure found in recent articles; keeping previous data")
    return existing, "本次未能自動擷取到最新一期數值，已沿用前次資料（來源網頁格式可能變動）"


# ---------------------------------------------------------------------------
def main():
    existing = {}
    if os.path.exists(DATA_PATH):
        try:
            with open(DATA_PATH, encoding="utf-8") as f:
                existing = json.load(f)
        except Exception as e:
            log(f"could not read existing {DATA_PATH}: {e}")

    result = dict(existing)
    warnings = []

    fetchers = [
        ("business_signal", fetch_business_signal),
        ("pmi", fetch_pmi),
        ("gdp", fetch_gdp),
        ("money_supply", fetch_money_supply),
        ("taiex", fetch_taiex),
        ("foreign_flow", fetch_foreign_flow),
        ("fx_usdtwd", fetch_fx),
    ]
    for key, fn in fetchers:
        try:
            result[key] = fn()
        except Exception as e:
            log(f"ERROR fetching {key}: {e}")
            warnings.append(f"{key} 擷取失敗，沿用舊資料：{e}")
            if key not in result:
                result[key] = {"monthly": [], "daily_recent": []} if key == "taiex" else []

    outlook, outlook_warning = fetch_pmi_outlook(existing.get("pmi_outlook", []))
    result["pmi_outlook"] = outlook
    if outlook_warning:
        warnings.append(f"pmi_outlook：{outlook_warning}")

    result["meta"] = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "warnings": warnings,
        "sources": {
            "gdp": {"name": "行政院主計總處—國民所得統計常用資料(季)", "url": "https://data.gov.tw/dataset/6799"},
            "business_signal": {"name": "國家發展委員會—景氣指標及燈號", "url": "https://data.gov.tw/dataset/6099"},
            "pmi": {"name": "國家發展委員會／中華經濟研究院—台灣採購經理人指數", "url": "https://data.gov.tw/dataset/6100"},
            "pmi_outlook": {"name": "中華經濟研究院—PMI新聞稿(未來六個月展望指數)", "url": "https://www.cier.edu.tw/focus-ch/"},
            "money_supply": {"name": "中央銀行—貨幣總計數", "url": "https://data.gov.tw/dataset/6024"},
            "taiex": {"name": "台灣證券交易所發行量加權股價指數（經 FinMind 開放API）", "url": "https://finmindtrade.com/"},
            "foreign_flow": {"name": "三大法人買賣金額統計—外資（經 FinMind 開放API）", "url": "https://finmindtrade.com/"},
            "fx_usdtwd": {"name": "銀行牌告美元／新台幣即期匯率（經 FinMind 開放API）", "url": "https://finmindtrade.com/"},
        },
    }

    os.makedirs(os.path.dirname(DATA_PATH), exist_ok=True)
    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    log(f"wrote {DATA_PATH}")
    if warnings:
        log("WARNINGS: " + " | ".join(warnings))


if __name__ == "__main__":
    main()
