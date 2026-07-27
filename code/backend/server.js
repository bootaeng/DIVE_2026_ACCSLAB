const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const xlsx = require('xlsx');
const axios = require('axios');
const iconv = require('iconv-lite');
const { parseCSV } = require('./csv_utils');
const { SUPPLEMENTARY_STATIONS } = require('./supplementary_lines');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const DATA_ROOT = path.resolve(__dirname, '..', '..', '참가자_제공_데이터');
const EXTRA_DATA_ROOT = path.join(DATA_ROOT, '추가데이터');
// Normalized station lookup map (keyed by station ID)
let stationsMap = {};
let ridershipSummary = {}; // aggregated ridership data
let elevatorDetours = [];  // elevator detour routes
let luggageFlowData = {};  // Excel data parsed
let subwayGraph = {};      // Adjacency list: stationId -> [{to, weight, line, type}]
let stationCodeMap = {};   // Map station name -> SCODE for culture events API

// Simulated list of station IDs with active elevator breakdowns (under maintenance)
let activeBrokenElevators = new Set(['113', '229', '309']); // 부산역(113), 모덕(229), 미남(309)

// Set of above-ground station IDs in Busan Subway (susceptible to rain/snow/wet platforms)
const aboveGroundStations = new Set([
  '125', '126', '127', '128', '129', '130', '131', '134',         // Line 1 (동래~두실, 노포)
  '239', '240', '241', '242', '243',                             // Line 2 (호포~양산)
  '315', '316', '317',                                           // Line 3 (강서구청~대저)
  '410', '411', '412', '413', '414'                               // Line 4 (석대~안평)
]);

// Set of Zone 2 stations (2구간 역) for fare calculation
const zone2Stations = new Set([
  '239', '240', '241', '242', '243' // 호포, 증산, 부산대양산캠퍼스, 남양산, 양산 (Line 2)
]);

// Fare matrix — defaults below are overwritten from the official
// 부산교통공사_운임정보_20240503 CSV at startup (loadFareTable)
const fareTable = {
  zone1: { adult: 1600, youth: 1050, child: 0, multiChild: 800 },
  zone2: { adult: 1800, youth: 1200, child: 0, multiChild: 900 }
};
// QR 승차권 운임 (운임정보 CSV 기반)
const qrFareTable = {
  zone1: { adult: 1700, youth: 1150, child: 700, multiChild: 850 },
  zone2: { adult: 1900, youth: 1300, child: 800, multiChild: 950 }
};
// 정기권 안내 문구 (운임정보 CSV 기반)
let passInfo = [];

// Parse the official fare CSV into fareTable / qrFareTable / passInfo
function loadFareTable() {
  const farePath = path.join(EXTRA_DATA_ROOT, '부산교통공사_운임정보_20240503', 'fare_utf8.csv');
  if (!fs.existsSync(farePath)) {
    console.warn('⚠️ Fare CSV not found — using built-in fare defaults.');
    return;
  }
  try {
    const rows = parseCSV(fs.readFileSync(farePath));
    const targetKey = { '어른': 'adult', '청소년': 'youth', '어린이': 'child', '다자녀가정': 'multiChild' };
    const parseWon = v => {
      if (!v) return null;
      if (v.includes('무료')) return 0;
      const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10);
      return Number.isNaN(n) ? null : n;
    };
    rows.forEach(r => {
      const kind = r['승차권종별'] || '';
      const key = targetKey[r['대상']];
      if (kind === '정기권') {
        passInfo.push({ 대상: r['대상'], '1일권': r['1구간'], '3일권': r['2구간'], '1개월권': r['비고'] });
        return;
      }
      if (!key) return;
      const z1 = parseWon(r['1구간']);
      const z2 = parseWon(r['2구간']);
      if (kind.includes('교통카드')) {
        if (z1 !== null) fareTable.zone1[key] = z1;
        if (z2 !== null) fareTable.zone2[key] = z2;
      } else if (kind.includes('QR')) {
        if (z1 !== null) qrFareTable.zone1[key] = z1;
        if (z2 !== null) qrFareTable.zone2[key] = z2;
      }
    });
    console.log('✅ Loaded official fare table from 운임정보 CSV (card + QR + pass).');
  } catch (err) {
    console.error('❌ Failed to parse fare CSV:', err.message);
  }
}

// 경로의 실제 지리적 이동거리(km) — 노선 구간 haversine 합, 환승 보행/가중치 제외
function computePathDistance(pathDetails) {
  let dist = 0;
  for (let i = 0; i < pathDetails.length - 1; i++) {
    dist += haversineDistance(pathDetails[i], pathDetails[i + 1]);
  }
  return dist;
}

function calculateFare(pathDetails) {
  const distance = computePathDistance(pathDetails);
  // 부산도시철도 운임 기준: 이동거리 10km 이내 1구간, 10km 초과 2구간
  // (라우팅 가중치 비용이 아니라 실제 이동거리로 판정)
  const zone = distance > 10 ? 2 : 1;
  const table = zone === 2 ? fareTable.zone2 : fareTable.zone1;
  const qr = zone === 2 ? qrFareTable.zone2 : qrFareTable.zone1;
  return { zone, distance: Math.round(distance * 10) / 10, ...table, qr, passInfo };
}

// Real-time weather caching variables
let cachedWeather = null;
let lastWeatherFetchTime = 0;

// Fetch real-time weather in Busan from Open-Meteo API
async function getRealTimeWeather() {
  const now = Date.now();
  if (cachedWeather && (now - lastWeatherFetchTime < 10 * 60 * 1000)) {
    return cachedWeather;
  }

  try {
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=35.1796&longitude=129.0756&current=temperature_2m,precipitation,weather_code';
    const response = await fetch(url);
    if (!response.ok) throw new Error('Open-Meteo API response not ok');
    const json = await response.json();
    
    const temp = json.current.temperature_2m;
    const precip = json.current.precipitation;
    const code = json.current.weather_code;
    
    let condition = '맑음';
    let icon = '☀️';
    let isBad = false;

    if (code === 0) { condition = '맑음'; icon = '☀️'; }
    else if ([1, 2, 3].includes(code)) { condition = '구름조금'; icon = '⛅'; }
    else if ([45, 48].includes(code)) { condition = '안개'; icon = '🌫️'; }
    else if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) {
      condition = '비';
      icon = '🌧️';
      isBad = true;
    }
    else if ([71, 73, 75, 77, 85, 86].includes(code)) {
      condition = '눈';
      icon = '❄️';
      isBad = true;
    }
    else if ([95, 96, 99].includes(code)) {
      condition = '뇌우';
      icon = '⚡';
      isBad = true;
    }

    cachedWeather = {
      temp,
      precip,
      condition,
      icon,
      isBad,
      updatedAt: new Date().toISOString()
    };
    lastWeatherFetchTime = now;
    console.log(`🌤️ Weather updated: ${temp}°C, ${condition} (Precipitation: ${precip}mm)`);
  } catch (err) {
    console.error('❌ Failed to fetch weather from Open-Meteo:', err.message);
    if (!cachedWeather) {
      cachedWeather = {
        temp: 22.0,
        precip: 0.0,
        condition: '맑음 (로컬 캐시)',
        icon: '☀️',
        isBad: false,
        updatedAt: new Date().toISOString()
      };
    }
  }

  return cachedWeather;
}

// Load Station Codes (SCODE) from Excel for humetro OpenAPIs (문화행사·장애인편의시설)
try {
  const scodePath = [
    path.join(EXTRA_DATA_ROOT, '서비스명세서부산도시철도_문화행사정보', '역 코드목록.xlsx'),
    path.join(EXTRA_DATA_ROOT, '서비스명세서부산도시철도_장애인편의시설정보', '역 코드목록.xlsx'),
    path.join(DATA_ROOT, '서비스명세서부산도시철도_문화행사정보', '역 코드목록.xlsx')
  ].find(p => fs.existsSync(p));
  if (scodePath) {
    const workbook = xlsx.readFile(scodePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const jsonData = xlsx.utils.sheet_to_json(sheet);
    jsonData.forEach(row => {
      if (row['역명'] && row['SCODE']) {
        stationCodeMap[normalizeStationName(row['역명'])] = row['SCODE'].toString();
      }
    });
    console.log(`✅ Loaded ${Object.keys(stationCodeMap).length} station codes for culture events.`);
  }
} catch (err) {
  console.error('❌ Failed to load SCODE Excel:', err.message);
}

// Helper to normalize station names (e.g., "부산역" -> "부산")
// 가운뎃점(ㆍ·・･)은 데이터셋마다 표기가 제각각(예: 승하차 CSV "경성대부경대" vs
// 역사정보 "경성대ㆍ부경대")이라 아예 제거해 동일 키로 맞춘다.
function normalizeStationName(name) {
  if (!name) return '';
  return name.trim().replace(/역$/, '').replace(/[ㆍ·・･]/g, '').replace(/\s+/g, '');
}

// Haversine formula to compute geographical distance between two stations
function haversineDistance(s1, s2) {
  const R = 6371; // Earth radius in km
  const lat1 = s1.lat;
  const lon1 = s1.lng;
  const lat2 = s2.lat;
  const lon2 = s2.lng;

  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // distance in km
}

// Load and parse the detailed 20210226 TSV station info
function loadSubwayStationInfo() {
  const filePath = path.resolve(DATA_ROOT, '부산교통공사_도시철도역사정보_20210226.csv');
  if (!fs.existsSync(filePath)) {
    console.warn(`⚠️ File not found: ${filePath}`);
    return {};
  }
  try {
    const buffer = fs.readFileSync(filePath);
    let text = buffer.toString('utf16le');
    if (text.charCodeAt(0) === 0xFEFF) {
      text = text.slice(1);
    }
    const lines = text.split(/\r?\n/);
    if (lines.length === 0) return {};

    const headers = lines[0].trim().split('\t');
    const data = {};
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const values = line.split('\t');
      const obj = {};
      for (let j = 0; j < headers.length; j++) {
        obj[headers[j]] = values[j] !== undefined ? values[j].trim() : '';
      }
      const stationId = obj['역번호'];
      if (stationId) {
        data[stationId] = obj;
      }
    }
    console.log(`✅ Loaded ${Object.keys(data).length} stations from 20210226 CSV.`);
    return data;
  } catch (err) {
    console.error('❌ Error parsing 20210226 CSV:', err);
    return {};
  }
}

