import { useState, useEffect } from 'react'
import { Line, Bar, Doughnut } from 'react-chartjs-2'
import { getLineColor, groupStationsByLine, getLineList } from '../utils/lines'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler
} from 'chart.js'

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler
)

export default function DashboardOverview() {
  const [stations, setStations] = useState([])
  const [selectedLine, setSelectedLine] = useState('1호선')
  const [selectedStationId, setSelectedStationId] = useState('113') // 부산역(1호선)
  const [selectedStationName, setSelectedStationName] = useState('부산역')
  const [congestionData, setCongestionData] = useState(null)
  const [luggageSummary, setLuggageSummary] = useState(null)
  const [loading, setLoading] = useState(true)

  const fetchCongestion = async (stationName) => {
    try {
      const resp = await fetch(`/api/congestion/${encodeURIComponent(stationName)}`)
      if (!resp.ok) { setCongestionData(null); return }
      const json = await resp.json()
      setCongestionData(json.data || null)
    } catch (err) {
      console.error(err)
      setCongestionData(null)
    }
  }

  useEffect(() => {
    async function loadData() {
      try {
        const [stationsResp, luggageResp] = await Promise.all([
          fetch('/api/stations'),
          fetch('/api/luggage-flow')
        ])

        const stationsJson = await stationsResp.json()
        // 승하차 실데이터가 있는 역만 혼잡도 차트 대상으로 사용
        const withData = (stationsJson.stations || []).filter(s => s.hasCongestion)
        setStations(withData)

        const luggageJson = await luggageResp.json()
        setLuggageSummary(luggageJson.summary || null)

        // 기본 역(부산역)이 목록에 있으면 그 호선으로 동기화
        const def = withData.find(s => s.id === '113') || withData[0]
        if (def) {
          setSelectedLine(def.line)
          setSelectedStationId(def.id)
          setSelectedStationName(def.name)
          await fetchCongestion(def.name)
        }
      } catch (e) {
        console.error('Failed to load dashboard data:', e)
      } finally {
        setLoading(false)
      }
    }
    loadData()
  }, [])

  const stationsByLine = groupStationsByLine(stations)
  const lineList = getLineList(stations)

  // 호선 선택 시 해당 호선 첫 역으로 자동 이동
  const handleLineChange = (line) => {
    setSelectedLine(line)
    const first = (stationsByLine[line] || [])[0]
    if (first) {
      setSelectedStationId(first.id)
      setSelectedStationName(first.name)
      fetchCongestion(first.name)
    }
  }

  // 역 선택은 id 기준 — 동명역(동래 1·4호선 등)을 정확히 구분
  const handleStationChange = (e) => {
    const id = e.target.value
    const found = stations.find(s => s.id === id)
    if (!found) return
    setSelectedStationId(id)
    setSelectedStationName(found.name)
    fetchCongestion(found.name)
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center h-[50vh]">
        <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-[#3182f6]"></div>
      </div>
    )
  }

  // 짐배송 이동 흐름 엑셀(정규화 API) 기반 지표 — 하드코딩 없이 /api/luggage-flow 응답 사용
  const toPct = v => Math.round(v * 1000) / 10
  const deliveryDir = luggageSummary?.directions?.find(d => d.direction === '거점 → 숙소')
  const pickupDir = luggageSummary?.directions?.find(d => d.direction === '숙소 → 거점')
  const regions = luggageSummary?.regions || []
  const hubColors = ['rgba(99, 102, 241, 0.75)', 'rgba(244, 114, 182, 0.75)', 'rgba(52, 211, 153, 0.75)']

  // 1. Luggage Direction Doughnut
  const directionChartData = {
    labels: ['거점 ➔ 숙소 (짐 배송)', '숙소 ➔ 거점 (짐 픽업)'],
    datasets: [{
      data: [toPct(deliveryDir?.share || 0), toPct(pickupDir?.share || 0)],
      backgroundColor: ['rgba(99, 102, 241, 0.8)', 'rgba(244, 114, 182, 0.8)'],
      borderColor: ['rgba(99, 102, 241, 1)', 'rgba(244, 114, 182, 1)'],
      borderWidth: 1,
    }]
  }

  // 2. Luggage Dest Bar (from Hub to Accommodation)
  const destChartData = {
    labels: regions,
    datasets: (luggageSummary?.delivery || []).map((h, i) => ({
      label: `출발 거점: ${h.hub}`,
      data: h.dist.map(toPct),
      backgroundColor: hubColors[i % hubColors.length],
      borderRadius: 4,
    }))
  }

  const busanHub = luggageSummary?.delivery?.find(h => h.hub === '부산역')
  const gimhaeHub = luggageSummary?.delivery?.find(h => h.hub === '김해국제공항')

  // 3. Passenger Congestion Line Chart
  const hourlyLabels = [
    '05-06시', '06-07시', '07-08시', '08-09시', '09-10시', '10-11시', '11-12시',
    '12-13시', '13-14시', '14-15시', '15-16시', '16-17시', '17-18시', '18-19시',
    '19-20시', '20-21시', '21-22시', '22-23시', '23-24시'
  ]

  const getCongestionArray = (type) => {
    if (!congestionData || !congestionData[type]) return Array(19).fill(0)
    // Map standard hourly keys
    const timeKeys = [
      '05시-06시', '06시-07시', '07시-08시', '08시-09시', '09시-10시', '10시-11시', '11시-12시',
      '12시-13시', '13시-14시', '14시-15시', '15시-16시', '16시-17시', '17시-18시', '18시-19시',
      '19시-20시', '20시-21시', '21시-22시', '22시-23시', '23시-24시'
    ]
    return timeKeys.map(k => congestionData[type][k] || 0)
  }

  const congestionChartData = {
    labels: hourlyLabels,
    datasets: [
      {
        label: '평균 승차 승객',
        data: getCongestionArray('승차'),
        borderColor: '#818cf8',
        backgroundColor: 'rgba(129, 140, 248, 0.1)',
        fill: true,
        tension: 0.3,
      },
      {
        label: '평균 하차 승객',
        data: getCongestionArray('하차'),
        borderColor: '#f472b6',
        backgroundColor: 'rgba(244, 114, 182, 0.1)',
        fill: true,
        tension: 0.3,
      }
    ]
  }

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        labels: { color: '#4e5968', font: { family: 'Inter', size: 11 } }
      },
      tooltip: {
        backgroundColor: '#191f28',
        titleColor: '#fff',
        bodyColor: '#fff',
        borderColor: 'rgba(99, 102, 241, 0.3)',
        borderWidth: 1,
        cornerRadius: 8,
      }
    },
    scales: {
      x: {
        grid: { color: 'rgba(25, 31, 40, 0.06)' },
        ticks: { color: '#8b95a1', font: { size: 10 } }
      },
      y: {
        grid: { color: 'rgba(25, 31, 40, 0.06)' },
        ticks: { color: '#8b95a1', font: { size: 10 } }
      }
    }
  }

  return (
    <div className="space-y-8 animate-fade-in-up">
      {/* Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-6">
        <div className="glass-card p-5">
          <div className="text-[#6b7684] text-xs uppercase font-semibold">짐배송 서비스 이용 비율</div>
          <div className="text-3xl font-bold text-[#191f28] mt-1">{deliveryDir ? `${toPct(deliveryDir.share)}%` : '-'}</div>
          <div className="text-emerald-600 text-xs mt-1">거점 ➔ 숙소 배송 주도</div>
        </div>
        <div className="glass-card p-5">
          <div className="text-[#6b7684] text-xs uppercase font-semibold">내국인 짐배송 비율</div>
          <div className="text-3xl font-bold text-[#191f28] mt-1">{deliveryDir ? `${toPct(deliveryDir.domestic)}%` : '-'}</div>
          <div className="text-[#6b7684] text-xs mt-1">거점 ➔ 숙소 수요 중 비율</div>
        </div>
        <div className="glass-card p-5">
          <div className="text-[#6b7684] text-xs uppercase font-semibold">외국인 짐배송 비율</div>
          <div className="text-3xl font-bold text-[#191f28] mt-1">{deliveryDir ? `${toPct(deliveryDir.foreign)}%` : '-'}</div>
          <div className="text-[#1b64da] text-xs mt-1">영어/일어/중어 키오스크 연계</div>
        </div>
        <div className="glass-card p-5">
          <div className="text-[#6b7684] text-xs uppercase font-semibold">총 서비스 연계 지하철역</div>
          <div className="text-3xl font-bold text-[#191f28] mt-1">{stations.length}개 역</div>
          <div className="text-[#f04452] text-xs mt-1">엘리베이터 & 보관함 정보 매핑</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Luggage Direction */}
        <div className="glass-card p-6 flex flex-col justify-between">
          <div>
            <h3 className="text-lg font-bold text-[#191f28] mb-2">짐배송 서비스 흐름 분석</h3>
            <p className="text-xs text-[#6b7684] mb-6">주요거점 및 권역별 짐배송/짐픽업 이용 통계 비율 (2025년 연간)</p>
          </div>
          <div className="h-[200px] flex items-center justify-center">
            <Doughnut data={directionChartData} options={{ responsive: true, maintainAspectRatio: false }} />
          </div>
          <div className="mt-4 text-xs text-[#8b95a1] text-center">
            전체 이용 건수 중 입고(거점➔숙소)가 {deliveryDir ? `${toPct(deliveryDir.share)}%` : '-'}로 절반 이상을 차지합니다.
          </div>
        </div>

        {/* Luggage Destination */}
        <div className="glass-card p-6 lg:col-span-2 flex flex-col justify-between">
          <div>
            <h3 className="text-lg font-bold text-[#191f28] mb-2">권역별 짐배송 물량 분석</h3>
            <p className="text-xs text-[#6b7684] mb-6">출발 거점별 최종 숙소 권역으로의 짐배송 목적지별 비중 (%)</p>
          </div>
          <div className="h-[220px]">
            <Bar data={destChartData} options={chartOptions} />
          </div>
          <div className="mt-2 text-xs text-[#8b95a1]">
            * 부산역 출발 짐배송의 {busanHub ? `${toPct(busanHub.dist[0])}%` : '-'}가 <strong>{regions[0] || '해운대·기장'}</strong> 지역으로 몰리며, 김해국제공항 출발은 {regions[3] || '원도심'}({gimhaeHub ? `${toPct(gimhaeHub.dist[3])}%` : '-'}) 및 {regions[2] || '서면'}({gimhaeHub ? `${toPct(gimhaeHub.dist[2])}%` : '-'}) 등으로 분산됩니다. (출처: 주요거점·권역별 짐배송 이동 흐름 정보.xlsx)
          </div>
        </div>
      </div>

      {/* Subway Congestion Aggregator */}
      <div className="glass-card p-6">
        <div className="flex flex-col gap-4 mb-6">
          <div>
            <h3 className="text-lg font-bold text-[#191f28]">지하철역 시간대별 혼잡도 분석</h3>
            <p className="text-xs text-[#6b7684] mt-1">부산교통공사 시간대별 승하차 인원 통계(2025년 연간 + 2026년 1~5월) 요약 · 승객 분산 및 우회 설계용</p>
          </div>

          {/* 호선 선택 → 역 선택 2단계 (승하차 실데이터 보유 역만 노출) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-[#6b7684] mb-2">호선 선택</label>
              <div className="flex flex-wrap gap-1.5">
                {lineList.map(line => (
                  <button
                    key={`cong-line-${line}`}
                    type="button"
                    onClick={() => handleLineChange(line)}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition-all cursor-pointer ${
                      selectedLine === line ? 'text-[#191f28]' : 'text-[#6b7684] border-[#e8ebee] bg-[#f2f4f6] hover:bg-[#e8ebee]'
                    }`}
                    style={selectedLine === line ? { backgroundColor: `${getLineColor(line)}22`, borderColor: getLineColor(line) } : {}}
                  >
                    <span className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ backgroundColor: getLineColor(line) }} />
                    {line}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-[#6b7684] mb-2">역 선택</label>
              <select
                value={selectedStationId}
                onChange={handleStationChange}
                className="w-full bg-white border border-[#d1d6db] rounded-lg px-3 py-2 text-sm text-[#191f28] focus:outline-none focus:border-[#3182f6]"
              >
                {(stationsByLine[selectedLine] || []).map(s => (
                  <option key={s.id} value={s.id}>{s.name}{s.transferType === '환승역' ? ' 🔄' : ''}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {congestionData ? (
          <div className="h-[280px]">
            <Line data={congestionChartData} options={chartOptions} />
          </div>
        ) : (
          <div className="flex justify-center items-center h-[280px] text-[#8b95a1]">
            혼잡도 데이터를 불러올 수 없습니다.
          </div>
        )}
        <div className="mt-4 text-xs text-[#8b95a1]">
          * 이 통계 데이터는 엘리베이터 혼잡도를 계산하여 짐배송 작업 노선 배차 조정 및 교통약자 엘리베이터 정체 우회로 추천 엔진의 핵심 기초 자료로 활용됩니다.
        </div>
      </div>
    </div>
  )
}
