/* ==========================================================================
   台灣總經儀表板 — 前端渲染邏輯
   讀取 data/dashboard.json，繪製 KPI 卡片與各項圖表（Chart.js）。
   ========================================================================== */

(function () {
  "use strict";

  const DATA_URL = "data/dashboard.json?t=" + Date.now(); // 避免 GitHub Pages CDN 快取舊資料

  // ---------- 時間範圍篩選（單一列＋雙滑桿，套用到下方所有圖表，數字一律連動） ----------
  // 以「月索引」(year*12+month) 當作月資料與季資料共用的單一時間軸座標：
  // 季資料 YYYY-Qn 換算成該季最後一個月（Q1→03），即可與月資料直接比較、篩選。
  const RANGE_PRESETS = { "1": 1, "3": 3, "5": 5, "10": 10, all: null };
  let RANGE_START_IDX = 0;
  let RANGE_END_IDX = 0;
  let TIMELINE_MIN = 0;
  let TIMELINE_MAX = 0;

  function periodToIndex(period) {
    const q = /^(\d{4})-Q([1-4])$/.exec(period);
    if (q) return (+q[1]) * 12 + (+q[2]) * 3;
    const m = /^(\d{4})-(\d{2})$/.exec(period);
    if (m) return (+m[1]) * 12 + (+m[2]);
    return null;
  }
  function indexToPeriod(idx) {
    idx = Math.round(idx);
    const y = Math.floor((idx - 1) / 12);
    const m = idx - y * 12;
    return `${y}-${String(m).padStart(2, "0")}`;
  }
  function filterRange(arr, startIdx, endIdx) {
    return arr.filter((d) => {
      const idx = periodToIndex(d.period);
      return idx != null && idx >= startIdx && idx <= endIdx;
    });
  }

  // ---------- theme ----------
  const root = document.documentElement;
  function applyTheme(mode) {
    if (mode === "light" || mode === "dark") root.setAttribute("data-theme", mode);
    else root.removeAttribute("data-theme");
    localStorage.setItem("tw-macro-theme", mode);
  }
  const urlTheme = new URLSearchParams(location.search).get("theme");
  const savedTheme = (urlTheme === "light" || urlTheme === "dark" || urlTheme === "system")
    ? urlTheme
    : localStorage.getItem("tw-macro-theme") || "system";
  applyTheme(savedTheme);

  function css(varName) {
    return getComputedStyle(root).getPropertyValue(varName).trim();
  }

  // ---------- formatting helpers ----------
  const fmtNum = (v, digits = 1) =>
    v == null ? "—" : v.toLocaleString("zh-TW", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const fmtInt = (v) => (v == null ? "—" : Math.round(v).toLocaleString("zh-TW"));
  const fmtPct = (v, digits = 2) => (v == null ? "—" : (v > 0 ? "+" : "") + v.toFixed(digits) + "%");
  const fmtSigned = (v, digits = 1) => (v == null ? "—" : (v > 0 ? "+" : "") + fmtNum(v, digits));

  function deltaClass(v) {
    if (v == null || Math.abs(v) < 1e-9) return "flat";
    return v > 0 ? "up" : "down";
  }

  // ---------- Chart.js global setup ----------
  Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", "PingFang TC", "Microsoft JhengHei", sans-serif';
  Chart.defaults.font.size = 12;
  Chart.defaults.color = css("--text-muted");
  Chart.defaults.borderColor = css("--gridline");

  const crosshairPlugin = {
    id: "crosshair",
    afterDraw(chart) {
      const active = chart.tooltip && chart.tooltip._active;
      if (!active || !active.length) return;
      const x = active[0].element.x;
      const { top, bottom } = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.lineWidth = 1;
      ctx.strokeStyle = css("--baseline");
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.restore();
    },
  };
  Chart.register(crosshairPlugin);

  const activeCharts = [];

  function baseGridOptions() {
    return {
      grid: { color: css("--gridline"), drawTicks: false },
      border: { color: css("--baseline") },
      ticks: { color: css("--text-muted"), maxRotation: 0, autoSkip: true, autoSkipPadding: 14 },
    };
  }

  function makeLineChart(canvasId, { labels, datasets, yFormat, stacked = false }) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return null;
    const showLegend = datasets.length >= 2;
    const chart = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: datasets.map((d) => ({
          label: d.label,
          data: d.data,
          borderColor: d.color,
          backgroundColor: d.fill ? d.color + "1a" : d.color,
          borderWidth: 2,
          fill: !!d.fill,
          tension: 0.15,
          spanGaps: true,
          pointRadius: (c) => (c.dataIndex === d.data.length - 1 ? 4 : 0),
          pointHoverRadius: 5,
          pointHitRadius: 10,
          pointBackgroundColor: d.color,
          pointBorderColor: css("--surface-1"),
          pointBorderWidth: 2,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { ...baseGridOptions(), grid: { display: false } },
          y: {
            ...baseGridOptions(),
            ticks: {
              ...baseGridOptions().ticks,
              callback: (v) => (yFormat ? yFormat(v) : v),
            },
          },
        },
        plugins: {
          legend: {
            display: showLegend,
            position: "top",
            align: "start",
            labels: {
              usePointStyle: true,
              pointStyle: "line",
              boxWidth: 22,
              boxHeight: 2,
              color: css("--text-secondary"),
              padding: 14,
            },
          },
          tooltip: {
            backgroundColor: css("--surface-1"),
            titleColor: css("--text-primary"),
            bodyColor: css("--text-secondary"),
            borderColor: css("--border"),
            borderWidth: 1,
            padding: 10,
            usePointStyle: true,
            callbacks: yFormat ? { label: (item) => `${item.dataset.label}: ${yFormat(item.parsed.y)}` } : undefined,
          },
        },
      },
    });
    activeCharts.push(chart);
    return chart;
  }

  function makeBarChart(canvasId, { labels, data, color, negColor, yFormat }) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return null;
    const chart = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            data,
            backgroundColor: data.map((v) => (v < 0 && negColor ? negColor : color)),
            borderRadius: 4,
            borderSkipped: false,
            maxBarThickness: 22,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { ...baseGridOptions(), grid: { display: false } },
          y: { ...baseGridOptions(), ticks: { ...baseGridOptions().ticks, callback: (v) => (yFormat ? yFormat(v) : v) } },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: css("--surface-1"),
            titleColor: css("--text-primary"),
            bodyColor: css("--text-secondary"),
            borderColor: css("--border"),
            borderWidth: 1,
            padding: 10,
            callbacks: yFormat ? { label: (item) => yFormat(item.parsed.y) } : undefined,
          },
        },
      },
    });
    activeCharts.push(chart);
    return chart;
  }

  function destroyAllCharts() {
    while (activeCharts.length) activeCharts.pop().destroy();
  }

  // ---------- data alignment helpers ----------
  function lastN(arr, n) {
    return arr.length > n ? arr.slice(arr.length - n) : arr.slice();
  }

  // 兩序列僅取雙方皆有值的共同月份／季別，保留原始數值（不指數化），
  // 供上下並列、各自刻度的雙圖使用同一組 labels 以確保轉折點左右對齊。
  function alignSeries(seriesA, seriesB, valueKeyA, valueKeyB, startIdx, endIdx) {
    const mapA = new Map(seriesA.map((d) => [d.period, d[valueKeyA]]));
    const mapB = new Map(seriesB.map((d) => [d.period, d[valueKeyB]]));
    const periods = seriesA
      .map((d) => d.period)
      .filter((p) => mapA.get(p) != null && mapB.has(p) && mapB.get(p) != null);
    const windowed = filterRange(periods.map((p) => ({ period: p })), startIdx, endIdx).map((d) => d.period);
    if (!windowed.length) return null;
    return {
      labels: windowed,
      a: windowed.map((p) => mapA.get(p)),
      b: windowed.map((p) => mapB.get(p)),
    };
  }

  function rebaseIndexed(seriesA, seriesB, valueKeyA, valueKeyB, startIdx, endIdx) {
    const aligned = alignSeries(seriesA, seriesB, valueKeyA, valueKeyB, startIdx, endIdx);
    if (!aligned) return null;
    const base0A = aligned.a[0];
    const base0B = aligned.b[0];
    if (!base0A || !base0B) return null;
    return {
      labels: aligned.labels,
      a: aligned.a.map((v) => +((v / base0A) * 100).toFixed(2)),
      b: aligned.b.map((v) => +((v / base0B) * 100).toFixed(2)),
    };
  }

  function taiexQuarterly(monthly) {
    const byQ = new Map();
    monthly.forEach((d) => {
      const [y, m] = d.period.split("-");
      const q = Math.ceil(parseInt(m, 10) / 3);
      byQ.set(`${y}-Q${q}`, d.close); // 升冪覆蓋 = 該季最後一筆
    });
    return Array.from(byQ.entries()).map(([period, close]) => ({ period, close })).sort((a, b) => (a.period > b.period ? 1 : -1));
  }

  // ---------- table view (accessibility twin of every chart) ----------
  function wireTableToggle(buttonId, tableWrapId, columns, rows) {
    const btn = document.getElementById(buttonId);
    const wrap = document.getElementById(tableWrapId);
    if (!btn || !wrap) return;
    let built = false;
    btn.addEventListener("click", () => {
      const hidden = wrap.hasAttribute("hidden");
      if (hidden) {
        if (!built) {
          const table = document.createElement("table");
          const thead = document.createElement("thead");
          thead.innerHTML = "<tr>" + columns.map((c) => `<th>${c.label}</th>`).join("") + "</tr>";
          const tbody = document.createElement("tbody");
          rows.slice().reverse().forEach((row) => {
            const tr = document.createElement("tr");
            tr.innerHTML = columns.map((c) => `<td>${c.fmt ? c.fmt(row[c.key]) : row[c.key] ?? "—"}</td>`).join("");
            tbody.appendChild(tr);
          });
          table.appendChild(thead);
          table.appendChild(tbody);
          wrap.appendChild(table);
          built = true;
        }
        wrap.removeAttribute("hidden");
        btn.textContent = "隱藏資料表";
      } else {
        wrap.setAttribute("hidden", "");
        btn.textContent = "顯示資料表";
      }
    });
  }

  // ---------- 景氣對策信號 顏色對照 ----------
  const LIGHT_MAP = {
    "紅": { v: "--light-red", label: "紅燈", desc: "景氣熱絡（過熱警戒）" },
    "黃紅": { v: "--light-yellowred", label: "黃紅燈", desc: "轉向熱絡" },
    "綠": { v: "--light-green", label: "綠燈", desc: "景氣穩定" },
    "黃藍": { v: "--light-yellowblue", label: "黃藍燈", desc: "轉向低迷" },
    "藍": { v: "--light-blue", label: "藍燈", desc: "景氣低迷（衰退警戒）" },
  };

  function lightMeta(light) {
    return LIGHT_MAP[light] || { v: "--text-muted", label: light || "—", desc: "" };
  }

  // ---------- KPI tiles ----------
  function renderKPIs(data) {
    const row = document.getElementById("kpi-row");
    const bs = data.business_signal.filter((d) => d.score != null);
    const latestBS = bs[bs.length - 1];
    const prevBS = bs[bs.length - 2];
    const pmi = data.pmi.filter((d) => d.pmi != null);
    const latestPMI = pmi[pmi.length - 1];
    const prevPMI = pmi[pmi.length - 2];
    const gdp = data.gdp;
    const latestGDP = gdp[gdp.length - 1];
    const prevGDP = gdp[gdp.length - 2];
    const ms = data.money_supply.filter((d) => d.m1b_yoy != null);
    const latestMS = ms[ms.length - 1];
    const taiexM = data.taiex.monthly;
    const latestTaiex = taiexM[taiexM.length - 1];
    const prevTaiex = taiexM[taiexM.length - 2];
    const fx = data.fx_usdtwd;
    const latestFx = fx[fx.length - 1];

    const lm = lightMeta(latestBS.light);
    const taiexChangePct = latestTaiex && prevTaiex ? ((latestTaiex.close / prevTaiex.close - 1) * 100) : null;
    const pmiState = latestPMI.pmi >= 50 ? "擴張" : "緊縮";

    const tiles = [
      {
        label: "景氣對策信號（" + latestBS.period + "）",
        html: `<span class="light-chip" style="background:var(${lm.v})"><span class="dot"></span>${lm.label}</span>`,
        sub: `綜合分數 ${fmtInt(latestBS.score)} 分・${lm.desc}`,
      },
      {
        label: "GDP 經濟成長率（年增率，" + latestGDP.period + "）",
        value: fmtNum(latestGDP.yoy_pct, 2),
        unit: "%",
        delta: prevGDP ? fmtSigned(latestGDP.yoy_pct - prevGDP.yoy_pct, 2) + " pp（前季）" : null,
        deltaDir: prevGDP ? deltaClass(latestGDP.yoy_pct - prevGDP.yoy_pct) : "flat",
      },
      {
        label: "製造業 PMI（" + latestPMI.period + "）",
        value: fmtNum(latestPMI.pmi, 1),
        sub: `${pmiState}（50 為榮枯線）・NMI ${fmtNum(latestPMI.nmi, 1)}`,
        delta: prevPMI ? fmtSigned(latestPMI.pmi - prevPMI.pmi, 1) + " pt（前月）" : null,
        deltaDir: prevPMI ? deltaClass(latestPMI.pmi - prevPMI.pmi) : "flat",
      },
      {
        label: "M1B / M2 年增率（" + latestMS.period + "）",
        value: fmtNum(latestMS.m1b_yoy, 2) + " / " + fmtNum(latestMS.m2_yoy, 2),
        unit: "%",
        sub: `M1B－M2 差 ${fmtSigned(latestMS.m1b_m2_gap, 2)} pp`,
        deltaDir: latestMS.m1b_m2_gap > 0 ? "up" : "down",
      },
      {
        label: "台股加權指數（" + (latestTaiex ? latestTaiex.period : "—") + "）",
        value: latestTaiex ? fmtInt(latestTaiex.close) : "—",
        delta: taiexChangePct != null ? fmtSigned(taiexChangePct, 1) + "%（月）" : null,
        deltaDir: deltaClass(taiexChangePct),
      },
      {
        label: "美元／新台幣匯率（" + (latestFx ? latestFx.period : "—") + "）",
        value: latestFx ? fmtNum(latestFx.usdtwd, 3) : "—",
        sub: "銀行牌告即期匯率月均值",
      },
    ];

    row.innerHTML = tiles
      .map(
        (t) => `
      <div class="stat-tile">
        <div class="label">${t.label}</div>
        ${t.html ? t.html : `<div class="value-row"><span class="value">${t.value}</span>${t.unit ? `<span class="unit">${t.unit}</span>` : ""}</div>`}
        ${t.delta ? `<div class="delta ${t.deltaDir}">${t.delta}</div>` : ""}
        ${t.sub ? `<div class="sub">${t.sub}</div>` : ""}
      </div>`
      )
      .join("");
  }

  // ---------- 景氣對策信號 ----------
  function renderBusinessSignal(data) {
    const full = data.business_signal.filter((d) => d.score != null);
    const recent12 = lastN(full, 12);
    const strip = document.getElementById("signal-strip");
    strip.innerHTML = recent12
      .map((d) => {
        const lm = lightMeta(d.light);
        const mm = d.period.split("-")[1];
        return `<div class="cell" style="background:var(${lm.v})" title="${d.period}　${lm.label}　${fmtInt(d.score)}分">
          <span class="m">${mm}月</span><span class="s">${fmtInt(d.score)}</span>
        </div>`;
      })
      .join("");

    const windowed = filterRange(full, RANGE_START_IDX, RANGE_END_IDX);
    const aligned = alignSeries(full, data.taiex.monthly, "score", "close", RANGE_START_IDX, RANGE_END_IDX);
    const scoreLabels = aligned ? aligned.labels : windowed.map((d) => d.period);
    const scoreValues = aligned ? aligned.a : windowed.map((d) => d.score);
    makeLineChart("chart-signal-score", {
      labels: scoreLabels,
      datasets: [{ label: "景氣對策信號綜合分數", data: scoreValues, color: css("--series-blue") }],
      yFormat: (v) => v,
    });

    if (aligned) {
      makeLineChart("chart-signal-taiex-panel", {
        labels: aligned.labels,
        datasets: [{ label: "台股加權指數（月收盤）", data: aligned.b, color: css("--series-violet") }],
        yFormat: (v) => fmtInt(v),
      });
    }

    wireTableToggle("toggle-signal", "table-signal", [
      { key: "period", label: "月份" },
      { key: "score", label: "綜合分數", fmt: fmtInt },
      { key: "light", label: "燈號" },
      { key: "leading_index_notrend", label: "領先指標(不含趨勢)", fmt: (v) => fmtNum(v, 2) },
      { key: "coincident_index_notrend", label: "同時指標(不含趨勢)", fmt: (v) => fmtNum(v, 2) },
    ], windowed);
  }

  // ---------- 領先指標 ----------
  function renderLeading(data) {
    const full = data.business_signal.filter((d) => d.leading_index_notrend != null);
    const windowed = filterRange(full, RANGE_START_IDX, RANGE_END_IDX);

    // 兩圖改為上下並列、各自原始刻度、共用同一組月份 labels，
    // 而非把兩者指數化疊在同一軸上——後者的對齊起點是任意的，
    // 容易讓人誤以為兩條線的相關性比實際更強或更弱。
    const aligned = alignSeries(full, data.taiex.monthly, "leading_index_notrend", "close", RANGE_START_IDX, RANGE_END_IDX);
    const leadingLabels = aligned ? aligned.labels : windowed.map((d) => d.period);
    const leadingValues = aligned ? aligned.a : windowed.map((d) => d.leading_index_notrend);

    makeLineChart("chart-leading", {
      labels: leadingLabels,
      datasets: [
        { label: "領先指標不含趨勢指數", data: leadingValues, color: css("--series-blue") },
      ],
      yFormat: (v) => fmtNum(v, 0),
    });

    if (aligned) {
      makeLineChart("chart-leading-taiex-panel", {
        labels: aligned.labels,
        datasets: [{ label: "台股加權指數（月收盤）", data: aligned.b, color: css("--series-violet") }],
        yFormat: (v) => fmtInt(v),
      });
    }

    wireTableToggle("toggle-leading", "table-leading", [
      { key: "period", label: "月份" },
      { key: "leading_index", label: "領先指標綜合指數", fmt: (v) => fmtNum(v, 2) },
      { key: "leading_index_notrend", label: "不含趨勢指數", fmt: (v) => fmtNum(v, 2) },
    ], windowed);
  }

  // ---------- PMI / NMI ----------
  function renderPMI(data) {
    const full = data.pmi.filter((d) => d.pmi != null);
    const windowed = filterRange(full, RANGE_START_IDX, RANGE_END_IDX);
    makeLineChart("chart-pmi", {
      labels: windowed.map((d) => d.period),
      datasets: [
        { label: "製造業 PMI", data: windowed.map((d) => d.pmi), color: css("--series-blue") },
        { label: "非製造業 NMI", data: windowed.map((d) => d.nmi), color: css("--series-orange") },
      ],
      yFormat: (v) => fmtNum(v, 0),
    });

    const outlook = data.pmi_outlook || [];
    const outlookWrap = document.getElementById("pmi-outlook-wrap");
    if (outlook.length) {
      makeLineChart("chart-pmi-outlook", {
        labels: outlook.map((d) => d.period),
        datasets: [{ label: "製造業未來六個月展望指數", data: outlook.map((d) => d.value), color: css("--series-aqua") }],
        yFormat: (v) => fmtNum(v, 1),
      });
    } else if (outlookWrap) {
      outlookWrap.innerHTML = '<p class="chart-note">目前尚無可用資料。</p>';
    }

    wireTableToggle("toggle-pmi", "table-pmi", [
      { key: "period", label: "月份" },
      { key: "pmi", label: "製造業 PMI", fmt: (v) => fmtNum(v, 1) },
      { key: "nmi", label: "非製造業 NMI", fmt: (v) => fmtNum(v, 1) },
    ], windowed);
  }

  // ---------- M1B / M2 ----------
  function renderMoneySupply(data) {
    const full = data.money_supply.filter((d) => d.m1b_yoy != null && d.m2_yoy != null);
    const windowed = filterRange(full, RANGE_START_IDX, RANGE_END_IDX);
    makeLineChart("chart-money", {
      labels: windowed.map((d) => d.period),
      datasets: [
        { label: "M1B 年增率", data: windowed.map((d) => d.m1b_yoy), color: css("--series-blue") },
        { label: "M2 年增率", data: windowed.map((d) => d.m2_yoy), color: css("--series-orange") },
      ],
      yFormat: (v) => fmtNum(v, 1) + "%",
    });

    // m1b_yoy 可能出現負值，不適合指數化(除以基期可能為負)；改用原始年增率並排比較走勢時間軸一致即可
    makeLineChart("chart-money-vs-taiex", {
      labels: windowed.map((d) => d.period),
      datasets: [{ label: "M1B－M2 年增率差（pp）", data: windowed.map((d) => d.m1b_m2_gap), color: css("--series-blue") }],
      yFormat: (v) => fmtNum(v, 1),
    });

    wireTableToggle("toggle-money", "table-money", [
      { key: "period", label: "月份" },
      { key: "m1a_yoy", label: "M1A 年增率", fmt: (v) => fmtPct(v) },
      { key: "m1b_yoy", label: "M1B 年增率", fmt: (v) => fmtPct(v) },
      { key: "m2_yoy", label: "M2 年增率", fmt: (v) => fmtPct(v) },
      { key: "m1b_m2_gap", label: "M1B－M2 差", fmt: (v) => fmtSigned(v, 2) },
    ], windowed);
  }

  // ---------- GDP ----------
  function renderGDP(data) {
    const full = data.gdp;
    const windowed = filterRange(full, RANGE_START_IDX, RANGE_END_IDX);
    makeBarChart("chart-gdp", {
      labels: windowed.map((d) => d.period),
      data: windowed.map((d) => d.yoy_pct),
      color: css("--series-blue"),
      negColor: css("--series-red"),
      yFormat: (v) => fmtNum(v, 1) + "%",
    });

    const taiexQ = taiexQuarterly(data.taiex.monthly);
    // GDP 年增率本身已是變動率、可能為負，不適用指數化比較；改為雙折線並列同一張圖以顯示轉折點是否同步
    if (windowed.length) {
      makeLineChart("chart-gdp-vs-taiex", {
        labels: windowed.map((d) => d.period),
        datasets: [
          { label: "GDP 經濟成長率（年增率, %）", data: windowed.map((d) => d.yoy_pct), color: css("--series-blue") },
        ],
        yFormat: (v) => fmtNum(v, 1) + "%",
      });
      const taiexQWindowed = filterRange(taiexQ, RANGE_START_IDX, RANGE_END_IDX);
      makeLineChart("chart-gdp-taiex-panel", {
        labels: taiexQWindowed.map((d) => d.period),
        datasets: [{ label: "台股加權指數（季底收盤）", data: taiexQWindowed.map((d) => d.close), color: css("--series-violet") }],
        yFormat: (v) => fmtInt(v),
      });
    }

    wireTableToggle("toggle-gdp", "table-gdp", [
      { key: "period", label: "季別" },
      { key: "yoy_pct", label: "經濟成長率(年增率)", fmt: (v) => fmtPct(v) },
    ], windowed);
  }

  // ---------- 其他股市連動指標：外資買賣超 + 匯率 ----------
  function renderOthers(data) {
    const taiexM = filterRange(data.taiex.monthly, RANGE_START_IDX, RANGE_END_IDX);
    makeLineChart("chart-taiex", {
      labels: taiexM.map((d) => d.period),
      datasets: [{ label: "台股加權指數（月收盤）", data: taiexM.map((d) => d.close), color: css("--series-violet") }],
      yFormat: (v) => fmtInt(v),
    });

    const flow = data.foreign_flow.filter((d) => d.net_ntd_100m != null);
    const flowWindowed = filterRange(flow, RANGE_START_IDX, RANGE_END_IDX);
    makeBarChart("chart-foreign-flow", {
      labels: flowWindowed.map((d) => d.period),
      data: flowWindowed.map((d) => d.net_ntd_100m),
      color: css("--series-aqua"),
      negColor: css("--series-red"),
      yFormat: (v) => fmtInt(v) + " 億元",
    });

    const fx = filterRange(data.fx_usdtwd, RANGE_START_IDX, RANGE_END_IDX);
    makeLineChart("chart-fx", {
      labels: fx.map((d) => d.period),
      datasets: [{ label: "美元／新台幣即期匯率", data: fx.map((d) => d.usdtwd), color: css("--series-yellow") }],
      yFormat: (v) => fmtNum(v, 2),
    });

    wireTableToggle("toggle-others", "table-others", [
      { key: "period", label: "月份" },
      { key: "close", label: "台股收盤", fmt: fmtInt },
    ], taiexM);
  }

  // ---------- CNN Fear & Greed（美股情緒對照，獨立於上方台灣時間範圍篩選器，
  // 因為這是每日更新的美股「現況」快照，不是台灣歷史區間瀏覽的一部分） ----------
  const FNG_RATING_ZH = {
    "extreme fear": "極度恐慌",
    "fear": "恐慌",
    "neutral": "中性",
    "greed": "貪婪",
    "extreme greed": "極度貪婪",
  };
  const FNG_COMPONENTS = [
    ["market_momentum", "股價動能（vs 125 日均線）"],
    ["stock_price_strength", "股價強度（52 週新高／新低家數）"],
    ["stock_price_breadth", "股價廣度（漲跌成交量）"],
    ["put_call_options", "選擇權賣權／買權比"],
    ["junk_bond_demand", "垃圾債需求（利差）"],
    ["market_volatility", "市場波動度（VIX）"],
    ["safe_haven_demand", "避險需求（股票 vs 公債）"],
  ];

  function renderCnnFearGreed(data) {
    const fg = data.cnn_fear_greed;
    const scoreEl = document.getElementById("fng-score-value");
    const ratingEl = document.getElementById("fng-score-rating");
    const markerEl = document.getElementById("fng-meter-main-marker");
    const deltasEl = document.getElementById("fng-deltas");
    const compsEl = document.getElementById("fng-components");

    if (!fg || fg.score == null) {
      if (scoreEl) scoreEl.textContent = "—";
      if (ratingEl) ratingEl.textContent = "目前無法取得資料";
      if (deltasEl) deltasEl.innerHTML = "";
      if (compsEl) compsEl.innerHTML = "";
      return;
    }

    if (scoreEl) scoreEl.textContent = fmtNum(fg.score, 1);
    if (ratingEl) ratingEl.textContent = FNG_RATING_ZH[fg.rating] || fg.rating;
    if (markerEl) markerEl.style.left = Math.max(0, Math.min(100, fg.score)) + "%";

    if (deltasEl) {
      const rows = [
        ["前一交易日", fg.previous_close],
        ["1 週前", fg.previous_1_week],
        ["1 個月前", fg.previous_1_month],
        ["1 年前", fg.previous_1_year],
      ];
      deltasEl.innerHTML = rows
        .map(([label, v]) => `<div class="fng-delta-item"><span>${label}</span><span class="value">${v != null ? fmtNum(v, 1) : "—"}</span></div>`)
        .join("");
    }

    if (compsEl) {
      compsEl.innerHTML = FNG_COMPONENTS.map(([key, label]) => {
        const c = fg.components && fg.components[key];
        if (!c || c.score == null) {
          return `<div class="fng-component"><span class="fng-component-label">${label}</span><div class="fng-meter fng-meter-sm"></div><span class="fng-component-na">—</span></div>`;
        }
        const pct = Math.max(0, Math.min(100, c.score));
        return `<div class="fng-component">
          <span class="fng-component-label">${label}</span>
          <div class="fng-meter fng-meter-sm"><div class="fng-meter-marker" style="left:${pct}%"></div></div>
          <span class="fng-component-score">${fmtNum(c.score, 0)}</span>
        </div>`;
      }).join("");
    }

    const hist = fg.historical || [];
    if (hist.length) {
      makeLineChart("chart-fng-history", {
        labels: hist.map((d) => d.date),
        datasets: [{ label: "Fear & Greed 指數", data: hist.map((d) => d.score), color: css("--series-blue") }],
        yFormat: (v) => fmtInt(v),
      });
    }
  }

  // ---------- footer meta ----------
  function renderMeta(data) {
    const el = document.getElementById("generated-at");
    if (el && data.meta && data.meta.generated_at) {
      const d = new Date(data.meta.generated_at);
      el.textContent = d.toLocaleString("zh-TW", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Taipei" }) + "（台北時間）";
    }
    const warnBox = document.getElementById("data-warnings");
    if (warnBox) {
      if (data.meta && data.meta.warnings && data.meta.warnings.length) {
        warnBox.hidden = false;
        warnBox.innerHTML = "⚠️ 本次更新有部分項目未成功擷取，已沿用前次資料：<br>" + data.meta.warnings.map((w) => "・" + w).join("<br>");
      } else {
        warnBox.hidden = true;
      }
    }
  }

  // ---------- render orchestration ----------
  let LAST_DATA = null;

  function renderAll(data) {
    destroyAllCharts();
    renderKPIs(data);
    renderBusinessSignal(data);
    renderLeading(data);
    renderPMI(data);
    renderMoneySupply(data);
    renderGDP(data);
    renderOthers(data);
    renderCnnFearGreed(data);
    renderMeta(data);
  }

  function boot() {
    fetch(DATA_URL)
      .then((r) => r.json())
      .then((data) => {
        LAST_DATA = data;
        initRangeControl(data);
        renderAll(data);
      })
      .catch((err) => {
        console.error(err);
        const row = document.getElementById("kpi-row");
        if (row) row.innerHTML = '<p class="chart-note">資料載入失敗，請稍後重新整理頁面。</p>';
      });
  }

  document.addEventListener("DOMContentLoaded", boot);

  // ---------- range filter row：預設區間按鈕 ＋ 雙滑桿可自由拖曳任意起訖區間 ----------
  // 單一資料來源（RANGE_START_IDX / RANGE_END_IDX），改動後整頁重繪，
  // 所有圖表、資料表、KPI 一律套用同一時間範圍（滑桿拖曳中僅更新視覺，放開才重繪圖表）。
  function setRange(startIdx, endIdx, opts = {}) {
    const { persist = true, rerender = true } = opts;
    startIdx = Math.max(TIMELINE_MIN, Math.min(startIdx, TIMELINE_MAX));
    endIdx = Math.max(TIMELINE_MIN, Math.min(endIdx, TIMELINE_MAX));
    if (startIdx > endIdx) { const t = startIdx; startIdx = endIdx; endIdx = t; }
    RANGE_START_IDX = startIdx;
    RANGE_END_IDX = endIdx;

    const startInput = document.getElementById("range-start");
    const endInput = document.getElementById("range-end");
    if (startInput && endInput) {
      startInput.max = TIMELINE_MAX; // 先放寬互鎖限制，避免卡住新值
      endInput.min = TIMELINE_MIN;
      startInput.value = startIdx;
      endInput.value = endIdx;
      startInput.max = endIdx; // 再收緊：兩個把手不能互相跨過
      endInput.min = startIdx;
    }
    updateRangeVisual();
    if (persist) localStorage.setItem("tw-macro-range", JSON.stringify([indexToPeriod(startIdx), indexToPeriod(endIdx)]));
    if (rerender && LAST_DATA) renderAll(LAST_DATA);
  }

  function updateRangeVisual() {
    const fill = document.getElementById("range-slider-fill");
    const label = document.getElementById("range-slider-label");
    const span = (TIMELINE_MAX - TIMELINE_MIN) || 1;
    if (fill) {
      fill.style.left = (((RANGE_START_IDX - TIMELINE_MIN) / span) * 100) + "%";
      fill.style.right = (((TIMELINE_MAX - RANGE_END_IDX) / span) * 100) + "%";
    }
    if (label) label.textContent = `${indexToPeriod(RANGE_START_IDX)} ～ ${indexToPeriod(RANGE_END_IDX)}`;

    const wrap = document.getElementById("range-btns");
    if (wrap) {
      wrap.querySelectorAll("button[data-range]").forEach((b) => {
        const years = RANGE_PRESETS[b.dataset.range];
        const expectedStart = years == null ? TIMELINE_MIN : Math.max(TIMELINE_MIN, TIMELINE_MAX - years * 12);
        const match = RANGE_END_IDX === TIMELINE_MAX && RANGE_START_IDX === expectedStart;
        b.setAttribute("aria-pressed", String(match));
      });
    }
  }

  function initRangeControl(data) {
    const allPeriods = [
      ...data.business_signal.map((d) => d.period),
      ...data.taiex.monthly.map((d) => d.period),
      ...data.money_supply.map((d) => d.period),
      ...data.pmi.map((d) => d.period),
      ...data.fx_usdtwd.map((d) => d.period),
      ...data.foreign_flow.map((d) => d.period),
      ...data.gdp.map((d) => d.period),
    ];
    const idxs = allPeriods.map(periodToIndex).filter((v) => v != null);
    TIMELINE_MIN = Math.min(...idxs);
    TIMELINE_MAX = Math.max(...idxs);

    const startInput = document.getElementById("range-start");
    const endInput = document.getElementById("range-end");
    const wrap = document.getElementById("range-btns");
    if (startInput && endInput) {
      startInput.min = endInput.min = TIMELINE_MIN;
      startInput.max = endInput.max = TIMELINE_MAX;
    }

    // 還原上次選取區間：優先看網址 ?range=（起訖月份或年數皆可），其次 localStorage，都沒有則預設近 10 年
    let startIdx, endIdx;
    const urlRange = new URLSearchParams(location.search).get("range");
    if (urlRange) {
      const parts = urlRange.split(",");
      if (parts.length === 2) {
        startIdx = periodToIndex(parts[0].trim());
        endIdx = periodToIndex(parts[1].trim());
      } else if (/^\d+$/.test(urlRange.trim())) {
        endIdx = TIMELINE_MAX;
        startIdx = TIMELINE_MAX - (+urlRange) * 12;
      }
    }
    if (startIdx == null || endIdx == null) {
      try {
        const saved = JSON.parse(localStorage.getItem("tw-macro-range"));
        if (Array.isArray(saved) && saved.length === 2) {
          startIdx = periodToIndex(saved[0]);
          endIdx = periodToIndex(saved[1]);
        }
      } catch { /* 忽略壞掉的 localStorage 內容，改用預設值 */ }
    }
    if (startIdx == null || endIdx == null || isNaN(startIdx) || isNaN(endIdx)) {
      endIdx = TIMELINE_MAX;
      startIdx = TIMELINE_MAX - 120; // 預設近 10 年
    }
    setRange(startIdx, endIdx, { persist: false, rerender: false });

    if (startInput && endInput) {
      startInput.addEventListener("input", () => {
        RANGE_START_IDX = +startInput.value;
        endInput.min = RANGE_START_IDX;
        updateRangeVisual();
      });
      endInput.addEventListener("input", () => {
        RANGE_END_IDX = +endInput.value;
        startInput.max = RANGE_END_IDX;
        updateRangeVisual();
      });
      const commit = () => setRange(RANGE_START_IDX, RANGE_END_IDX);
      startInput.addEventListener("change", commit);
      endInput.addEventListener("change", commit);
    }

    if (wrap) {
      wrap.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-range]");
        if (!btn || !Object.prototype.hasOwnProperty.call(RANGE_PRESETS, btn.dataset.range)) return;
        const years = RANGE_PRESETS[btn.dataset.range];
        const endIdx2 = TIMELINE_MAX;
        const startIdx2 = years == null ? TIMELINE_MIN : Math.max(TIMELINE_MIN, TIMELINE_MAX - years * 12);
        setRange(startIdx2, endIdx2);
      });
    }
  }

  // theme toggle button
  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("theme-toggle");
    if (!btn) return;
    const cycle = { system: "light", light: "dark", dark: "system" };
    const label = { system: "🖥️ 系統", light: "☀️ 淺色", dark: "🌙 深色" };
    let current = localStorage.getItem("tw-macro-theme") || "system";
    btn.textContent = label[current];
    btn.addEventListener("click", () => {
      current = cycle[current];
      applyTheme(current);
      btn.textContent = label[current];
      // 顏色 token 隨主題改變，重新繪製圖表以套用新配色
      if (LAST_DATA) renderAll(LAST_DATA);
    });
  });
})();