// Build the subway network graph
function buildSubwayGraph() {
  subwayGraph = {};
  
  // 1. Initialize adjacency list
  Object.keys(stationsMap).forEach(id => {
    subwayGraph[id] = [];
  });

  // 2. Group by line and sort by ID to connect adjacent stations
  const lines = {};
  Object.values(stationsMap).forEach(s => {
    if (!lines[s.line]) {
      lines[s.line] = [];
    }
    lines[s.line].push(s);
  });

  Object.keys(lines).forEach(lineName => {
    const lineStations = lines[lineName];
    lineStations.sort((a, b) => parseInt(a.id) - parseInt(b.id));

    for (let i = 0; i < lineStations.length - 1; i++) {
      const s1 = lineStations[i];
      const s2 = lineStations[i + 1];
      const dist = haversineDistance(s1, s2);

      subwayGraph[s1.id].push({ to: s2.id, weight: dist, line: lineName, type: 'line' });
      subwayGraph[s2.id].push({ to: s1.id, weight: dist, line: lineName, type: 'line' });
    }
  });

  // 3. Connect transfer stations (same name, different lines)
  const stationsByName = {};
  Object.values(stationsMap).forEach(s => {
    const normName = normalizeStationName(s.name);
    if (!stationsByName[normName]) {
      stationsByName[normName] = [];
    }
    stationsByName[normName].push(s);
  });

  Object.keys(stationsByName).forEach(name => {
    const sList = stationsByName[name];
    if (sList.length > 1) {
      for (let i = 0; i < sList.length; i++) {
        for (let j = i + 1; j < sList.length; j++) {
          const s1 = sList[i];
          const s2 = sList[j];
          const transferWeight = 3.0; // transfer walk/wait penalty (eq. to 3km)

          subwayGraph[s1.id].push({ to: s2.id, weight: transferWeight, line: `${s1.line}➔${s2.line}`, type: 'transfer' });
          subwayGraph[s2.id].push({ to: s1.id, weight: transferWeight, line: `${s2.line}➔${s1.line}`, type: 'transfer' });
        }
      }
    }
  });

  console.log(`✅ Built subway network graph with ${Object.keys(subwayGraph).length} nodes.`);
}

// Look up averaged ridership for a station by day-type (weekday|weekend), boarding-type, and hour slot.
// Falls back to weekday bucket if the requested day-type is missing.
function getRidership(normName, dayType, type, timeKey) {
  const rec = ridershipSummary[normName];
  if (!rec) return 0;
  const bucket = rec[dayType] || rec.weekday || {};
  const typeObj = bucket[type];
  if (!typeObj) return 0;
  return typeObj[timeKey] || 0;
}

// Calculate the routing cost for an edge, accounting for barrier-free parameters
// withLuggage: 대형 수하물 소지 시 — 환승·연단간격·혼잡 부담이 커지는 것을 가중치로 반영
//  (OT 발제자료의 문제 정의 "수하물 소지로 인한 물리적 제약 및 신체적 피로 누적" 모델링)
function calculateEdgeCost(u, v, edge, mode, travelTime, dayType, withLuggage = false) {
  let baseCost = edge.weight;
  const luggageFactor = withLuggage ? 1.5 : 1;

  // 짐 소지 시 환승 부담 증가 (계단·엘리베이터 대기 등 — 환승 기본 가중 3.0에 +1.5)
  if (withLuggage && edge.type === 'transfer') {
    baseCost += 1.5;
  }

  if (mode !== 'barrier_free') {
    return baseCost;
  }

  let penalty = 0;
  const targetStation = stationsMap[v];

  // 1. Platform Gap Penalty
  if (targetStation && targetStation.gaps && targetStation.gaps.length > 0) {
    const hasWideGap = targetStation.gaps.some(g => g['연단간격'] && g['연단간격'].includes('넓음'));
    if (hasWideGap) {
      penalty += 1.5 * luggageFactor; // 짐 소지 시 연단간격 위험 가중
    }
  }

  // 2. Broken Elevator Penalty (Only for activeBrokenElevators)
  if (targetStation && activeBrokenElevators.has(v)) {
    const targetNormName = normalizeStationName(targetStation.name);
    const detour = elevatorDetours.find(d => 
      d['역번호'] === v || normalizeStationName(d['역명']) === targetNormName
    );
    if (detour) {
      const isAvailable = detour['경로 이용 가능 여부'] || 'Y';
      if (isAvailable === 'N') {
        penalty += 100.0; // extremely high penalty (make impassable)
      } else {
        const complexity = parseInt(detour['경로복잡도 점수']) || 3;
        penalty += complexity * 2.0;
      }
    }
  }

  // 3. Station Congestion Penalty (짐 소지 시 혼잡 구간 부담 가중)
  if (targetStation) {
    const targetNormName = normalizeStationName(targetStation.name);
    const timeKey = travelTime || '18시-19시';
    const boarding = getRidership(targetNormName, dayType, '승차', timeKey);
    const alighting = getRidership(targetNormName, dayType, '하차', timeKey);
    const total = boarding + alighting;
    if (total > 2000) {
      penalty += (total / 2000) * 1.5 * luggageFactor;
    }
  }

  // 4. Real-time Weather Penalty for Above-ground Platforms (Rain/Snow/Thunderstorm)
  if (targetStation && cachedWeather && cachedWeather.isBad && aboveGroundStations.has(v)) {
    penalty += 2.0; // 2km weight penalty due to wet/slippery outdoor conditions
  }

  return baseCost + penalty;
}

// Dijkstra shortest path solver
function findShortestPath(startInput, endInput, mode, travelTime, dayType, withLuggage = false) {
  let startNodes = [];
  let endNodes = [];

  const startInputNorm = normalizeStationName(startInput);
  const endInputNorm = normalizeStationName(endInput);

  if (stationsMap[startInput]) {
    startNodes = [startInput];
  } else {
    startNodes = Object.values(stationsMap)
      .filter(s => normalizeStationName(s.name) === startInputNorm)
      .map(s => s.id);
  }

  if (stationsMap[endInput]) {
    endNodes = [endInput];
  } else {
    endNodes = Object.values(stationsMap)
      .filter(s => normalizeStationName(s.name) === endInputNorm)
      .map(s => s.id);
  }

  if (startNodes.length === 0 || endNodes.length === 0) {
    return null;
  }

  const distances = {};
  const previous = {};
  const edgeUsed = {};
  const visited = new Set();
  const pq = [];

  Object.keys(stationsMap).forEach(id => {
    distances[id] = Infinity;
    previous[id] = null;
    edgeUsed[id] = null;
  });

  startNodes.forEach(id => {
    distances[id] = 0;
    pq.push({ id, dist: 0 });
  });

  const sortPQ = () => pq.sort((a, b) => a.dist - b.dist);

  while (pq.length > 0) {
    sortPQ();
    const { id: u } = pq.shift();

    if (visited.has(u)) continue;
    visited.add(u);

    if (endNodes.includes(u)) break;

    const neighbors = subwayGraph[u] || [];
    for (const edge of neighbors) {
      const v = edge.to;
      if (visited.has(v)) continue;

      const cost = calculateEdgeCost(u, v, edge, mode, travelTime, dayType, withLuggage);
      const alt = distances[u] + cost;

      if (alt < distances[v]) {
        distances[v] = alt;
        previous[v] = u;
        edgeUsed[v] = edge;
        pq.push({ id: v, dist: alt });
      }
    }
  }

  let bestEndNode = null;
  let minDist = Infinity;
  endNodes.forEach(id => {
    if (distances[id] < minDist) {
      minDist = distances[id];
      bestEndNode = id;
    }
  });

  if (!bestEndNode || minDist === Infinity) {
    return null;
  }

  const path = [];
  let curr = bestEndNode;
  while (curr !== null) {
    path.unshift(curr);
    curr = previous[curr];
  }

  const pathDetails = path.map((id, index) => {
    const s = stationsMap[id];
    const prevId = index > 0 ? path[index - 1] : null;
    const edge = prevId ? edgeUsed[id] : null;

    return {
      id: s.id,
      name: s.name,
      nameEn: s.nameEn || '',
      nameOrigin: s.nameOrigin || '',
      amenityFlags: s.amenityFlags || null,
      line: s.line,
      lat: s.lat,
      lng: s.lng,
      address: s.address,
      tel: s.tel,
      transferType: s.transferType,
      transferLines: s.transferLines,
      edgeType: edge ? edge.type : 'start',
      edgeLine: edge ? edge.line : null,
      supplementary: !!s.supplementary,
      gaps: s.gaps,
      elevators: s.elevators,
      escalators: s.escalators,
      lockers: s.lockers,
      atms: s.atms,
      chargers: s.chargers,
      kiosks: s.kiosks
    };
  });

  return {
    path: pathDetails,
    cost: minDist
  };
}

