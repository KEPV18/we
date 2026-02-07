const { Canvas } = require('skia-canvas');
const { Chart } = require('chart.js/auto');
const { getFirstOfDay, getLastOfDay } = require('./usageDb');

function fmtDay(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
}

async function collectDailyUsage(chatId, days) {
  const out = [];
  const labels = [];
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date();
    dt.setDate(dt.getDate() - i);
    const day = fmtDay(dt);
    const first = await getFirstOfDay(chatId, day);
    const last = await getLastOfDay(chatId, day);
    let used = null;
    if (first && last && first.usedGB != null && last.usedGB != null) {
      used = Math.max(0, last.usedGB - first.usedGB);
    }
    labels.push(day.slice(5));
    out.push(used ?? 0);
  }
  return { labels, values: out };
}

async function renderUsageReport(chatId, days = 30) {
  const data = await collectDailyUsage(chatId, days);
  const canvas = new Canvas(1000, 420);
  const chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: data.labels,
      datasets: [{
        label: 'GB/day',
        data: data.values,
        borderColor: 'rgba(99, 102, 241, 1)',
        backgroundColor: 'rgba(99, 102, 241, 0.4)'
      }]
    },
    options: {
      maintainAspectRatio: false,
      scales: {
        y: {
          beginAtZero: true
        }
      }
    }
  });
  const pngBuffer = await canvas.png;
  chart.destroy();
  return pngBuffer;
}

module.exports = { renderUsageReport };
