// script.js – fetch CSV list, load each CSV as JSON, render charts

const API_BASE = '/api';

async function fetchJson(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}`);
  return await resp.json();
}

function isNumeric(str) {
  return !isNaN(str) && str.trim() !== '';
}

function createChartCard(title) {
  const card = document.createElement('div');
  card.className = 'chart-card';
  const canvas = document.createElement('canvas');
  canvas.id = `chart-${title.replace(/\s+/g, '-').toLowerCase()}`;
  const heading = document.createElement('h3');
  heading.textContent = title;
  heading.style.color = 'var(--text-primary)';
  heading.style.marginBottom = '0.5rem';
  card.appendChild(heading);
  card.appendChild(canvas);
  return { card, canvas };
}

function renderChart(canvas, labels, data, chartTitle) {
  new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: chartTitle,
        data: data,
        borderColor: 'var(--primary)',
        backgroundColor: 'rgba(255,255,255,0.1)',
        fill: true,
        tension: 0.3,
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        title: { display: false }
      },
      scales: {
        x: { ticks: { color: 'var(--text-secondary)' } },
        y: { ticks: { color: 'var(--text-secondary)' } }
      }
    }
  });
}

async function initDashboard() {
  try {
    const fileList = await fetchJson(`${API_BASE}/files`);
    const container = document.getElementById('charts-container');
    for (const filePath of fileList.files) {
      const json = await fetchJson(`${API_BASE}/data/${encodeURIComponent(filePath)}`);
      const rows = json.data;
      if (!rows || rows.length === 0) continue;
      const header = Object.keys(rows[0]);
      // Find first numeric column for values, and first non-numeric for labels
      let valueCol = null;
      let labelCol = null;
      for (const col of header) {
        if (valueCol && labelCol) break;
        const sample = rows[0][col];
        if (isNumeric(sample) && !valueCol) {
          valueCol = col;
        } else if (!labelCol) {
          labelCol = col;
        }
      }
      const labels = rows.map(r => r[labelCol] ?? '');
      const data = rows.map(r => Number(r[valueCol]));
      const title = filePath.replace(/\/g, '/');
      const { card, canvas } = createChartCard(title);
      container.appendChild(card);
      renderChart(canvas, labels, data, title);
    }
  } catch (e) {
    console.error('Dashboard init error', e);
    const container = document.getElementById('charts-container');
    container.innerHTML = `<p style="color: var(--secondary)">Failed to load data: ${e.message}</p>`;
  }
}

// Initialize when DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDashboard);
} else {
  initDashboard();
}