// In-memory data loader
function loadAllData() {
  console.log('🔄 Loading datasets into memory...');

  try {
    // 1. Load Station Info
    const stationPath = path.join(DATA_ROOT, '1. 역사 정보.csv');
    if (fs.existsSync(stationPath)) {
      const stationRaw = fs.readFileSync(stationPath);
      const stations = parseCSV(stationRaw);
      stations.forEach(s => {
        const id = s['역번호'].trim();
        const normName = normalizeStationName(s['역명']);
        stationsMap[id] = {
          id: id,
          line: s['호선명'],
          name: s['역명'],
          subName: s['부역명'] || '',
          lat: parseFloat(s['경도']) || 35.1795,
          lng: parseFloat(s['위도']) || 129.0756, 
          transfer: s['환승노선명'] || '',
          elevators: [],
          escalators: [],
          lockers: [],
          atms: [],
          chargers: [],
          kiosks: [],
          gaps: []
        };
      });
      console.log(`✅ Loaded ${Object.keys(stationsMap).length} stations from baseline CSV.`);
    }

    // Enrich with detailed 20210226 CSV (matched by ID)
    const enrichedInfo = loadSubwayStationInfo();
    Object.keys(stationsMap).forEach(id => {
      const info = enrichedInfo[id];
      if (info) {
        stationsMap[id].lat = parseFloat(info['역위도']) || stationsMap[id].lat;
        stationsMap[id].lng = parseFloat(info['역경도']) || stationsMap[id].lng;
        stationsMap[id].address = info['역사도로명주소'] || stationsMap[id].address || '';
        stationsMap[id].tel = info['역사전화번호'] || stationsMap[id].tel || '';
        stationsMap[id].transferType = info['환승역구분'] || '일반역';
        stationsMap[id].transferLines = info['환승노선명'] || '';
      }
    });

    // Helper function to load and group by station ID/name
    const loadAndGroup = (subPath, category) => {
      const fullPath = path.join(DATA_ROOT, subPath);
      if (fs.existsSync(fullPath)) {
        const raw = fs.readFileSync(fullPath);
        const list = parseCSV(raw);
        list.forEach(item => {
          const normName = normalizeStationName(item['역명']);
          // 호선명 표기 정규화: 락커 CSV는 "1"처럼 숫자만 있어 "1호선"으로 맞춘다
          // (추가데이터 물품보관함 CSV는 컬럼명이 '호선')
          let line = item['호선명'] || item['호선'] ? String(item['호선명'] || item['호선']).trim() : null;
          if (line && /^\d+$/.test(line)) line = `${line}호선`;
          const stationId = item['역번호'] ? item['역번호'].trim() : null;

          if (stationId && stationsMap[stationId]) {
            stationsMap[stationId][category].push(item);
          } else {
            // Fallback: match by name and line
            Object.values(stationsMap).forEach(s => {
              if (normalizeStationName(s.name) === normName) {
                if (!line || s.line === line) {
                  s[category].push(item);
                }
              }
            });
          }
        });
        console.log(`✅ Loaded ${list.length} items for ${category}.`);
      } else {
        console.warn(`⚠️ File not found: ${subPath}`);
      }
    };

    // 2. Load Comfort Facilities
    loadAndGroup('3. 역사별 이동 편의시설 정보 데이터셋/1. 역사별 엘리베이터 정보.csv', 'elevators');
    loadAndGroup('3. 역사별 이동 편의시설 정보 데이터셋/2. 역사별 에스컬레이터 정보.csv', 'escalators');
    loadAndGroup('3. 역사별 이동 편의시설 정보 데이터셋/4. 승강장 간격 및 곡선구간 정보.csv', 'gaps');
    // 물품보관함: 추가데이터의 전수 CSV(전 역사) 우선, 없으면 기존 sample로 폴백
    if (fs.existsSync(path.join(EXTRA_DATA_ROOT, '부산교통공사_물품보관함 정보_20251231.csv'))) {
      loadAndGroup('추가데이터/부산교통공사_물품보관함 정보_20251231.csv', 'lockers');
    } else {
      loadAndGroup('4. 역사별 편의시설 정보 데이터셋/1. 역사별 물품보관함 현황 정보(sample).csv', 'lockers');
    }
    loadAndGroup('4. 역사별 편의시설 정보 데이터셋/2. 역사별 ATM 설치 현황 정보.csv', 'atms');
    loadAndGroup('4. 역사별 편의시설 정보 데이터셋/3. 역사별 핸드폰 충전설비 현황 정보.csv', 'chargers');
    loadAndGroup('4. 역사별 편의시설 정보 데이터셋/4. 교통약자 네비게이션 키오스크.csv', 'kiosks');

    // 2-1. Enrich stations with 추가데이터 역정보 (영문명·부대시설 플래그·역명 유래)
    const stationExtraPath = path.join(EXTRA_DATA_ROOT, '부산교통공사_도시철도 역정보_20211020.csv');
    if (fs.existsSync(stationExtraPath)) {
      const extraRows = parseCSV(fs.readFileSync(stationExtraPath));
      let enriched = 0;
      extraRows.forEach(row => {
        const s = stationsMap[String(row['역코드'] || '').trim()];
        if (!s) return;
        s.nameEn = row['영문'] || '';
        s.nameOrigin = row['역명및 지명유래'] || '';
        s.amenityFlags = {
          transferParking: row['환승주차장'] === 'O',
          bikeStorage: row['자전거보관소'] === 'O',
          lockerFlag: row['물품보관함'] === 'O',
          photoBooth: row['자동사진기'] === 'O',
          police: row['도시철도경찰대'] === 'O'
        };
        enriched++;
      });
      console.log(`✅ Enriched ${enriched} stations with 역정보 20211020 (영문명/유래/부대시설).`);
    }

    // 3. Load Elevator Detour Paths
    const detourPath = path.join(DATA_ROOT, '3. 역사별 이동 편의시설 정보 데이터셋/3. 엘리베이터 고장 시 대체 이동 경로.csv');
    if (fs.existsSync(detourPath)) {
      const raw = fs.readFileSync(detourPath);
      elevatorDetours = parseCSV(raw);
      console.log(`✅ Loaded ${elevatorDetours.length} elevator detour routes.`);
    }

    // 4. Load Excel: Luggage flow data
    const excelPath = path.join(DATA_ROOT, '5. 주요거점 · 권역별 짐배송 이동 흐름 정보.xlsx');
    if (fs.existsSync(excelPath)) {
      const workbook = xlsx.readFile(excelPath);
      workbook.SheetNames.forEach(sheetName => {
        luggageFlowData[sheetName] = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
      });
      console.log(`✅ Loaded luggage flows from Excel sheet.`);
    }

    // 5. Load and Aggregate Ridership Data (2025 연간 + 추가데이터 2026년 1~5월)
    const ridershipPaths = [
      path.join(DATA_ROOT, '2. 시간대별 승하차 인원(2025년).csv'),
      path.join(EXTRA_DATA_ROOT, '부산교통공사_시간대별 승하차인원_20260531.csv')
    ].filter(p => fs.existsSync(p));

    const WEEKEND_DAYS = new Set(['토', '일']);
    ridershipPaths.forEach(ridershipPath => {
      console.log(`⏳ Parsing ridership data: ${path.basename(ridershipPath)}...`);
      const raw = fs.readFileSync(ridershipPath);
      const ridershipRecords = parseCSV(raw);

      ridershipRecords.forEach(r => {
        const normName = normalizeStationName(r['역명']);
        const type = r['구분']; // 승차 | 하차
        const dayType = WEEKEND_DAYS.has((r['요일'] || '').trim()) ? 'weekend' : 'weekday';
        if (!ridershipSummary[normName]) {
          ridershipSummary[normName] = {
            weekday: { 승차: {}, 하차: {} },
            weekend: { 승차: {}, 하차: {} }
          };
        }

        const typeObj = ridershipSummary[normName][dayType][type] || {};
        const hourCols = Object.keys(r).filter(k => k.includes('시-') && k.includes('시'));
        hourCols.forEach(col => {
          const val = parseInt(String(r[col] || '0').replace(/,/g, '')) || 0;
          if (!typeObj[col]) {
            typeObj[col] = { sum: 0, count: 0 };
          }
          typeObj[col].sum += val;
          typeObj[col].count += 1;
        });
        ridershipSummary[normName][dayType][type] = typeObj;
      });
    });

    // Calculate averages per day-type / boarding-alighting (after all files merged)
    if (ridershipPaths.length > 0) {
      Object.keys(ridershipSummary).forEach(station => {
        ['weekday', 'weekend'].forEach(dayType => {
          ['승차', '하차'].forEach(type => {
            const hourData = ridershipSummary[station][dayType][type];
            Object.keys(hourData).forEach(hour => {
              const { sum, count } = hourData[hour];
              hourData[hour] = count > 0 ? Math.round(sum / count) : 0;
            });
          });
        });
      });
      console.log(`✅ Aggregated ridership data (${ridershipPaths.length} files, weekday/weekend) for ${Object.keys(ridershipSummary).length} stations.`);
    }

    // 5-1. Load official fare table (추가데이터 운임정보 CSV)
    loadFareTable();

    // 6. Merge supplementary lines (동해선 · 부산김해경전철) — curated data, no 부산교통공사 congestion/facility data
    let addedSupplementary = 0;
    SUPPLEMENTARY_STATIONS.forEach(s => {
      if (!stationsMap[s.id]) {
        stationsMap[s.id] = { ...s };
        addedSupplementary++;
      }
    });
    console.log(`✅ Merged ${addedSupplementary} supplementary stations (동해선/부산김해경전철).`);

    // Build the graph representation for Dijkstra (auto-wires adjacency + name-based transfers)
    buildSubwayGraph();

  } catch (err) {
    console.error('❌ Error loading data at startup:', err);
  }
}

loadAllData();

// 환승역 플래그 정합화 — 원본 CSV가 노선별 레코드마다 환승 표기가 달라
// (예: 동래 4호선=환승역, 동래 1호선=일반역) 경로 표시에서 환승역 칩이 누락된다.
// 같은 이름이 두 개 이상 노선에 존재하면 모든 레코드를 환승역으로 통일한다.
(function reconcileTransferFlags() {
  const byName = {};
  Object.values(stationsMap).forEach(s => {
    if (s.supplementary) return; // 동해선·경전철은 "○○(동해선)"으로 이름이 달라 제외
    const key = normalizeStationName(s.name);
    (byName[key] = byName[key] || []).push(s);
  });
  let fixed = 0;
  Object.values(byName).forEach(group => {
    if (group.length < 2) return;
    const lines = group.map(s => `부산도시철도 ${s.line}`).join('+');
    group.forEach(s => {
      if (s.transferType !== '환승역') fixed++;
      s.transferType = '환승역';
      if (!s.transferLines) s.transferLines = lines;
    });
  });
  if (fixed) console.log(`🔧 환승역 표기 정합화: ${fixed}개 레코드를 환승역으로 보정`);
})();

// ----------------- API ENDPOINTS -----------------

// 1. Get all stations with coordinates and convenience facilities
app.get('/api/stations', (req, res) => {
  // hasCongestion: 부산교통공사 승하차 실데이터가 존재하는 역만 true.
  // 보조노선(동해선·경전철)은 데이터가 없으므로(supplementary) false —
  // 동명역(동래/부전)이라도 "○○(동해선)"으로 이름이 구분돼 1호선 데이터를 빌려오지 않는다.
  const stations = Object.values(stationsMap).map(s => ({
    ...s,
    hasCongestion: !s.supplementary && !!ridershipSummary[normalizeStationName(s.name)]
  }));
  res.json({ stations });
});

// 1-1. Real-time Busan weather (global widget) — Open-Meteo, 10min cache
app.get('/api/weather', async (req, res) => {
  res.json(await getRealTimeWeather());
});

// 좌표에서 가장 가까운 도시철도역 찾기 (구간 이동시간의 지하철 환산용)
function nearestStation(pt) {
  let best = null;
  let bestKm = Infinity;
  for (const s of Object.values(stationsMap)) {
    if (!s.lat || !s.lng) continue;
    const d = haversineDistance(pt, s);
    if (d < bestKm) { bestKm = d; best = s; }
  }
  return best ? { station: best, km: bestKm } : null;
}

