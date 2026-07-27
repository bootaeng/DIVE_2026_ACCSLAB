export default function StatsBar({ fileCount, chartCount, totalRecords }) {
  const stats = [
    {
      label: '데이터 파일',
      value: fileCount,
      icon: '📁',
      color: 'from-indigo-500 to-indigo-700',
    },
    {
      label: '시각화 차트',
      value: chartCount,
      icon: '📊',
      color: 'from-pink-500 to-pink-700',
    },
    {
      label: '총 레코드',
      value: totalRecords.toLocaleString(),
      icon: '📋',
      color: 'from-amber-500 to-orange-600',
    },
  ]

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-8">
      {stats.map((stat, i) => (
        <div
          key={stat.label}
          className={`glass-card p-5 flex items-center gap-4 opacity-0 animate-fade-in-up stagger-${i + 1}`}
        >
          <div className={`flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br ${stat.color} shadow-lg`}>
            <span className="text-xl">{stat.icon}</span>
          </div>
          <div>
            <p className="text-2xl font-bold text-white">{stat.value}</p>
            <p className="text-sm text-gray-400">{stat.label}</p>
          </div>
        </div>
      ))}
    </div>
  )
}
