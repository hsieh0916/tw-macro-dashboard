/* ==========================================================================
   台灣總經儀表板 — 前端渲染邏輯
   讀取 data/dashboard.json，繪製 KPI 卡片與各項圖表（Chart.js）。
   ========================================================================== */

(function () {
  "use strict";

  const DATA_URL = "data/dashboard.json?t=" + Date.now(); // 避免 GitHub Pages CDN 快取舊資料

  // ---------- 時間範圍篩選（單一列，套用到下方所有圖表，數字一律連動） ----------
  let MONTH_WINDOW = 120; // 月資料視窗（可被下方篩選器覆寫）
  let QUARTER_WINDOW = 40; // 季資料視窗（可被下方篩選器覆寫）
  const RANGE_PRESETS = { "1": 1, "3": 3, "5": 5, "10": 10, all: null };
  function applyRangeYears(years) {
    MONTH_WINDOW = years == null ? Infinity : years * 12;
    QUARTER_WINDOW = years == null ? Infinity : years * 4;
  }
  const savedRangeKey = (() => {
    const urlRange = new URLSearchParams(location.search).get("range");
    const saved = urlRange || localStorage.getItem("tw-macro-range");
    return Object.prototype.hasOwnProperty.call(RANGE_PRESETS, saved) ? saved : "10";
  })();
  applyRangeYears(RANGE_PRESETS[savedRangeKey]);

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
  function alignSeries(seriesA, seriesB, valueKeyA, valueKeyB, windowN) {
    const mapA = new Map(seriesA.map((d) => [d.period, d[valueKeyA]]));
    const mapB = new Map(seriesB.map((d) => [d.period, d[valueKeyB]]));
    const periods = seriesA
      .map((d) => d.period)
      .filter((p) => mapA.get(p) != null && mapB.has(p) && mapB.get(p) != null);
    const windowed = lastN(periods, windowN);
    if (!windowed.length) return null;
    return {
      labels: windowed,
      a: windowed.map((p) => mapA.get(p)),
      b: windowed.map((p) => mapB.get(p)),
    };
  }

  function rebaseIndexed(seriesA, seriesB, valueKeyA, valueKeyB, windowN) {
    const aligned = alignSeries(seriesA, seriesB, valueKeyA, valueKeyB, windowN);
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

    const windowed = lastN(full, MONTH_WINDOW);
    const aligned = alignSeries(full, data.taiex.monthly, "score", "close", MONTH_WINDOW);
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
    const windowed = lastN(full, MONTH_WINDOW);

    // 兩圖改為上下並列、各自原始刻度、共用同一組月份 labels，
    // 而非把兩者指數化疊在同一軸上——後者的對齊起點是任意的，
    // 容易讓人誤以為兩條線的相關性比實際更強或更弱。
    const aligned = alignSeries(full, data.taiex.monthly, "leading_index_notrend", "close", MONTH_WINDOW);
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
    const windowed = lastN(full, MONTH_WINDOW);
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
    const windowed = lastN(full, MONTH_WINDOW);
    makeLineChart("chart-money", {
      labels: windowed.map((d) => d.period),
      datasets: [
        { label: "M1B 年增率", data: windowed.map((d) => d.m1b_yoy), color: css("--series-blue") },
        { label: "M2 年增率", data: windowed.map((d) => d.m2_yoy), color: css("--series-orange") },
      ],
      yFormat: (v) => fmtNum(v, 1) + "%",
    });

    const cmp = rebaseIndexed(full, data.taiex.monthly, "m1b_yoy", "close", MONTH_WINDOW);
    // m1b_yoy 可能出現負值，不適合指數化(除以基期可能為負)；改用原始年增率並排比較走勢時間軸一致即可
    const gapWindowed = windowed;
    makeLineChart("chart-money-vs-taiex", {
      labels: gapWindowed.map((d) => d.period),
      datasets: [{ label: "M1B－M2 年增率差（pp）", data: gapWindowed.map((d) => d.m1b_m2_gap), color: css("--series-blue") }],
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
    const windowed = lastN(full, QUARTER_WINDOW);
    makeBarChart("chart-gdp", {
      labels: windowed.map((d) => d.period),
      data: windowed.map((d) => d.yoy_pct),
      color: css("--series-blue"),
      negColor: css("--series-red"),
      yFormat: (v) => fmtNum(v, 1) + "%",
    });

    const taiexQ = taiexQuarterly(data.taiex.monthly);
    const cmp = rebaseIndexed(full, taiexQ, "yoy_pct", "close", QUARTER_WINDOW);
    // GDP 年增率本身已是變動率、可能為負，不適用指數化比較；改為雙折線並列同一張圖以顯示轉折點是否同步
    if (cmp) {
      makeLineChart("chart-gdp-vs-taiex", {
        labels: windowed.map((d) => d.period),
        datasets: [
          { label: "GDP 經濟成長率（年增率, %）", data: windowed.map((d) => d.yoy_pct), color: css("--series-blue") },
        ],
        yFormat: (v) => fmtNum(v, 1) + "%",
      });
      const taiexQWindowed = lastN(taiexQ, QUARTER_WINDOW);
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
    const taiexM = lastN(data.taiex.monthly, MONTH_WINDOW);
    makeLineChart("chart-taiex", {
      labels: taiexM.map((d) => d.period),
      datasets: [{ label: "台股加權指數（月收盤）", data: taiexM.map((d) => d.close), color: css("--series-violet") }],
      yFormat: (v) => fmtInt(v),
    });

    const flow = data.foreign_flow.filter((d) => d.net_ntd_100m != null);
    const flowWindowed = lastN(flow, MONTH_WINDOW);
    makeBarChart("chart-foreign-flow", {
      labels: flowWindowed.map((d) => d.period),
      data: flowWindowed.map((d) => d.net_ntd_100m),
      color: css("--series-aqua"),
      negColor: css("--series-red"),
      yFormat: (v) => fmtInt(v) + " 億元",
    });

    const fx = lastN(data.fx_usdtwd, MONTH_WINDOW);
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
    renderMeta(data);
  }

  function boot() {
    fetch(DATA_URL)
      .then((r) => r.json())
      .then((data) => {
        LAST_DATA = data;
        renderAll(data);
      })
      .catch((err) => {
        console.error(err);
        const row = document.getElementById("kpi-row");
        if (row) row.innerHTML = '<p class="chart-note">資料載入失敗，請稍後重新整理頁面。</p>';
      });
  }

  document.addEventListener("DOMContentLoaded", boot);

  // range filter row（單一篩選列，改動後整頁重繪，所有圖表與 KPI 數字同步套用同一時間範圍）
  document.addEventListener("DOMContentLoaded", () => {
    const wrap = document.getElementById("range-btns");
    if (!wrap) return;
    const buttons = Array.from(wrap.querySelectorAll("button[data-range]"));
    buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.range === savedRangeKey)));
    wrap.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-range]");
      if (!btn || !Object.prototype.hasOwnProperty.call(RANGE_PRESETS, btn.dataset.range)) return;
      applyRangeYears(RANGE_PRESETS[btn.dataset.range]);
      localStorage.setItem("tw-macro-range", btn.dataset.range);
      buttons.forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      if (LAST_DATA) renderAll(LAST_DATA);
    });
  });

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