// 1-2. 일정 구간별 이동 정보 — 지하철 기준 소요시간(경로엔진 실측) + 실도로 거리(카카오모빌리티, 키 있을 때)
app.post('/api/leg-times', async (req, res) => {
  const key = process.env.KAKAO_REST_API_KEY;
  const legs = Array.isArray(req.body && req.body.legs) ? req.body.legs.slice(0, 40) : [];
  if (legs.length === 0) return res.json({ available: false, legs: [] });
  const out = [];
  for (const leg of legs) {
    const straightKm = haversineDistance(leg.from, leg.to);
    const entry = {
      km: Math.round(straightKm * 10) / 10,
      roadBased: false,
      walkMin: Math.max(3, Math.round(straightKm * 15)), // 도보 15분/km
      subwayMin: null,
      subway: null,
    };
    // ① 실도로 거리 보정 (카카오모빌리티 자동차 길찾기 — REST 키 있을 때만)
    if (key) {
      try {
        const url = 'https://apis-navi.kakaomobility.com/v1/directions'
          + `?origin=${leg.from.lng},${leg.from.lat}&destination=${leg.to.lng},${leg.to.lat}&summary=true`;
        const resp = await axios.get(url, { headers: { Authorization: `KakaoAK ${key}` }, timeout: 5000 });
        const route = resp.data && resp.data.routes && resp.data.routes[0];
        if (route && route.result_code === 0) {
          const meters = route.summary.distance;
          entry.km = Math.round(meters / 100) / 10;
          entry.walkMin = Math.max(3, Math.round((meters / 1000) * 15));
          entry.roadBased = true;
        }
      } catch (err) { /* 실도로 조회 실패 → 직선거리 유지 */ }
    }
    // ② 지하철 기준 소요시간 — 인근 역 도보 + 경로엔진(역당 2분·환승 4분·대기 4분)
    try {
      const a = nearestStation(leg.from);
      const b = nearestStation(leg.to);
      if (a && b && normalizeStationName(a.station.name) !== normalizeStationName(b.station.name)) {
        const r = findShortestPath(a.station.id, b.station.id, 'barrier_free', '12시-13시', 'weekday');
        if (r && r.path && r.path.length > 1) {
          const transfers = r.path.filter(n => n.edgeType === 'transfer').length;
          const rideHops = Math.max(1, r.path.length - 1 - transfers);
          const rideMin = rideHops * 2 + transfers * 4 + 4;
          const walkMin = Math.round((a.km + b.km) * 15);
          entry.subwayMin = rideMin + walkMin;
          entry.subway = {
            fromStation: displayName(a.station.name),
            toStation: displayName(b.station.name),
            transfers,
            rideMin,
            walkMin,
          };
        }
      }
    } catch (err) { /* 경로 계산 실패 → 프론트가 거리 기반 추정 사용 */ }
    out.push(entry);
  }
  res.json({ available: true, legs: out });
});

// 2. Get hourly average congestion profile for a specific station
// `data` mirrors the requested day-type (default weekday) for backward compatibility;
// both weekday and weekend buckets are also returned for day-type comparison.
app.get('/api/congestion/:stationName', (req, res) => {
  const normName = normalizeStationName(req.params.stationName);
  const rec = ridershipSummary[normName];
  if (!rec) {
    return res.status(404).json({ error: `Congestion data not found for station: ${req.params.stationName}` });
  }
  const dayType = req.query.day === 'weekend' ? 'weekend' : 'weekday';
  res.json({
    station: normName,
    dayType,
    data: rec[dayType] || rec.weekday,
    weekday: rec.weekday,
    weekend: rec.weekend
  });
});

// 짐배송 엑셀 시트(sheet_to_json 원본)를 차트용 구조로 정규화
function buildLuggageSummary() {
  // 각 행에서 첫 번째(제목) 컬럼 값 추출 — __EMPTY* 가 아닌 키가 시트 제목 컬럼
  const getRowLabel = row => {
    const key = Object.keys(row).find(k => !k.startsWith('__EMPTY'));
    return key ? String(row[key]).trim() : '';
  };
  const REGION_COLS = ['__EMPTY_1', '__EMPTY_2', '__EMPTY_3', '__EMPTY_4', '__EMPTY_5'];
  const HUBS = ['부산역', '김해국제공항', '부산항 국제여객터미널'];

  const summary = { directions: [], regions: [], delivery: [], pickup: [] };

  // ① 방향별요약: 거점→숙소 / 숙소→거점 비율 + 내·외국인 구성
  const dirKey = Object.keys(luggageFlowData).find(k => k.includes('방향별'));
  (luggageFlowData[dirKey] || []).forEach(row => {
    const label = getRowLabel(row);
    if (label === '거점 → 숙소' || label === '숙소 → 거점') {
      summary.directions.push({
        direction: label,
        share: Number(row['__EMPTY']) || 0,
        domestic: Number(row['__EMPTY_1']) || 0,
        foreign: Number(row['__EMPTY_2']) || 0,
        note: row['__EMPTY_3'] || ''
      });
    }
  });

  // ②③ 거점→숙소 / 숙소→거점 매트릭스: 권역 라벨(헤더 행) + 거점별 분포
  const parseMatrix = sheetKey => {
    const rows = luggageFlowData[sheetKey] || [];
    const headerRow = rows.find(r => getRowLabel(r).includes('출발 거점'));
    const regions = headerRow
      ? REGION_COLS.map(k => String(headerRow[k] || '').replace(/\r?\n/g, ' ').trim()).filter(Boolean)
      : [];
    const hubs = rows
      .filter(r => HUBS.includes(getRowLabel(r)))
      .map(r => ({
        hub: getRowLabel(r),
        hubShare: Number(r['__EMPTY']) || 0,
        dist: REGION_COLS.map(k => Number(r[k]) || 0)
      }));
    return { regions, hubs };
  };

  const dKey = Object.keys(luggageFlowData).find(k => k.replace(/\s/g, '').includes('거점→숙소'));
  const pKey = Object.keys(luggageFlowData).find(k => k.replace(/\s/g, '').includes('숙소→거점'));
  if (dKey) {
    const m = parseMatrix(dKey);
    summary.regions = m.regions;
    summary.delivery = m.hubs;
  }
  if (pKey) {
    summary.pickup = parseMatrix(pKey).hubs;
  }
  return summary;
}

// 3. Get Excel Luggage Flow Summaries (raw sheets + normalized chart summary)
app.get('/api/luggage-flow', (req, res) => {
  res.json({ data: luggageFlowData, summary: buildLuggageSummary() });
});

