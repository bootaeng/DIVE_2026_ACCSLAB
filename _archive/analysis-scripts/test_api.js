const http = require('http');

function testRoute(start, end, mode, time, weather) {
  const url = `http://localhost:3000/api/route?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&mode=${encodeURIComponent(mode)}&time=${encodeURIComponent(time)}` + (weather ? `&weather=${weather}` : '');
  console.log(`\n🔍 Fetching: ${url}`);
  
  http.get(url, (res) => {
    let rawData = '';
    res.on('data', (chunk) => { rawData += chunk; });
    res.on('end', () => {
      try {
        const parsedData = JSON.parse(rawData);
        if (res.statusCode !== 200) {
          console.error(`❌ Error (${res.statusCode}):`, parsedData.error);
          return;
        }
        console.log(`✅ Success! Mode: ${parsedData.mode}, Weather: ${parsedData.weather.condition} (${parsedData.weather.temp}°C)`);
        console.log(`📍 Path Cost: ${parsedData.cost.toFixed(2)} km`);
        console.log(`🛤️ Concise Route: ${parsedData.path[0].name} -> ${parsedData.path.length > 2 ? parsedData.path.filter(p => p.edgeType === 'transfer').map(p => p.name + ' (환승)').join(' -> ') + ' -> ' : ''}${parsedData.path[parsedData.path.length-1].name}`);
        console.log(`   (Actual total intermediate stations: ${parsedData.path.length} stations)`);
      } catch (e) {
        console.error('❌ Parse error:', e.message);
      }
    });
  }).on('error', (e) => {
    console.error('❌ HTTP error:', e.message);
  });
}

// Test weather-based routing with above-ground platforms
// Dongnae (121) to Guseo (126) has above-ground platforms.
testRoute('121', '126', 'barrier_free', '18시-19시');         // Normal weather
testRoute('121', '126', 'barrier_free', '18시-19시', 'rain'); // Rainy weather (should apply 10.0km penalty)
