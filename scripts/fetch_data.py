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
  - CNN Fear & Greed Index（美股市場情緒對照）    CNN Business（非官方端點）

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
from datetime import datetime, timedelta, timezone

import certifi
import requests

UA = {"User-Agent": "Mozilla/5.0 (compatible; tw-macro-dashboard/1.0; +https://github.com)"}
TIMEOUT = 30
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_PATH = os.path.join(ROOT, "data", "dashboard.json")
EXTRA_CERTS_DIR = os.path.join(ROOT, "scripts", "certs")

FINMIND_URL = "https://api.finmindtrade.com/api/v4/data"
CIER_LIST_URL = "https://www.cier.edu.tw/focus-ch/"
CNN_FNG_URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata"
CNN_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://edition.cnn.com/markets/fear-and-greed",
}


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
# CNN Business Fear & Greed Index —— 美股市場情緒對照（非官方 JSON 端點，
# 需附上瀏覽器 User-Agent 與 CNN 站內 Referer 才會回應，否則回傳 418；
# 此端點未經 CNN 正式公告為公開 API，長期穩定性不如政府開放資料，僅作為
# 美股情緒參考面板，不影響頁面其餘台灣指標的運作）
# ---------------------------------------------------------------------------
def fetch_cnn_fear_greed():
    log("fetching CNN Fear & Greed Index (unofficial endpoint, US market reference)")
    r = requests.get(CNN_FNG_URL, headers=CNN_HEADERS, timeout=TIMEOUT, verify=ca_bundle())
    r.raise_for_status()
    j = r.json()
    fg = j["fear_and_greed"]

    def comp(key):
        c = j.get(key)
        if not c or c.get("score") is None:
            return None
        return {"score": round(c["score"], 1), "rating": c["rating"]}

    components = {
        "market_momentum": comp("market_momentum_sp125"),
        "stock_price_strength": comp("stock_price_strength"),
        "stock_price_breadth": comp("stock_price_breadth"),
        "put_call_options": comp("put_call_options"),
        "junk_bond_demand": comp("junk_bond_demand"),
        "market_volatility": comp("market_volatility_vix"),
        "safe_haven_demand": comp("safe_haven_demand"),
    }

    historical = []
    for pt in j.get("fear_and_greed_historical", {}).get("data", [])[-365:]:
        try:
            date = datetime.fromtimestamp(pt["x"] / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
            historical.append({"date": date, "score": round(pt["y"], 1)})
        except Exception:
            continue

    out = {
        "score": round(fg["score"], 1),
        "rating": fg["rating"],
        "timestamp": fg["timestamp"],
        "previous_close": round(fg["previous_close"], 1) if fg.get("previous_close") is not None else None,
        "previous_1_week": round(fg["previous_1_week"], 1) if fg.get("previous_1_week") is not None else None,
        "previous_1_month": round(fg["previous_1_month"], 1) if fg.get("previous_1_month") is not None else None,
        "previous_1_year": round(fg["previous_1_year"], 1) if fg.get("previous_1_year") is not None else None,
        "components": components,
        "historical": historical,
    }
    log(f"  -> score={out['score']} ({out['rating']}), {len(historical)} historical days")
    return out


# ---------------------------------------------------------------------------
# 台股恐慌與貪婪指數 —— 仿照 CNN Fear & Greed 的方法論框架、改以台灣可公開
# 程式化取得的資料源重新計算的 7 項分項指標（並非 CNN 的美股原始資料）：
#   1. 動能     台股加權指數 vs 125 個交易日均線（沿用 fetch_taiex() 已抓的每日資料）
#   2. 強度     52 週創新高／新低家數比。需先累積約一年（250 個交易日）的每日
#               收盤價才會成熟，累積期間顯示「資料累積中」而非假造數值
#   3. 廣度     當日上漲／下跌家數比（證交所盤後統計）
#   4. 選擇權買賣權比   台指選擇權 Put/Call 成交量比（期交所，data.gov.tw dataset 11322）
#   5. 資金流向   外資買賣超近 20 個交易日累計 —— 取代 CNN 的「垃圾債需求」：
#               台灣沒有公開、可程式化取得的公司債／公債利差資料，但外資買賣
#               超本身即是本站已強調的台股邊際資金指標，改用作資金需求的類比
#   6. 波動度   台股加權指數近 20 個交易日已實現波動率（年化）—— 取代台指選擇權
#               波動率指數（該指數僅開放付費訂閱，一般使用者無法取得）
#   7. 避險需求   台股加權指數 vs 長天期美債ETF（00679B）近 20 個交易日報酬差 ——
#               取代美國公債總報酬：台灣公債殖利率無穩定可程式化來源
# 任一分項擷取失敗都只讓該分項顯示為空值，不影響其餘分項與綜合分數計算，
# 也不影響頁面其餘台灣總經指標。
# ---------------------------------------------------------------------------
TWSE_BREADTH_HISTORY_PATH = os.path.join(ROOT, "data", "twse_breadth_history.json")
BREADTH_WINDOW_DAYS = 250   # 52 週交易日，超過此天數的舊資料會被裁掉
BREADTH_MIN_DAYS = 60       # 累積天數不足時不計算 52 週強度分項


def _clamp(v, lo=0.0, hi=100.0):
    return max(lo, min(hi, v))


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def _stdev(xs):
    xs = [x for x in xs if x is not None]
    n = len(xs)
    if n < 2:
        return None
    m = sum(xs) / n
    return (sum((x - m) ** 2 for x in xs) / (n - 1)) ** 0.5


def _roc_to_iso(s):
    """民國年月日字串（如 '1150821'）轉為 'YYYY-MM-DD'。"""
    s = (s or "").strip().strip('"')
    m = re.match(r"^(\d{2,3})(\d{2})(\d{2})$", s)
    if not m:
        return None
    return f"{int(m.group(1)) + 1911}-{m.group(2)}-{m.group(3)}"


def score_momentum(taiex_daily):
    closes = [d["close"] for d in taiex_daily if d.get("close") is not None]
    if len(closes) < 125:
        return None
    ma125 = _mean(closes[-125:])
    dev_pct = (closes[-1] / ma125 - 1) * 100
    return {"score": round(_clamp(50 + dev_pct * 5), 1), "vs_ma125_pct": round(dev_pct, 2)}


def score_volatility(taiex_daily):
    closes = [d["close"] for d in taiex_daily if d.get("close") is not None]
    if len(closes) < 21:
        return None
    rets = [closes[i] / closes[i - 1] - 1 for i in range(len(closes) - 20, len(closes))]
    sd = _stdev(rets)
    if sd is None:
        return None
    vol_pct = sd * (252 ** 0.5) * 100
    # 年化已實現波動率 10% 視為平靜（貪婪端）、40% 視為劇烈（恐慌端）；
    # 波動度越高、CNN 方法論中越偏向恐慌，故分數與波動率反向。
    return {"score": round(_clamp(100 - (vol_pct - 10) * (100 / 30)), 1), "realized_vol_annualized_pct": round(vol_pct, 1)}


def score_safe_haven(taiex_daily):
    log("fetching bond ETF 00679B daily (FinMind, safe-haven-demand proxy)")
    rows = finmind_get("TaiwanStockPrice", data_id="00679B", start_date="2025-01-01")
    bond_closes = [r["close"] for r in rows if r.get("close") is not None]
    taiex_closes = [d["close"] for d in taiex_daily if d.get("close") is not None]
    if len(bond_closes) < 21 or len(taiex_closes) < 21:
        return None
    taiex_ret = taiex_closes[-1] / taiex_closes[-21] - 1
    bond_ret = bond_closes[-1] / bond_closes[-21] - 1
    spread_pp = (taiex_ret - bond_ret) * 100
    # 股票 20 日報酬領先公債 ETF 10 個百分點以上視為極度貪婪，落後 10 個百分點視為極度恐慌
    return {"score": round(_clamp(50 + spread_pp * 5), 1), "taiex_20d_pct": round(taiex_ret * 100, 2), "bond_20d_pct": round(bond_ret * 100, 2)}


def score_capital_flow():
    log("fetching daily foreign investor flow (FinMind, junk-bond-demand proxy)")
    since = (datetime.now(timezone.utc) - timedelta(days=45)).strftime("%Y-%m-%d")
    rows = finmind_get("TaiwanStockTotalInstitutionalInvestors", start_date=since)
    by_day = {}
    for row in rows:
        if row.get("name") != "Foreign_Investor":
            continue
        by_day[row["date"]] = by_day.get(row["date"], 0) + (row["buy"] - row["sell"])
    days = sorted(by_day)
    if len(days) < 10:
        return None
    net_100m = sum(by_day[d] for d in days[-20:]) / 1e8
    # ±新台幣 3,000 億元的近 20 日累計淨額對應 0～100 全幅（量級參考近年外資單日進出規模）
    return {"score": round(_clamp(50 + (net_100m / 3000) * 50), 1), "net_20d_100m": round(net_100m, 1)}


def score_put_call():
    log("fetching TAIFEX put/call volume ratio (dataset 11322)")
    url = resolve_datagovtw_url(11322)
    text = safe_get(url).content.decode("utf-8-sig")
    rows = [r for r in csv.reader(io.StringIO(text)) if r and re.match(r"^\d{8}$", r[0].strip())]
    if not rows:
        return None
    rows.sort(key=lambda r: r[0])
    latest = rows[-1]
    ratio = _num(latest[3]) if len(latest) > 3 else None
    if ratio is None:
        return None
    # 比率 100 視為賣權買權量相當（中性）；每偏離 1 個百分點對應 1 分，
    # 賣權相對偏多（比率>100）代表避險/看空需求較高，score 走向恐慌端
    d = latest[0].strip()
    date_iso = f"{d[:4]}-{d[4:6]}-{d[6:]}" if re.match(r"^\d{8}$", d) else None
    return {"score": round(_clamp(50 - (ratio - 100)), 1), "put_call_ratio_pct": ratio, "date": date_iso}


def score_breadth(iso_date):
    log(f"fetching TWSE market breadth for {iso_date} (MI_INDEX)")
    ymd = iso_date.replace("-", "")
    r = safe_get(f"https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date={ymd}&type=ALL")
    j = r.json()
    table = next((t for t in j.get("tables", []) if t.get("title") == "漲跌證券數合計"), None)
    if not table:
        return None
    stock_col = table["fields"].index("股票")
    rows = {row[0]: row[stock_col] for row in table["data"]}
    up = _num(re.sub(r"\(.*\)", "", rows.get("上漲(漲停)", "")).replace(",", ""))
    down = _num(re.sub(r"\(.*\)", "", rows.get("下跌(跌停)", "")).replace(",", ""))
    if up is None or down is None or (up + down) == 0:
        return None
    return {"score": round(_clamp(up / (up + down) * 100), 1), "advances": int(up), "declines": int(down)}


def _load_breadth_history():
    if os.path.exists(TWSE_BREADTH_HISTORY_PATH):
        try:
            with open(TWSE_BREADTH_HISTORY_PATH, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"dates": [], "stocks": {}}


def update_strength_accumulator():
    """下載當日全市場個股收盤價，累加進 52 週滾動窗口；資料量足夠前回傳
    status='accumulating'，之後才開始計算 52 週創新高／新低家數比。"""
    log("fetching TWSE STOCK_DAY_ALL for 52-week strength accumulator")
    text = safe_get("https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=json").content.decode("utf-8-sig")
    rows = list(csv.reader(io.StringIO(text)))
    hist = _load_breadth_history()

    today_iso = None
    today_closes = {}
    for row in rows[1:]:
        if len(row) < 9:
            continue
        stock_id = row[1].strip()
        if not re.match(r"^\d{4}$", stock_id):  # 僅計入 4 碼普通股，排除 ETF／權證等
            continue
        close = _num(row[8])
        if close is None:
            continue
        if today_iso is None:
            today_iso = _roc_to_iso(row[0])
        today_closes[stock_id] = close

    if not today_iso or not today_closes:
        raise RuntimeError("STOCK_DAY_ALL 無可用資料")

    if hist["dates"] and hist["dates"][-1] == today_iso:
        log(f"  -> {today_iso} already recorded, skipping append")
    else:
        hist["dates"].append(today_iso)
        all_ids = set(hist["stocks"]) | set(today_closes)
        for sid in all_ids:
            hist["stocks"].setdefault(sid, []).append(today_closes.get(sid))
        if len(hist["dates"]) > BREADTH_WINDOW_DAYS:
            drop = len(hist["dates"]) - BREADTH_WINDOW_DAYS
            hist["dates"] = hist["dates"][drop:]
            for sid in list(hist["stocks"]):
                hist["stocks"][sid] = hist["stocks"][sid][drop:]
                if not any(v is not None for v in hist["stocks"][sid]):
                    del hist["stocks"][sid]  # 已下市且窗口內完全無資料

        os.makedirs(os.path.dirname(TWSE_BREADTH_HISTORY_PATH), exist_ok=True)
        with open(TWSE_BREADTH_HISTORY_PATH, "w", encoding="utf-8") as f:
            json.dump(hist, f, separators=(",", ":"))
        log(f"  -> appended {today_iso}, now {len(hist['dates'])} days x {len(hist['stocks'])} stocks")

    n_days = len(hist["dates"])
    if n_days < BREADTH_MIN_DAYS:
        return {"score": None, "status": "accumulating", "days_collected": n_days, "days_needed": BREADTH_WINDOW_DAYS}

    highs = lows = 0
    for sid, closes in hist["stocks"].items():
        window = [c for c in closes if c is not None]
        if len(window) < BREADTH_MIN_DAYS or closes[-1] is None:
            continue
        last = closes[-1]
        if last >= max(window):
            highs += 1
        elif last <= min(window):
            lows += 1
    total = highs + lows
    status = "ready" if n_days >= BREADTH_WINDOW_DAYS else "accumulating"
    return {
        "score": round(_clamp(highs / total * 100), 1) if total else 50.0,
        "status": status,
        "days_collected": n_days,
        "days_needed": BREADTH_WINDOW_DAYS,
        "new_highs": highs,
        "new_lows": lows,
    }


TFG_RATING_BANDS = [(25, "extreme fear"), (45, "fear"), (55, "neutral"), (75, "greed"), (101, "extreme greed")]


def tfg_rating(score):
    for upper, label in TFG_RATING_BANDS:
        if score < upper:
            return label
    return "extreme greed"


def fetch_taiwan_fear_greed(taiex_daily, existing):
    components = {}

    def safe_component(name, fn):
        try:
            components[name] = fn()
        except Exception as e:
            log(f"  -> taiwan_fear_greed.{name} failed: {e}")
            components[name] = None

    safe_component("momentum", lambda: score_momentum(taiex_daily))
    safe_component("strength", update_strength_accumulator)
    safe_component("put_call", score_put_call)
    safe_component("capital_flow", score_capital_flow)
    safe_component("volatility", lambda: score_volatility(taiex_daily))
    safe_component("safe_haven", lambda: score_safe_haven(taiex_daily))

    breadth_date = taiex_daily[-1]["date"] if taiex_daily else None
    if breadth_date:
        safe_component("breadth", lambda: score_breadth(breadth_date))
    else:
        components["breadth"] = None

    available = [c["score"] for c in components.values() if c and c.get("score") is not None]
    composite = round(sum(available) / len(available), 1) if available else None

    hist = list(existing.get("taiwan_fear_greed", {}).get("historical", []))
    today = taiex_daily[-1]["date"] if taiex_daily else datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if composite is not None:
        hist = [h for h in hist if h["date"] != today]
        hist.append({"date": today, "score": composite})
        hist = hist[-400:]

    return {
        "score": composite,
        "rating": tfg_rating(composite) if composite is not None else None,
        "components_available": len(available),
        "components_total": len(components),
        "components": components,
        "historical": hist,
    }


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
        ("cnn_fear_greed", fetch_cnn_fear_greed),
    ]
    empty_defaults = {"taiex": {"monthly": [], "daily_recent": []}, "cnn_fear_greed": {}}
    for key, fn in fetchers:
        try:
            result[key] = fn()
        except Exception as e:
            log(f"ERROR fetching {key}: {e}")
            warnings.append(f"{key} 擷取失敗，沿用舊資料：{e}")
            if key not in result:
                result[key] = empty_defaults.get(key, [])

    outlook, outlook_warning = fetch_pmi_outlook(existing.get("pmi_outlook", []))
    result["pmi_outlook"] = outlook
    if outlook_warning:
        warnings.append(f"pmi_outlook：{outlook_warning}")

    log("computing 台股恐慌與貪婪指數 (7 分項，見程式內註解說明各項取代邏輯)")
    try:
        taiex_daily = result.get("taiex", {}).get("daily_recent", [])
        result["taiwan_fear_greed"] = fetch_taiwan_fear_greed(taiex_daily, existing)
        n_ok = result["taiwan_fear_greed"]["components_available"]
        if n_ok < result["taiwan_fear_greed"]["components_total"]:
            warnings.append(f"taiwan_fear_greed：僅 {n_ok}/7 個分項本次成功計算，其餘沿用/留空")
    except Exception as e:
        log(f"ERROR computing taiwan_fear_greed: {e}")
        warnings.append(f"taiwan_fear_greed 計算失敗，沿用舊資料：{e}")
        if "taiwan_fear_greed" not in result:
            result["taiwan_fear_greed"] = {}

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
            "cnn_fear_greed": {"name": "CNN Business Fear & Greed Index（美股市場情緒，非官方端點）", "url": "https://edition.cnn.com/markets/fear-and-greed"},
            "taiwan_fear_greed": {"name": "台股恐慌與貪婪指數（本站仿 CNN 方法論、以台灣資料源自行計算，非官方指數）", "url": "https://www.twse.com.tw/ 、 https://www.taifex.com.tw/ 、 https://finmindtrade.com/"},
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