// 4. Barrier-free Routing and Conflict Scorer (Dijkstra-based)
app.get('/api/route', async (req, res) => {
  const { start, end, time, mode, weather: simWeather, day } = req.query; // mode = 'shortest' | 'barrier_free'
  if (!start || !end) {
    return res.status(400).json({ error: 'Missing start or end station' });
  }

  const targetTime = time || '18시-19시';
  const routingMode = mode || 'barrier_free';
  const dayType = day === 'weekend' ? 'weekend' : 'weekday';

  // 1. Fetch real-time weather
  const weather = { ...(await getRealTimeWeather()) };
  
  // Weather simulation override for testing
  if (simWeather === 'rain' || simWeather === 'snow' || simWeather === 'bad') {
    weather.isBad = true;
    weather.condition = simWeather === 'rain' ? '비 (시뮬레이션)' : (simWeather === 'snow' ? '눈 (시뮬레이션)' : '뇌우 (시뮬레이션)');
    weather.icon = simWeather === 'rain' ? '🌧️' : (simWeather === 'snow' ? '❄️' : '⚡');
    weather.precip = 5.5;
  }

  // Backup global weather state and override temporarily for pathfinding
  const originalIsBad = cachedWeather ? cachedWeather.isBad : false;
  if (cachedWeather) {
    cachedWeather.isBad = weather.isBad;
  } else {
    cachedWeather = { isBad: weather.isBad };
  }

  // Run Dijkstra
  const routeResult = findShortestPath(start, end, routingMode, targetTime, dayType);
  
  // Restore original weather state
  if (cachedWeather) {
    cachedWeather.isBad = originalIsBad;
  }

  if (!routeResult) {
    return res.status(404).json({ error: 'Path not found between the specified stations' });
  }

  const pathDetails = routeResult.path;
  const startStation = pathDetails[0];
  const endStation = pathDetails[pathDetails.length - 1];

  // 1. Identify broken elevators along the path
  const brokenStations = [];
  pathDetails.forEach(node => {
    if (activeBrokenElevators.has(node.id)) {
      const targetNormName = normalizeStationName(node.name);
      const detour = elevatorDetours.find(d => 
        d['역번호'] === node.id || normalizeStationName(d['역명']) === targetNormName
      );
      if (detour) {
        brokenStations.push({
          id: node.id,
          name: node.name,
          line: node.line,
          detour: detour
        });
      }
    }
  });

  // 2. Identify platform gap hazards along the path
  const gapStations = [];
  pathDetails.forEach(node => {
    if (node.gaps && node.gaps.length > 0) {
      const hasWide = node.gaps.some(g => g['연단간격'] && g['연단간격'].includes('넓음'));
      if (hasWide) {
        gapStations.push({
          id: node.id,
          name: node.name,
          line: node.line,
          gaps: node.gaps.filter(g => g['연단간격'].includes('넓음'))
        });
      }
    }
  });

  // 3. Compute Congestion Stats
  let startCongestion = 0;
  let endCongestion = 0;
  let pathCongestionSum = 0;
  let maxCongestionVal = 0;

  const startNorm = normalizeStationName(startStation.name);
  const endNorm = normalizeStationName(endStation.name);

  startCongestion = getRidership(startNorm, dayType, '승차', targetTime) || 500;
  endCongestion = getRidership(endNorm, dayType, '하차', targetTime) || 500;

  pathDetails.forEach(node => {
    const norm = normalizeStationName(node.name);
    const boarding = getRidership(norm, dayType, '승차', targetTime);
    const alighting = getRidership(norm, dayType, '하차', targetTime);
    const total = boarding + alighting;
    pathCongestionSum += total;
    if (total > maxCongestionVal) {
      maxCongestionVal = total;
    }
  });

  const avgPathCongestion = pathDetails.length > 0 ? Math.round(pathCongestionSum / pathDetails.length) : 500;

  // 4. Compute Conflict Score
  // Combine average path congestion, max bottleneck, and escalator/elevator issues
  const scoreMetric = (avgPathCongestion * 0.4) + (maxCongestionVal * 0.6);
  let conflictScore = Math.min(Math.round((scoreMetric / 3500) * 100), 100);

  // If there are broken elevators or wide gaps, increase conflict score in barrier-free mode
  if (routingMode === 'barrier_free') {
    if (brokenStations.length > 0) {
      conflictScore = Math.min(conflictScore + 20, 100);
    }
    if (gapStations.length > 0) {
      conflictScore = Math.min(conflictScore + 10, 100);
    }
  }

  // 4-1. nocarrier-core ML 서비스(LightGBM 혼잡 예측 → 자원충돌점수)로 대체 시도.
  // ML 서비스(:3300)가 꺼져 있거나 커버리지 밖이면 위 휴리스틱 점수를 그대로 사용한다.
  let conflictEngine = 'heuristic';
  let mlConflict = null;
  try {
    const mlIds = pathDetails
      .filter(n => !n.supplementary)
      .map(n => parseInt(n.id, 10))
      .filter(Number.isFinite);
    if (mlIds.length > 0) {
      // 사용자가 고른 '이동 예정 시간대'와 평일/주말을 LightGBM 예측 시점으로 변환.
      // (넘기지 않으면 ML 서비스가 현재 시각 기준으로 예측해, 시간대를 바꿔도 점수가 같아진다)
      const mlTimestamp = (() => {
        const d = new Date();
        const dow = d.getDay();
        if (dayType === 'weekend' && dow !== 0 && dow !== 6) {
          d.setDate(d.getDate() + (6 - dow));           // 다음 토요일
        } else if (dayType === 'weekday' && (dow === 0 || dow === 6)) {
          d.setDate(d.getDate() + (dow === 6 ? 2 : 1)); // 다음 월요일
        }
        const hourMatch = /^(\d{1,2})시/.exec(targetTime || '');
        if (hourMatch) d.setHours(parseInt(hourMatch[1], 10), 30, 0, 0); // 시간대 중앙(HH:30)
        const p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
      })();
      const mlResp = await axios.post(`${ML_SERVICE_URL}/route-conflict`, { stations: mlIds, timestamp: mlTimestamp }, { timeout: 8000 });
      if (mlResp.data && typeof mlResp.data.routeScore === 'number') {
        mlConflict = mlResp.data;
        conflictScore = mlResp.data.routeScore;
        // 배리어프리 모드의 실시간 상황 가중(고장 엘리베이터·연단간격)은 ML 점수 위에도 유지
        if (routingMode === 'barrier_free') {
          if (brokenStations.length > 0) conflictScore = Math.min(conflictScore + 20, 100);
          if (gapStations.length > 0) conflictScore = Math.min(conflictScore + 10, 100);
        }
        conflictEngine = 'lightgbm';
      }
    }
  } catch (err) {
    // ML 서비스 미기동/오류 → 휴리스틱 유지 (로그만 남김)
    if (!global.__mlWarned) {
      global.__mlWarned = true;
      console.warn(`⚠️ ML 서비스(${ML_SERVICE_URL}) 미사용 — 휴리스틱 충돌점수로 동작: ${err.message}`);
    }
  }

  let conflictLevel = 'SAFE';
  if (conflictScore > 75) {
    conflictLevel = 'CRITICAL (HIGH CONFLICT)';
  } else if (conflictScore > 40) {
    conflictLevel = 'WARNING (MODERATE CONFLICT)';
  }

  // ── 짐 소지 vs 빈손 비교 시뮬레이션 ──
  // 같은 출발-도착을 짐 가중치(환승·연단·혼잡 부담 증가)를 켠 상태로 다시 풀고,
  // 엘리베이터 의존 증가분(×1.25 + 8)을 반영한 충돌 점수를 산출해 나란히 비교한다.
  let luggageImpact = null;
  const luggageRoute = findShortestPath(start, end, routingMode, targetTime, dayType, true);
  if (luggageRoute) {
    let lugSum = 0, lugMax = 0;
    luggageRoute.path.forEach(node => {
      const norm = normalizeStationName(node.name);
      const t = getRidership(norm, dayType, '승차', targetTime) + getRidership(norm, dayType, '하차', targetTime);
      lugSum += t;
      if (t > lugMax) lugMax = t;
    });
    const lugAvg = luggageRoute.path.length > 0 ? lugSum / luggageRoute.path.length : 500;
    const lugMetric = (lugAvg * 0.4) + (lugMax * 0.6);
    // 비교 전용 부하 지수: 포화 없는 압축 곡선 100·m/(m+3000) 사용 —
    // 피크 시간대에도 양쪽이 100으로 눌리지 않고 짐 소지 가중(×1.25+8)의 차이가 드러난다
    const loadIdx = m => 100 * m / (m + 3000);
    const boost = (routingMode === 'barrier_free' ? (brokenStations.length > 0 ? 10 : 0) + (gapStations.length > 0 ? 5 : 0) : 0);
    const freeIdx = Math.min(Math.round(loadIdx(scoreMetric)) + boost, 100);
    const lugIdx = Math.min(Math.round(loadIdx(lugMetric) * 1.25) + 8 + boost, 100);
    const lugTransfers = luggageRoute.path.filter(n => n.edgeType === 'transfer').length;
    const freeTransfers = pathDetails.filter(n => n.edgeType === 'transfer').length;
    luggageImpact = {
      withLuggage: { conflictScore: lugIdx, cost: Math.round(luggageRoute.cost * 10) / 10, transfers: lugTransfers, stations: luggageRoute.path.length },
      handsFree: { conflictScore: freeIdx, cost: Math.round(routeResult.cost * 10) / 10, transfers: freeTransfers, stations: pathDetails.length },
      scoreDropPct: lugIdx > 0 ? Math.round((1 - freeIdx / lugIdx) * 100) : 0
    };
  }

  // Recommendation message
  let recommendation = '이동 경로상 편의시설이 원활합니다. 가방을 소지하고 이동하셔도 무방합니다.';
  if (conflictLevel === 'CRITICAL (HIGH CONFLICT)') {
    recommendation = `이 시간대는 경로 상 승하차객이 매우 혼잡하고, 엘리베이터 지연 및 이동 부하가 극심합니다. 짐캐리의 당일 수하물 배송 서비스를 활용하여 무거운 짐 없는 '빈손 여행'을 적극 권장합니다.`;
  } else if (conflictLevel === 'WARNING (MODERATE CONFLICT)') {
    recommendation = `일부 역사의 혼잡도 상승이 예상됩니다. 휠체어나 캐리어 소지 시 무리한 승차를 피하고 안전 연단간격 유의 및 우회 안내 경로를 준수하세요.`;
  }

  res.json({
    start: startStation,
    end: endStation,
    path: pathDetails,
    mode: routingMode,
    cost: routeResult.cost,
    brokenStation: brokenStations.length > 0 ? {
      name: brokenStations[0].name,
      detour: brokenStations[0].detour
    } : null,
    brokenStations: brokenStations,
    gapStations: gapStations,
    congestion: {
      time: targetTime,
      dayType: dayType,
      start: startCongestion,
      end: endCongestion,
      average: avgPathCongestion,
      max: maxCongestionVal
    },
    conflict: {
      score: conflictScore,
      level: conflictLevel,
      recommendation: recommendation,
      engine: conflictEngine, // 'lightgbm'(nocarrier-core) | 'heuristic'(폴백)
      ml: mlConflict ? {
        worstStation: mlConflict.worstStation,
        coverage: mlConflict.coverage,
        stations: mlConflict.stations.map(s => ({
          stationId: s.stationId, name: s.name,
          predictedVolume: s.predictedVolume, congestionLevel: s.congestionLevel,
          eventSpike: s.eventSpike, conflictScore: s.conflictScore
        }))
      } : null
    },
    weather: weather,
    fare: calculateFare(pathDetails),
    luggageImpact: luggageImpact
  });
});

// ─────────────────────────────────────────────────────────────────
// "맡길까? 보낼까?" — 물품보관함 vs 짐캐리 배송 의사결정 도우미
// OT 발제자료 기준: 거점 = 부산역·김해국제공항·부산항국제여객터미널(짐캐리 오피스)
// 락커 요금 = 부산교통공사 물품보관함 CSV의 실제 요금(3시간당) 파싱
// ─────────────────────────────────────────────────────────────────
const ADVICE_HUBS = {
  busan_station: { stationId: '113', label: '부산역 짐캐리 센터', flowKey: '부산역' },
  gimhae_airport: { stationId: '804', label: '김해국제공항 짐캐리 카운터', flowKey: '김해국제공항' },
  intl_terminal: { stationId: '112', label: '부산항국제여객터미널 (중앙역 인근)', flowKey: '부산항 국제여객터미널' }
};

// 짐캐리 국내 여행짐 배송 공식 요금 (zimcarry.net 배송요금, 수하물 개당 기본요금)
// S(최장변 55cm 이하) 12,000 / M(70cm 미만) 16,000 / L(70cm 이상) 20,000
// 기내용 캐리어까지 S, 24~26" 화물용 캐리어는 M, 28"+ 대형 캐리어·골프백은 L
const DELIVERY_FARE = { small: 12000, medium: 12000, large: 16000, xlarge: 20000 };
const ZIM_SIZE = { small: 'S', medium: 'S', large: 'M', xlarge: 'L' };
// 짐캐리 추가요금 (부산, 개당): 김해공항 +4,000 / 송정·기장 지역 +3,000
const HUB_EXTRA_FEE = { gimhae_airport: 4000 };
const SIZE_LABEL = { small: '소형', medium: '중형', large: '대형', xlarge: '특대형' };
const SIZE_FEE_KEY = { small: '소', medium: '중', large: '대', xlarge: '특대' };
const SIZE_COUNT_COL = { small: '소형(개수)', medium: '중형(개수)', large: '대형(개수)', xlarge: '특대형(개수)' };

// 짐캐리 무인보관함 (zimcarry.net / 기획보고서: 부산 3개소) — 역사 좌표 데이터에 없는 지점이라 별도 관리.
// 요금: 기본 4시간 + 12시간마다 추가 (소 2,000 / 중 3,000 / 대·특대 4,000)
const ZIMCARRY_LOCKER_FEE = { small: 2000, medium: 3000, large: 4000, xlarge: 4000 };
const ZIMCARRY_LOCKERS = {
  '해운대·기장': { name: '씨클라우드호텔 짐캐리 무인보관함', location: '해운대 씨클라우드호텔 1층 로비', count: 16 },
  '원도심(동구·중구)': { name: '롯데면세점 부산 짐캐리 무인보관함', location: '롯데면세점 부산 8층 안내데스크 옆', count: 25 },
  '광안리': null, '서면·부산진구': null, '기타': null,
};
// 짐캐리 무인보관함 총액: 기본 4h + 초과분 12h 단위 추가
function zimcarryLockerTotal(size, hours) {
  const fee = ZIMCARRY_LOCKER_FEE[size] || ZIMCARRY_LOCKER_FEE.large;
  const extraUnits = hours <= 4 ? 0 : Math.ceil((hours - 4) / 12);
  return { fee, units: 1 + extraUnits, total: fee * (1 + extraUnits) };
}

// 락커 이용요금 문자열 파싱: "특대: 6,000원 / 대:4,000원 / 중: 3,000원 / 소: 2,000원(3시간당)"
function parseLockerFees(feeStr) {
  const fees = {};
  const re = /(특대|대|중|소)\s*:?\s*([\d,]+)\s*원/g;
  let m;
  while ((m = re.exec(String(feeStr || '')))) {
    fees[m[1]] = parseInt(m[2].replace(/,/g, ''), 10);
  }
  return fees;
}

