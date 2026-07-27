import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js'
import { Line, Bar } from 'react-chartjs-2'

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  Filler
)

function formatFileName(filePath) {
  // Extract just the filename, remove extension
  const parts = filePath.split('/')
  const name = parts[parts.length - 1]
  return name.replace(/\.csv$/i, '')
}

export default function ChartCard({ filePath, chartData, index }) {
  const { chartType, labels, datasets } = chartData

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      intersect: false,
      mode: 'index',
    },
    plugins: {
      legend: {
        display: datasets.length > 1,
        position: 'top',
        labels: {
          color: '#9ca3af',
          font: { family: 'Inter', size: 11 },
          boxWidth: 12,
          boxHeight: 12,
          borderRadius: 3,
          useBorderRadius: true,
          padding: 16,
        },
      },
      tooltip: {
        backgroundColor: 'rgba(30, 27, 46, 0.95)',
        titleColor: '#e2e0ea',
        bodyColor: '#9ca3af',
        borderColor: 'rgba(99, 102, 241, 0.3)',
        borderWidth: 1,
        cornerRadius: 10,
        padding: 12,
        titleFont: { family: 'Inter', weight: '600' },
        bodyFont: { family: 'Inter' },
        callbacks: {
          label: function (ctx) {
            const value = ctx.parsed.y
            return `${ctx.dataset.label}: ${value.toLocaleString()}`
          },
        },
      },
    },
    scales: {
      x: {
        grid: {
          color: 'rgba(255, 255, 255, 0.04)',
          drawBorder: false,
        },
        ticks: {
          color: '#6b7280',
          font: { family: 'Inter', size: 10 },
          maxRotation: 45,
          maxTicksLimit: 12,
        },
      },
      y: {
        grid: {
          color: 'rgba(255, 255, 255, 0.04)',
          drawBorder: false,
        },
        ticks: {
          color: '#6b7280',
          font: { family: 'Inter', size: 10 },
          callback: function (value) {
            if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M'
            if (value >= 1000) return (value / 1000).toFixed(0) + 'K'
            return value
          },
        },
      },
    },
  }

  const data = { labels, datasets }
  const ChartComponent = chartType === 'bar' ? Bar : Line
  const delay = Math.min(index, 5)

  return (
    <div
      className={`glass-card p-6 opacity-0 animate-fade-in-up stagger-${delay + 1}`}
    >
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-base font-semibold text-white leading-snug">
            {formatFileName(filePath)}
          </h3>
          <p className="text-xs text-gray-500 mt-1 font-mono">
            {filePath}
          </p>
        </div>
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
          {chartType === 'bar' ? '막대' : '라인'}
        </span>
      </div>

      <div className="h-[280px]">
        <ChartComponent options={options} data={data} />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {chartData.numericCols.map((col) => (
          <span
            key={col}
            className="text-xs px-2 py-1 rounded-md bg-white/5 text-gray-400 border border-white/5"
          >
            {col}
          </span>
        ))}
      </div>
    </div>
  )
}
