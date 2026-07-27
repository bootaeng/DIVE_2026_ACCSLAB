import { useState, useEffect, useRef } from 'react'

// 일차별 마커·동선 색상
const DAY_COLORS = ['#6366f1', '#ec4899', '#10b981']

// 좌표 간 실거리(km) — 하버사인
function distKm(a, b) {
  const R = 6371
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLng = (b.lng - a.lng) * Math.PI / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

// 실거리 기반 이동시간 추정: 1.5km 이하 도보(15분/km), 초과 시 대중교통(3분/km + 진입·대기 12분)
function legEstimate(a, b) {
  const km = distKm(a, b)
  const walk = km <= 1.5
  const min = walk ? Math.max(3, Math.round(km * 15)) : Math.round(km * 3 + 12)
  return { km: Math.round(km * 10) / 10, min, mode: walk ? '도보' : '대중교통' }
}

// 카카오맵 JS SDK 동적 로드 (1회만) — services 라이브러리 포함(키워드 장소검색)
let kakaoLoader = null
function loadKakaoSdk(appKey) {
  if (window.kakao?.maps?.services) return Promise.resolve(window.kakao)
  if (!kakaoLoader) {
    kakaoLoader = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${appKey}&libraries=services&autoload=false`
      script.onload = () => window.kakao.maps.load(() => resolve(window.kakao))
      script.onerror = () => reject(new Error('카카오맵 SDK 로드 실패 — JS 키와 사이트 도메인 등록을 확인하세요.'))
      document.head.appendChild(script)
    })
  }
  return kakaoLoader
}

// 장소검색으로 stops를 좌표화 (부산 광역권 바운딩 박스로 결과 제한)
// ※ radius 옵션은 최대 20,000m 제한(초과 시 400)이라 bounds 방식을 사용한다
function geocodeStops(kakao, stops) {
  const places = new kakao.maps.services.Places()
  const busanBounds = new kakao.maps.LatLngBounds(
    new kakao.maps.LatLng(34.90, 128.70),  // 남서
    new kakao.maps.LatLng(35.55, 129.40)   // 북동 (기장·양산 포함)
  )
  const searchOne = (stop) => new Promise((resolve) => {
    places.keywordSearch(stop.query || `부산 ${stop.name}`, (result, status) => {
      if (status === kakao.maps.services.Status.OK && result[0]) {
        resolve({ ...stop, lat: Number(result[0].y), lng: Number(result[0].x), address: result[0].address_name })
      } else {
        resolve(null) // 검색 실패한 장소는 지도에서 생략
      }
    }, { bounds: busanBounds })
  })
  // 순차 실행 (카카오 초당 제한 회피)
  return stops.reduce(
    (chain, stop) => chain.then(async (acc) => {
      const r = await searchOne(stop)
      await new Promise(res => setTimeout(res, 120))
      return r ? [...acc, r] : acc
    }),
    Promise.resolve([])
  )
}

export default function PlanMap({ stops }) {
  const mapRef = useRef(null)
  const mapObjRef = useRef({ map: null, overlays: [] })
  const [mapKey, setMapKey] = useState(undefined) // undefined=조회중, null=키없음
  const [geocoded, setGeocoded] = useState([])
  const [mapError, setMapError] = useState(null)
  const [activeDay, setActiveDay] = useState(0) // 0 = 전체
  const [roadLegs, setRoadLegs] = useState(null) // 카카오모빌리티 실도로 구간 데이터 (키 없으면 null)

  // 구간별 실도로 거리·시간 조회 (백엔드 /api/leg-times — KAKAO_REST_API_KEY 있을 때만 available)
  useEffect(() => {
    if (geocoded.length < 2) return
    let ignore = false
    const pairs = [], keys = []
    const dayList = [...new Set(geocoded.map(s => s.day))].sort()
    dayList.forEach(d => {
      const ds = geocoded.filter(s => s.day === d)
      ds.slice(1).forEach((s, i) => {
        pairs.push({ from: { lat: ds[i].lat, lng: ds[i].lng }, to: { lat: s.lat, lng: s.lng } })
        keys.push(`${d}:${i}`)
      })
    })
    fetch('/api/leg-times', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ legs: pairs })
    })
      .then(r => r.json())
      .then(j => {
        if (ignore || !j.available) return
        const map = {}
        j.legs.forEach((l, i) => { if (l) map[keys[i]] = l })
        setRoadLegs(map)
      })
      .catch(() => {}) // 실패 시 직선거리 추정 유지
    return () => { ignore = true }
  }, [geocoded])

  useEffect(() => {
    fetch('/api/config').then(r => r.json()).then(c => setMapKey(c.kakaoMapKey)).catch(() => setMapKey(null))
  }, [])

  // SDK 로드 + 지오코딩
  useEffect(() => {
    if (!mapKey || !stops?.length) return
    let ignore = false
    loadKakaoSdk(mapKey)
      .then(kakao => geocodeStops(kakao, stops))
      .then(list => { if (!ignore) setGeocoded(list) })
      .catch(e => { if (!ignore) setMapError(e.message) })
    return () => { ignore = true }
  }, [mapKey, stops])

  // 지도 렌더링 (일차 필터 반영)
  useEffect(() => {
    if (!mapKey || geocoded.length === 0 || !mapRef.current || !window.kakao?.maps) return
    const kakao = window.kakao
    const visible = activeDay === 0 ? geocoded : geocoded.filter(s => s.day === activeDay)
    if (visible.length === 0) return

    if (!mapObjRef.current.map) {
      mapObjRef.current.map = new kakao.maps.Map(mapRef.current, {
        center: new kakao.maps.LatLng(visible[0].lat, visible[0].lng),
        level: 7
      })
    }
    const map = mapObjRef.current.map

    // 기존 오버레이 제거
    mapObjRef.current.overlays.forEach(o => o.setMap(null))
    mapObjRef.current.overlays = []

    const bounds = new kakao.maps.LatLngBounds()
    const byDay = {}
    visible.forEach(s => { (byDay[s.day] = byDay[s.day] || []).push(s) })

    Object.entries(byDay).forEach(([day, dayStops]) => {
      const color = DAY_COLORS[(Number(day) - 1) % DAY_COLORS.length]
      // 동선 폴리라인
      if (dayStops.length > 1) {
        const line = new kakao.maps.Polyline({
          path: dayStops.map(s => new kakao.maps.LatLng(s.lat, s.lng)),
          strokeWeight: 3, strokeColor: color, strokeOpacity: 0.75, strokeStyle: 'shortdash'
        })
        line.setMap(map)
        mapObjRef.current.overlays.push(line)
      }
      // 번호 마커 (커스텀 오버레이)
      dayStops.forEach((s, i) => {
        const pos = new kakao.maps.LatLng(s.lat, s.lng)
        bounds.extend(pos)
        const el = document.createElement('div')
        el.style.cssText = `background:${color};color:#fff;border:2px solid #fff;border-radius:50%;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;box-shadow:0 2px 6px rgba(0,0,0,.4);cursor:pointer;`
        el.textContent = String(i + 1)
        el.title = `${day}일차 ${i + 1}. ${s.name}`
        const overlay = new kakao.maps.CustomOverlay({ position: pos, content: el, yAnchor: 0.5 })
        overlay.setMap(map)
        mapObjRef.current.overlays.push(overlay)
        // 라벨 (장소명)
        const label = document.createElement('div')
        label.style.cssText = 'background:rgba(255,255,255,.92);color:#111;border-radius:6px;padding:1px 6px;font-size:11px;font-weight:600;margin-top:30px;box-shadow:0 1px 3px rgba(0,0,0,.3);white-space:nowrap;'
        label.textContent = s.name
        const labelOverlay = new kakao.maps.CustomOverlay({ position: pos, content: label, yAnchor: 0 })
        labelOverlay.setMap(map)
        mapObjRef.current.overlays.push(labelOverlay)
      })
    })

    map.setBounds(bounds, 40, 40, 40, 40)
  }, [mapKey, geocoded, activeDay])

  if (!stops?.length) return null

  if (mapKey === null) {
    return (
      <div className="glass-card p-4 text-xs text-[#6b7684] leading-relaxed">
        🗺️ <strong className="text-[#191f28]">일정 지도 시각화</strong>를 사용하려면 카카오맵 JS 키가 필요합니다 —
        <a href="https://developers.kakao.com" target="_blank" rel="noreferrer" className="text-[#1b64da] hover:underline"> developers.kakao.com ↗</a>에서
        앱 생성 후 <code className="text-[#1b64da]">backend/.env</code>에 <code className="text-[#1b64da]">KAKAO_MAP_JS_KEY=자바스크립트키</code>를 추가하고
        플랫폼(Web)에 <code className="text-[#1b64da]">http://localhost:5173</code>을 등록하세요.
      </div>
    )
  }

  const days = [...new Set(geocoded.map(s => s.day))].sort()

  return (
    <div className="glass-card p-4">
      <div className="flex justify-between items-center mb-3 flex-wrap gap-2">
        <h5 className="text-xs font-bold text-[#191f28]">🗺️ 일정 동선 지도 <span className="text-[#8b95a1] font-normal">(카카오맵 · 장소검색 자동 매핑)</span></h5>
        {days.length > 1 && (
          <div className="flex gap-1">
            <button type="button" onClick={() => setActiveDay(0)}
              className={`px-2 py-0.5 rounded text-[10px] font-bold border cursor-pointer ${activeDay === 0 ? 'bg-[#e8ebee] border-[#d1d6db] text-[#191f28]' : 'bg-[#f2f4f6] border-[#e8ebee] text-[#8b95a1]'}`}>전체</button>
            {days.map(d => (
              <button key={d} type="button" onClick={() => setActiveDay(d)}
                className={`px-2 py-0.5 rounded text-[10px] font-bold border cursor-pointer ${activeDay === d ? 'text-[#191f28]' : 'text-[#8b95a1] bg-[#f2f4f6] border-[#e8ebee]'}`}
                style={activeDay === d ? { backgroundColor: `${DAY_COLORS[(d - 1) % DAY_COLORS.length]}33`, borderColor: DAY_COLORS[(d - 1) % DAY_COLORS.length] } : {}}>
                {d}일차
              </button>
            ))}
          </div>
        )}
      </div>

      {mapError && <p className="text-[11px] text-rose-600 mb-2">⚠️ {mapError}</p>}

      <div ref={mapRef} className="w-full h-[340px] rounded-xl overflow-hidden bg-[#f2f4f6]" />

      {geocoded.length > 0 ? (
        <>
          {/* 구간별 실거리·추정 이동시간 (좌표 기반) */}
          <div className="mt-3 space-y-2">
            {days.filter(d => activeDay === 0 || d === activeDay).map(d => {
              const dayStops = geocoded.filter(s => s.day === d)
              if (dayStops.length < 2) return null
              const color = DAY_COLORS[(d - 1) % DAY_COLORS.length]
              const legs = dayStops.slice(1).map((s, i) => {
                const est = legEstimate(dayStops[i], s)
                const data = roadLegs && roadLegs[`${d}:${i}`]
                const km = data ? data.km : est.km
                const walk = km <= 1.5
                if (walk) {
                  return { from: dayStops[i].name, to: s.name, km, mode: '도보', min: data ? data.walkMin : est.min, detail: null }
                }
                // 지하철 기준 (경로엔진 실측) — 없으면 거리 기반 추정
                if (data?.subwayMin) {
                  const sw = data.subway
                  return {
                    from: dayStops[i].name, to: s.name, km, mode: '지하철', min: data.subwayMin,
                    detail: sw ? `${sw.fromStation}→${sw.toStation}${sw.transfers ? ` 환승${sw.transfers}` : ''} + 도보 ${sw.walkMin}분` : null
                  }
                }
                return { from: dayStops[i].name, to: s.name, km, mode: '대중교통', min: Math.round(km * 3 + 12), detail: null }
              })
              const totalMin = legs.reduce((sum, l) => sum + l.min, 0)
              return (
                <div key={`legs-${d}`} className="bg-[#f2f4f6] border border-[#e8ebee] rounded-lg px-3 py-2">
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-[10px] font-bold" style={{ color }}>{d}일차 이동</span>
                    <span className="text-[10px] text-[#6b7684]">총 이동 약 <strong className="text-[#191f28]">{totalMin}분</strong></span>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                    {legs.map((l, i) => (
                      <span key={i} className="text-[10px] text-[#6b7684]">
                        {l.from} → {l.to} <strong className="text-[#333d4b]">{l.km}km · {l.mode} 약 {l.min}분</strong>
                        {l.detail && <span className="text-[#8b95a1]"> ({l.detail})</span>}
                      </span>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
          <p className="text-[10px] text-[#8b95a1] mt-2">
            📍 {geocoded.length}/{stops.length}개 장소 매핑됨 · 점선 = 일차별 이동 동선 · 지하철 소요시간 = 배리어프리 경로엔진 실측{roadLegs ? ' · 거리 = 실도로 기준(카카오모빌리티)' : ''} (지오코딩: 카카오 장소검색)
          </p>
        </>
      ) : (
        <p className="text-[10px] text-[#8b95a1] mt-2">장소 좌표를 검색하는 중...</p>
      )}
    </div>
  )
}