app.get('/api/luggage-advice', (req, res) => {
  const hubKey = ADVICE_HUBS[req.query.hub] ? req.query.hub : 'busan_station';
  const size = DELIVERY_FARE[req.query.size] ? req.query.size : 'large';
  const hours = Math.min(72, Math.max(1, parseInt(req.query.hours, 10) || 6));
  const destRegion = req.query.region || '';

  const hub = ADVICE_HUBS[hubKey];
  const hubStation = stationsMap[hub.stationId];

  // ① 보관함 옵션 — 목적지 권역에 짐캐리 무인보관함이 있으면 그것을 우선, 없으면 공사 물품보관함
  let lockerOption = { available: false, reason: '해당 역사에 물품보관함 정보가 없습니다.' };
  const zimLocker = ZIMCARRY_LOCKERS[destRegion];
  if (zimLocker) {
    // 짐캐리 무인보관함 (권역 내 운영 — 요금: 기본 4h + 12h마다 추가)
    const z = zimcarryLockerTotal(size, hours);
    lockerOption = {
      available: true,
      provider: 'zimcarry',
      name: zimLocker.name,
      location: zimLocker.location,
      operator: '짐캐리',
      sizeCount: zimLocker.count,
      feePer3h: z.fee,          // 표시 호환용(실제 단위는 아래 unit 필드)
      unitLabel: '기본 4시간 + 12시간마다',
      periods: z.units,
      total: z.total,
    };
  } else {
    // 공사 물품보관함 CSV 실데이터 (거점역 기준)
    const locker = hubStation && hubStation.lockers && hubStation.lockers[0];
    if (locker) {
      const fees = parseLockerFees(locker['이용요금']);
      const fee = fees[SIZE_FEE_KEY[size]];
      const count = parseInt(locker[SIZE_COUNT_COL[size]], 10) || 0;
      if (!fee || count === 0) {
        lockerOption = { available: false, reason: `${displayName(hubStation.name)}역 보관함에 ${SIZE_LABEL[size]} 칸이 없습니다.` };
      } else {
        const periods = Math.max(1, Math.ceil(hours / 3));
        lockerOption = {
          available: true,
          provider: 'metro',
          station: hubStation.name,
          location: locker['상세위치'] || '',
          operator: locker['운영사'] || '',
          sizeCount: count,
          feePer3h: fee,
          unitLabel: '3시간당',
          periods,
          total: fee * periods
        };
      }
    }
  }

  // ② 짐캐리 배송 옵션 (짐캐리 공식 배송요금 + 방향별 흐름 실데이터)
  const summary = buildLuggageSummary();
  const hubFlow = summary.delivery.find(h => h.hub === hub.flowKey);
  const regionIdx = summary.regions.indexOf(destRegion);
  const baseFare = DELIVERY_FARE[size];
  const extraFee = HUB_EXTRA_FEE[hubKey] || 0;
  const surcharges = [];
  if (extraFee) surcharges.push(`김해공항 추가요금 +${extraFee.toLocaleString()}원/개 포함`);
  if (destRegion === '해운대·기장') surcharges.push('송정·기장 지역 배송 시 +3,000원/개 추가');
  const deliveryOption = {
    fare: baseFare + extraFee,
    baseFare,
    extraFee,
    zimSize: ZIM_SIZE[size],
    surcharges,
    hubLabel: hub.label,
    note: '매장 접수는 15시 마감, 당일 16시부터 숙소 순차 도착 (짐캐리 공식 배송요금 기준)',
    flowStat: hubFlow ? {
      hubShare: Math.round(hubFlow.hubShare * 1000) / 10,
      regionShare: regionIdx >= 0 ? Math.round(hubFlow.dist[regionIdx] * 1000) / 10 : null,
      region: destRegion || null
    } : null
  };

  // ③ 추천 로직
  let recommendation, reasons = [];
  if (!lockerOption.available) {
    recommendation = 'delivery';
    reasons.push(lockerOption.reason);
    reasons.push('숙소로 바로 배송받아 빈손으로 관광을 시작할 수 있습니다.');
  } else if (hours >= 24) {
    recommendation = 'delivery';
    reasons.push(`체류 ${hours}시간(1박 이상)은 보관함 비용이 ${lockerOption.total.toLocaleString()}원까지 누적됩니다.`);
    reasons.push('숙박 여행은 숙소 직배송이 비용·동선 모두 유리합니다.');
  } else if (lockerOption.total < deliveryOption.fare) {
    recommendation = 'locker';
    reasons.push(`체류 ${hours}시간 기준 보관함(${lockerOption.total.toLocaleString()}원)이 배송(${deliveryOption.fare.toLocaleString()}원)보다 ${(deliveryOption.fare - lockerOption.total).toLocaleString()}원 저렴합니다.`);
    reasons.push('단, 짐을 찾으러 거점역을 다시 방문해야 합니다.');
  } else {
    recommendation = 'delivery';
    reasons.push(`체류 ${hours}시간 기준 보관함 비용(${lockerOption.total.toLocaleString()}원)이 배송(${deliveryOption.fare.toLocaleString()}원)과 비슷하거나 더 비쌉니다.`);
    reasons.push('같은 비용이면 거점 재방문이 없는 숙소 직배송이 동선에서 유리합니다.');
  }

  res.json({ hub: hubKey, size, hours, lockerOption, deliveryOption, recommendation, reasons });
});

function displayName(name) {
  return String(name || '').replace(/\([^)]*\)/g, '').trim();
}

// ─────────────────────────────────────────────────────────────────
// AI 여행 어시스턴트 프록시 — Python RAG 서비스(assistant_service.py, :3200)로 중계
// 부산 관광 데이터 기반 RAG 파이프라인
// ─────────────────────────────────────────────────────────────────
const ASSISTANT_URL = process.env.ASSISTANT_URL || 'http://localhost:3200';
const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://localhost:3300';

app.post('/api/assistant', async (req, res) => {
  try {
    const response = await axios.post(`${ASSISTANT_URL}/ask`, req.body, { timeout: 120000 });
    res.json(response.data);
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ error: 'AI 어시스턴트 서비스가 꺼져 있습니다. `python backend/assistant_service.py`로 실행해주세요.' });
    }
    const data = err.response?.data;
    res.status(err.response?.status || 502).json(data || { error: `어시스턴트 호출 실패: ${err.message}` });
  }
});

// 페르소나 기반 여행 일정 생성 (sdbwork/JimCarry_Busan 이식 — 짐 조건 → 일자별 일정)
app.post('/api/tour-plan', async (req, res) => {
  try {
    const response = await axios.post(`${ASSISTANT_URL}/tour-plan`, req.body, { timeout: 180000 });
    res.json(response.data);
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ error: 'AI 어시스턴트 서비스가 꺼져 있습니다. `python backend/assistant_service.py`로 실행해주세요.' });
    }
    res.status(err.response?.status || 502).json(err.response?.data || { error: `일정 생성 실패: ${err.message}` });
  }
});

// 프론트 설정값 (카카오맵 JS 키 등 — 공개 가능한 클라이언트 키만)
app.get('/api/config', (req, res) => {
  res.json({ kakaoMapKey: process.env.KAKAO_MAP_JS_KEY || null });
});

app.get('/api/assistant/health', async (req, res) => {
  try {
    const response = await axios.get(`${ASSISTANT_URL}/health`, { timeout: 5000 });
    res.json({ running: true, ...response.data });
  } catch {
    res.json({ running: false });
  }
});

// ─────────────────────────────────────────────────────────────────
// Web-Trend × Persona Nudge Engine
// Reads live trends from a keyless public source (Google News RSS) and
// maps them onto persona-tailored local nudges, with a curated fallback
// so the demo always renders.
// ─────────────────────────────────────────────────────────────────
const trendCache = {}; // { [persona]: { payload, ts } }
const TREND_TTL_MS = 30 * 60 * 1000;

// Search query used to pull live headlines per persona
const PERSONA_TREND_QUERY = {
  domestic: '부산 서면 맛집 카페 여행',
  foreign: '부산 관광 명소 여행 축제',
  event: '부산 벡스코 사직 콘서트 축제 행사'
};

// Interest lexicon per persona — terms we try to detect inside live headlines
const PERSONA_LEXICON = {
  domestic: ['밀면', '돼지국밥', '전포', '카페거리', '디저트', '광안리', '서면', '전리단길', '해리단길', '카페', '베이커리', '수제버거', '국밥', '해수욕장', '야시장', '포장마차'],
  foreign: ['감천문화마을', '감천', '자갈치', '해동용궁사', '용궁사', 'BIFF', '남포동', '국제시장', '태종대', '한복', '전통', '해운대', '광안대교', '부산타워'],
  event: ['벡스코', 'BEXCO', '사직', '야구', '콘서트', '불꽃축제', '전시', '컨벤션', '축제', '공연', '페스티벌', '아시아드', '경기']
};

// 트렌드 키워드 중 특정 지역·상권 지명 — 선택한 역과 무관한 동네면 제목·검색이 어긋나므로
// 그 역 근처일 때만 사용하고, 아니면 일반 키워드로 대체한다
const LOCATION_KEYWORDS = ['서면', '전포', '광안리', '전리단길', '해리단길', '카페거리', '감천', '자갈치', '해동용궁사', '용궁사', '남포동', '국제시장', '태종대', '해운대', '광안대교', '부산타워', '벡스코', 'BEXCO', '사직', '아시아드', 'BIFF', '해수욕장'];
const GENERIC_TREND_FILL = {
  domestic: ['밀면', '돼지국밥', '카페', '디저트'],
  foreign: ['길거리 음식', '전통시장', '한식', 'K-디저트'],
  event: ['야구', '콘서트', '전시', '축제']
};

// Curated fallback trends (used when live fetch fails or yields nothing)
const PERSONA_FALLBACK = {
  domestic: [
    { keyword: '밀면', headline: '무더위에 다시 뜨는 부산 밀면 맛집' },
    { keyword: '전포 카페거리', headline: '전포 카페거리, 디저트 성지로 인기' },
    { keyword: '광안리', headline: '광안리 해변 산책·소품샵 나들이 인기' },
    { keyword: '돼지국밥', headline: '부산 대표 돼지국밥 노포 재조명' }
  ],
  foreign: [
    { keyword: '감천문화마을', headline: 'Gamcheon Culture Village tops foreign must-visit list' },
    { keyword: '자갈치', headline: 'Jagalchi Market street food draws travelers' },
    { keyword: '해동용궁사', headline: 'Haedong Yonggungsa seaside temple in spotlight' },
    { keyword: 'BIFF', headline: '남포동 BIFF 광장 K-culture 체험 인기' }
  ],
  event: [
    { keyword: '벡스코', headline: '벡스코 대형 컨벤션·전시 잇따라 개최' },
    { keyword: '사직 야구', headline: '사직구장 프로야구 직관 열기 고조' },
    { keyword: '불꽃축제', headline: '광안리 부산불꽃축제 시즌 임박' },
    { keyword: '콘서트', headline: '아시아드 주경기장 대형 콘서트 예정' }
  ]
};

