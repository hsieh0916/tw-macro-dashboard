# 台灣總經儀表板 Taiwan Macro & Market Dashboard

彙整台灣主要總體經濟指標，並與台股加權指數（TAIEX）對照，協助觀察景氣循環位置與股市資金環境。純靜態網站，資料每日透過 GitHub Actions 自動從官方公開資料源擷取更新，並部署於 GitHub Pages。

## 內容涵蓋

| 指標 | 頻率 | 資料來源 |
|---|---|---|
| GDP 經濟成長率（年增率） | 季 | 行政院主計總處 |
| 景氣對策信號（燈號＋綜合分數） | 月 | 國家發展委員會 |
| 景氣領先／同時／落後指標 | 月 | 國家發展委員會 |
| 製造業 PMI／非製造業 NMI | 月 | 國發會／中華經濟研究院 |
| 製造業未來六個月展望指數（最佳努力擷取） | 月 | 中華經濟研究院新聞稿 |
| 貨幣總計數 M1A／M1B／M2 年增率 | 月 | 中央銀行 |
| 台股加權指數、外資買賣超、美元／新台幣匯率 | 日／月 | 台灣證券交易所、央行（經 [FinMind](https://finmindtrade.com/) 公開 API） |

每個指標皆附上與台股加權指數的對照圖表（同一時間軸並列，或指數化至基期=100 後同軸疊圖，避免使用會誤導讀者的雙 Y 軸圖表），並附文字說明其與股市的關聯邏輯。

## 架構

純靜態網站，無需伺服器端框架：

```
index.html              # 頁面結構
assets/css/style.css    # 版面樣式與主題色票（支援淺色／深色模式）
assets/js/app.js        # 讀取 data/dashboard.json 並以 Chart.js 繪圖
data/dashboard.json      # 所有指標的時間序列資料（由腳本產生，網頁直接讀取）
scripts/fetch_data.py    # 資料擷取腳本
.github/workflows/update-data.yml  # 排程：每日自動執行擷取腳本並回寫資料
```

### 資料更新機制

`scripts/fetch_data.py` 直接呼叫各官方機關的公開資料端點（data.gov.tw 開放資料 API、央行/主計總處資料檔、FinMind API），彙整成單一 `data/dashboard.json`。GitHub Actions 每日排程執行該腳本；若資料有變動則自動 commit 回主分支，GitHub Pages 隨即重新部署。

任何單一資料源擷取失敗都不會讓整個流程中斷——失敗時會沿用上次成功寫入的資料，並將警告訊息記錄於 `data.meta.warnings`（會顯示在網頁頂端的提示區塊），方便追蹤資料源是否變動。

## 本機開發

```bash
pip install requests
python scripts/fetch_data.py   # 產生／更新 data/dashboard.json
python -m http.server 8000     # 在專案根目錄啟動簡易伺服器
# 瀏覽 http://localhost:8000
```

網址可加上 `?theme=light` 或 `?theme=dark` 強制指定主題（預設 `system` 跟隨作業系統設定），方便截圖或除錯。

## 免責聲明

本專案僅彙整並視覺化公開總體經濟統計資料，供總體經濟走勢參考與教育用途，**不構成任何投資建議或買賣訊號**。歷史指標與股市的關聯性不代表未來必然重演，投資決策請自行審慎評估並承擔風險。