// Persona nudge templates — {kw} is replaced by a live trend keyword
const NUDGE_TEMPLATES = {
  domestic: [
    { icon: '🍜', shop: '로컬 맛집', coupon: 'LOCAL_TREND', title: "요즘 뜨는 '{kw}' 로컬 맛집", desc: '실시간 트렌드 기반 역세권 맛집 추천' },
    { icon: '🍰', shop: '역세권 카페', coupon: 'DESSERT_HOT', title: "'{kw}' 감성 카페·디저트", desc: 'SNS 트렌드 기반 추천 방문 코스' }
  ],
  foreign: [
    { icon: '🏛️', shop: 'K-Culture 명소', coupon: 'KCULTURE', title: "Trending now: '{kw}'", desc: 'Hands-free traveler recommendation from live travel trends' },
    { icon: '🐟', shop: '전통시장 먹거리', coupon: 'MARKET_HOT', title: "화제의 '{kw}' 먹거리 체험", desc: '실시간 여행 트렌드 연동 로컬 체험 추천' }
  ],
  event: [
    { icon: '🎟️', shop: '이벤트 인근 F&B', coupon: 'EVENT_HOT', title: "'{kw}' 관람 전후 들르기 좋은 곳", desc: '행사·경기 트렌드 연동 빈손 관람 추천' },
    { icon: '🍺', shop: '경기장 인근 상권', coupon: 'GAMEDAY', title: "'{kw}' 직관 후 뒤풀이 명소", desc: '무거운 짐은 보관, 이벤트는 가볍게' }
  ]
};

function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&quot;/g, '"');
}

// Pull <item><title> headlines out of an RSS/XML string
function extractRssHeadlines(xml, limit = 12) {
  const headlines = [];
  const itemRe = /<item[\s\S]*?<\/item>/g;
  const titleRe = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/;
  let item;
  while ((item = itemRe.exec(xml)) && headlines.length < limit) {
    const t = titleRe.exec(item[0]);
    if (t && t[1]) {
      // Google News titles look like "헤드라인 - 매체" — keep the headline part
      const headline = decodeXmlEntities(t[1]).split(' - ')[0].trim();
      if (headline) headlines.push(headline);
    }
  }
  return headlines;
}

// Detect persona-relevant keywords inside live headlines
function detectTrends(persona, headlines) {
  const lexicon = PERSONA_LEXICON[persona] || [];
  const found = [];
  const seen = new Set();
  for (const h of headlines) {
    for (const kw of lexicon) {
      if (h.includes(kw) && !seen.has(kw)) {
        seen.add(kw);
        found.push({ keyword: kw, headline: h });
        break;
      }
    }
    if (found.length >= 4) break;
  }
  return found;
}

function buildNudges(persona, trends, stationName) {
  const templates = NUDGE_TEMPLATES[persona] || NUDGE_TEMPLATES.domestic;
  const kws = trends.map(t => t.keyword);
  const nudges = [];
  kws.forEach((kw, i) => {
    const tpl = templates[i % templates.length];
    nudges.push({
      id: i + 1,
      icon: tpl.icon,
      title: tpl.title.replace('{kw}', kw),
      shop: `${stationName || '부산'} · ${tpl.shop}`,
      coupon: `${tpl.coupon}_${kw.replace(/\s/g, '').slice(0, 6).toUpperCase()}`,
      desc: tpl.desc,
      trendKeyword: kw,
      generic: !!trends[i].generic // 채움용 일반 키워드 여부 (제목 재작성 대상)
    });
  });
  return nudges;
}

async function getPersonaTrends(persona) {
  const key = PERSONA_TREND_QUERY[persona] ? persona : 'domestic';
  const now = Date.now();
  if (trendCache[key] && (now - trendCache[key].ts < TREND_TTL_MS)) {
    return trendCache[key].payload;
  }

  let trends = [];
  let source = 'fallback';
  try {
    const q = encodeURIComponent(PERSONA_TREND_QUERY[key]);
    const url = `https://news.google.com/rss/search?q=${q}&hl=ko&gl=KR&ceid=KR:ko`;
    const response = await axios.get(url, {
      timeout: 4500,
      responseType: 'text',
      transformResponse: [d => d],
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZimcarryBot/1.0)' }
    });
    const headlines = extractRssHeadlines(String(response.data));
    const detected = detectTrends(key, headlines);
    if (detected.length > 0) {
      trends = detected;
      source = 'live';
    }
  } catch (err) {
    console.error('❌ Trend fetch failed:', err.message);
  }

  if (trends.length === 0) {
    trends = PERSONA_FALLBACK[key];
    source = 'fallback';
  }

  const payload = { persona: key, source, trends, generatedAt: new Date().toISOString() };
  trendCache[key] = { payload, ts: now };
  console.log(`📈 Trends for '${key}': ${source} (${trends.length} items)`);
  return payload;
}

// ─────────────────────────────────────────────────────────────────
// 네이버 지역검색 API — 트렌드 키워드 × 역 주변 실존 상점 검색
// (developers.naver.com 검색 API, 일 25,000건 무료)
// 키가 없거나 실패하면 기존 템플릿 상호로 폴백 → placeSource로 구분 표시
// ─────────────────────────────────────────────────────────────────
const placeCache = {}; // { `${station}:${keyword}`: { items, ts } }
const PLACE_TTL_MS = 30 * 60 * 1000;

async function searchNaverPlaces(stationName, keyword) {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const cacheKey = `${stationName}:${keyword}`;
  const now = Date.now();
  if (placeCache[cacheKey] && now - placeCache[cacheKey].ts < PLACE_TTL_MS) {
    return { items: placeCache[cacheKey].items, term: placeCache[cacheKey].term };
  }

  const queryOnce = async (term) => {
    const q = encodeURIComponent(`부산 ${stationName}역 ${term}`);
    const resp = await axios.get(`https://openapi.naver.com/v1/search/local.json?query=${q}&display=3&sort=comment`, {
      timeout: 4000,
      headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret }
    });
    return (resp.data.items || []).map(it => ({
      name: String(it.title || '').replace(/<[^>]+>/g, ''),
      category: it.category || '',
      address: it.roadAddress || it.address || '',
      tel: it.telephone || '',
      link: it.link || ''
    })).filter(p => p.name);
  };

  // 지역검색은 초당 호출 제한이 엄격해 429가 나면 잠시 대기 후 1회 재시도
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const queryWithBackoff = async (term) => {
    try {
      return await queryOnce(term);
    } catch (err) {
      if (err.response?.status === 429) {
        await sleep(500);
        return await queryOnce(term);
      }
      throw err;
    }
  };

  try {
    // 키워드가 역명과 겹치면(예: 서면역 × '서면') 검색어가 중복돼 결과가 없으므로 일반어로 대체
    let term = (keyword.includes(stationName) || stationName.includes(keyword)) ? '맛집' : keyword;
    let items = await queryWithBackoff(term);
    // 키워드 검색 결과가 없으면 일반어로 재시도 (사용된 term을 함께 반환해 제목 재작성에 활용)
    if (items.length === 0 && term !== '맛집') {
      await sleep(150);
      term = '맛집';
      items = await queryWithBackoff(term);
    }
    const result = { items, term };
    placeCache[cacheKey] = { ...result, ts: now };
    return result;
  } catch (err) {
    console.error('❌ Naver local search failed:', err.response?.status || err.message);
    return null;
  }
}

// 네이버 이미지검색 — 상점명으로 실제 가게 사진(썸네일) 1장 조회
const imageCache = {}; // { query: { url, ts } }

async function searchNaverImage(query) {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const now = Date.now();
  if (imageCache[query] && now - imageCache[query].ts < PLACE_TTL_MS) {
    return imageCache[query].url;
  }

  try {
    const q = encodeURIComponent(query);
    const resp = await axios.get(`https://openapi.naver.com/v1/search/image?query=${q}&display=1&sort=sim&filter=medium`, {
      timeout: 4000,
      headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret }
    });
    // thumbnail은 네이버 CDN(search.pstatic.net)이라 핫링크가 안정적
    const url = resp.data.items?.[0]?.thumbnail || null;
    imageCache[query] = { url, ts: now };
    return url;
  } catch (err) {
    console.error('❌ Naver image search failed:', err.response?.status || err.message);
    return null;
  }
}

// Web-trend + persona nudge endpoint
app.get('/api/trends', async (req, res) => {
  const persona = req.query.persona || 'domestic';
  const station = req.query.station || '';
  const payload = await getPersonaTrends(persona);
  const stationDisplay = station.replace(/\([^)]*\)/g, '').trim();

  // 다른 동네 지명 키워드는 제외 (예: 사하역인데 '전포' 추천 방지) — 그 역 근처 지명만 통과
  const isLocKw = kw => LOCATION_KEYWORDS.some(l => kw.includes(l));
  const nearStation = kw => stationDisplay && (stationDisplay.includes(kw) || kw.includes(stationDisplay));
  let usableTrends = payload.trends.filter(t => !isLocKw(t.keyword) || nearStation(t.keyword));
  // 살아남은 키워드가 부족하면 페르소나 일반 키워드(밀면·카페 등)로 채움
  const fills = (GENERIC_TREND_FILL[payload.persona] || []).filter(k => !usableTrends.some(t => t.keyword === k));
  while (usableTrends.length < 2 && fills.length > 0) {
    usableTrends.push({ keyword: fills.shift(), headline: '', generic: true });
  }

  const nudges = buildNudges(payload.persona, usableTrends, station);

  // 트렌드 키워드별로 역 주변 실존 상점을 붙인다 (네이버 지역검색)
  // ※ 초당 호출 제한(429) 회피를 위해 병렬이 아닌 순차 호출 (캐시 히트 시 즉시 반환)
  let placeSource = 'template';
  if (stationDisplay) {
    const usedNames = new Set();
    for (const n of nudges) {
      const result = await searchNaverPlaces(stationDisplay, n.trendKeyword);
      if (!result || result.items.length === 0) continue;
      // 카드 간 같은 가게가 중복되지 않게 첫 미사용 상점 선택
      const pick = result.items.find(p => !usedNames.has(p.name)) || result.items[0];
      usedNames.add(pick.name);
      n.shop = pick.name;
      n.category = pick.category;
      n.address = pick.address;
      n.placeLink = pick.link;
      n.real = true;
      placeSource = 'naver';
      // 일반('맛집') 폴백으로 찾았거나 채움용 일반 키워드면 제목을 역·업종 기준으로 재작성
      if (result.term !== n.trendKeyword || n.generic) {
        const catShort = String(pick.category || '').split('>').pop().trim();
        n.title = `${stationDisplay}역 인기 ${catShort || '맛집'} 추천`;
      }
      // 실제 가게 사진 (이미지검색, 429 회피를 위해 순차 + 간격)
      await new Promise(r => setTimeout(r, 120));
      n.photo = await searchNaverImage(`부산 ${pick.name}`);
    }
  }

  // 주변 놀거리·관광지 추천 (역 기준 네이버 지역검색, 트렌드와 무관한 상시 넛지)
  const attractions = [];
  if (stationDisplay && placeSource === 'naver') {
    const seen = new Set(nudges.map(n => n.shop));
    const ATTRACTION_TERMS = [
      { term: '관광명소', icon: '🏞️', label: '관광 명소' },
      { term: '가볼만한곳', icon: '🏞️', label: '관광 명소' },
      { term: '놀거리', icon: '🎡', label: '놀거리·체험' }
    ];
    // 맛집 추천 섹션과 겹치지 않게 음식점·카페 업종은 관광지에서 제외
    const isFoodCategory = c => /^(음식점|카페)/.test(String(c || ''));
    for (const { term, icon, label } of ATTRACTION_TERMS) {
      if (attractions.length >= 4) break;
      await new Promise(r => setTimeout(r, 150));
      const result = await searchNaverPlaces(stationDisplay, term);
      if (!result) continue;
      for (const p of result.items) {
        if (seen.has(p.name) || attractions.length >= 4 || isFoodCategory(p.category)) continue;
        seen.add(p.name);
        await new Promise(r => setTimeout(r, 120));
        attractions.push({
          icon,
          label,
          name: p.name,
          category: p.category,
          address: p.address,
          placeLink: p.link,
          photo: await searchNaverImage(`부산 ${p.name}`)
        });
      }
    }
  }

  res.json({ ...payload, station, nudges, attractions, placeSource });
});

// ─────────────────────────────────────────────────────────────────
// 부산도시철도 OpenAPI 프록시 (data.humetro.busan.kr) — 서비스명세서 기반
//  · 문화행사 정보:      /voc/api/open_api_eventinfo.tnn
//  · 장애인 편의시설 정보: /voc/api/open_api_convenience.tnn
// 요청: act(xml|json), scode(역외부코드), serviceKey
// ─────────────────────────────────────────────────────────────────
const HUMETRO_BASE = 'http://data.humetro.busan.kr/voc/api';

function getHumetroKey() {
  return process.env.HUMETRO_API_KEY || process.env.CULTURE_EVENT_API_KEY || '';
}

// Resolve 역외부코드(scode): 역 코드목록.xlsx 우선, 없으면 역번호(동일 체계) 폴백
function resolveScode(stationName) {
  const normName = normalizeStationName(stationName);
  if (stationCodeMap[normName]) return stationCodeMap[normName];
  const s = Object.values(stationsMap).find(st => normalizeStationName(st.name) === normName);
  return s ? s.id : null;
}

// Parse <item>...</item> blocks out of a humetro XML response into objects
function parseHumetroXmlItems(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  const fieldRe = /<(\w+)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const obj = {};
    let f;
    while ((f = fieldRe.exec(m[1]))) {
      obj[f[1]] = decodeXmlEntities(f[2].trim());
    }
    items.push(obj);
  }
  return items;
}

async function fetchHumetroItems(endpoint, scode, extraParams = '') {
  const key = getHumetroKey();
  const url = `${HUMETRO_BASE}/${endpoint}?act=xml&scode=${scode}&serviceKey=${key}${extraParams}`;

  // XML 선언은 UTF-8이지만 실제 본문은 EUC-KR로 내려옴(Content-Type 헤더 기준) → 바이너리로 받아 직접 디코딩
  const fetchOnce = async () => {
    const response = await axios.get(url, { timeout: 6000, responseType: 'arraybuffer' });
    const contentType = String(response.headers['content-type'] || '');
    const charset = /charset=([\w-]+)/i.exec(contentType);
    const enc = charset && /utf-?8/i.test(charset[1]) ? 'utf-8' : 'euc-kr';
    return iconv.decode(Buffer.from(response.data), enc);
  };

  let xml = await fetchOnce();
  let codeMatch = /<resultCode>(.*?)<\/resultCode>/.exec(xml);

  // humetro는 로드밸런싱 노드별 키 동기화 시차로 간헐적 30(키 미등록)을 반환 → 1회 재시도
  if (codeMatch && codeMatch[1].trim() === '30') {
    xml = await fetchOnce();
    codeMatch = /<resultCode>(.*?)<\/resultCode>/.exec(xml);
  }

  // 명세서 응답 헤더 검사: 00(NORMAL SERVICE) 정상, 03(NODATA)은 빈 목록으로 처리
  const code = codeMatch ? codeMatch[1].trim() : '00';
  if (code !== '00') {
    if (code === '03') return [];
    const msgMatch = /<resultMsg>(.*?)<\/resultMsg>/.exec(xml);
    const err = new Error(`humetro API error ${code}: ${msgMatch ? msgMatch[1] : ''}`);
    err.isApiError = true;
    throw err;
  }
  return parseHumetroXmlItems(xml);
}

// 명세서 결과항목: kind → 행사 구분
const EVENT_KIND_LABEL = { '0': '공연', '1': '전시회', '2': '캠페인', '3': '의료활동', '4': '기타' };

// Culture Events Proxy Endpoint (서비스명세서부산도시철도_문화행사정보)
app.get('/api/culture-events/:stationName', async (req, res) => {
  const apiKey = getHumetroKey();
  if (!apiKey || apiKey === 'YOUR_API_KEY_HERE') {
    return res.json({ message: '문화행사 정보를 확인하려면 API 키를 입력해주세요. (.env HUMETRO_API_KEY)' });
  }

  const scode = resolveScode(req.params.stationName);
  if (!scode) {
    return res.json({ events: [], message: '해당 역의 역외부코드(SCODE)를 찾을 수 없습니다.' });
  }

  try {
    const fmtDate = d => d.toISOString().slice(0, 10);
    const today = new Date();

    // 1차: 오늘 이후 예정 행사 조회 (명세서 sdate 파라미터)
    let items = await fetchHumetroItems('open_api_eventinfo.tnn', scode, `&sdate=${fmtDate(today)}&numOfRows=10&pageNo=1`);
    let scope = 'upcoming';

    // 2차: 예정 행사가 없으면 최근 1년 내 등록 행사로 폴백 (기관 데이터 등록 공백 대응)
    if (items.length === 0) {
      const yearAgo = new Date(today.getTime() - 365 * 24 * 60 * 60 * 1000);
      items = await fetchHumetroItems('open_api_eventinfo.tnn', scode, `&sdate=${fmtDate(yearAgo)}&numOfRows=50&pageNo=1`);
      // 최신 행사가 먼저 오도록 시작일 기준 내림차순 정렬 후 상위 10건
      items.sort((a, b) => String(b.idate || '').localeCompare(String(a.idate || '')));
      items = items.slice(0, 10);
      scope = 'recent';
    }

    // 행사명에 %22 같은 퍼센트 인코딩 찌꺼기가 섞여 오는 경우 복원 (구두점류만 보수적으로 치환)
    const PCT_MAP = { '%22': '"', '%27': "'", '%20': ' ', '%26': '&', '%28': '(', '%29': ')' };
    const cleanText = s => String(s || '').replace(/%2[026789]/gi, m => PCT_MAP[m.toUpperCase()] || m);

    // 명세서 필드(kind/idate/showtime/content/gbn) → 프론트 표시 필드로 매핑
    const events = items.map(it => ({
      genre: EVENT_KIND_LABEL[it.kind] || '기타',
      eventDate: it.idate || '',
      eventTime: (it.showtime || '').replace(/\s+/g, ' ').trim(),
      eventContent: cleanText(it.content),
      recurring: it.gbn === 'A', // A: 연속일자
      isPast: scope === 'recent'
    }));
    res.json({ events, scope, message: events.length > 0 ? '' : '등록된 문화행사가 없습니다.' });
  } catch (err) {
    console.error('Culture event API error:', err.message);
    if (err.isApiError) {
      return res.json({ events: [], message: `OpenAPI 응답 오류: ${err.message.replace('humetro API error ', '코드 ')}` });
    }
    res.status(500).json({ error: '문화행사 정보를 가져오는데 실패했습니다.' });
  }
});

// Accessibility Facilities Proxy Endpoint (서비스명세서부산도시철도_장애인편의시설정보)
app.get('/api/accessibility/:stationName', async (req, res) => {
  const apiKey = getHumetroKey();
  const scode = resolveScode(req.params.stationName);

  if (!apiKey || apiKey === 'YOUR_API_KEY_HERE') {
    return res.json({ facilities: null, message: '장애인 편의시설 정보를 확인하려면 API 키를 입력해주세요. (.env HUMETRO_API_KEY)' });
  }
  if (!scode) {
    return res.json({ facilities: null, message: '해당 역의 역외부코드(SCODE)를 찾을 수 없습니다.' });
  }

  try {
    const items = await fetchHumetroItems('open_api_convenience.tnn', scode);
    if (items.length === 0) {
      return res.json({ facilities: null, message: '해당 역의 편의시설 정보가 없습니다.' });
    }
    const it = items[0];
    const toNum = v => parseInt(v, 10) || 0;
    // 명세서 결과항목 매핑
    res.json({
      station: it.sname || req.params.stationName,
      facilities: {
        wheelchairLiftIn: toNum(it.wl_i),    // 휠체어리프트(내부)
        wheelchairLiftOut: toNum(it.wl_o),   // 휠체어리프트(외부)
        elevatorIn: toNum(it.el_i),          // 엘리베이터(내부)
        elevatorOut: toNum(it.el_o),         // 엘리베이터(외부)
        escalator: toNum(it.es),             // 에스컬레이터
        blindRoad: toNum(it.blindroad),      // 점자유도로
        outerRamp: toNum(it.ourbridge),      // 외부경사로
        helpBell: toNum(it.helptake),        // 도움요청벨
        toilet: toNum(it.toilet),            // 장애인화장실
        toiletType: it.toilet_gubun || ''    // 화장실 구분 (분리/공용)
      },
      message: ''
    });
  } catch (err) {
    console.error('Accessibility API error:', err.message);
    if (err.isApiError) {
      return res.json({ facilities: null, message: `OpenAPI 응답 오류: ${err.message.replace('humetro API error ', '코드 ')} — .env의 HUMETRO_API_KEY를 확인해주세요.` });
    }
    res.status(500).json({ error: '장애인 편의시설 정보를 가져오는데 실패했습니다.' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Backend API running at http://localhost:${PORT}`);
});
