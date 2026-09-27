// ==============================================================================
// Cognizant SCM - Truck Live Tracking Backend
// Step 6: OSRM Road-Based Movement + Speed-Based Route Progression
// ==============================================================================

// 1. Import necessary libraries
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

// 2. Initialize Express application & HTTP server
const app = express();
const server = http.createServer(app);

// 3. Set the port where our server will run
const PORT = process.env.PORT || 5000;

// 4. Initialize Socket.IO with permissive CORS for frontend Vite development
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// 5. Middleware setup
app.use(cors());
app.use(express.json());

// ==============================================================================
// HAVERSINE FORMULA - Calculate the great-circle distance between two GPS points
// ==============================================================================
// The Haversine formula determines the shortest distance over the Earth's
// surface between two points specified by latitude and longitude.
//
// Formula:
//   a = sin²(Δlat/2) + cos(lat1) * cos(lat2) * sin²(Δlon/2)
//   c = 2 * atan2(√a, √(1−a))
//   distance = R * c
//
// Where R = 6371 km (mean radius of Earth)
// ==============================================================================
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's mean radius in kilometers

  // Step 1: Convert latitude and longitude from degrees to radians
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  // Step 2: Apply the Haversine formula
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);

  // Step 3: Calculate the angular distance in radians
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  // Step 4: Multiply by Earth's radius to get distance in km
  return R * c;
}

// ==============================================================================
// HAVERSINE IN METERS — used for precise route segment calculations
// ==============================================================================
function haversineMeters(lat1, lon1, lat2, lon2) {
  return haversineDistance(lat1, lon1, lat2, lon2) * 1000;
}

// ==============================================================================
// CALCULATE REMAINING ROUTE DISTANCE & ETA
// Now works with the OSRM route coordinate array instead of the old 7-waypoint
// array. Sums haversine distance from current position through remaining coords.
// ==============================================================================
function calculateRouteETA(truckLat, truckLon, speed, routeCoords, routeIndex, destinationName) {
  // 1. Distance from current truck position to the next route coordinate
  let remainingKm = 0;
  if (routeIndex < routeCoords.length) {
    remainingKm = haversineDistance(
      truckLat, truckLon,
      routeCoords[routeIndex][0], routeCoords[routeIndex][1]
    );
  }

  // 2. Sum distances through all remaining route coordinates to the end
  for (let i = routeIndex; i < routeCoords.length - 1; i++) {
    remainingKm += haversineDistance(
      routeCoords[i][0], routeCoords[i][1],
      routeCoords[i + 1][0], routeCoords[i + 1][1]
    );
  }

  // 3. Calculate ETA: time = distance / speed
  // Guard against division by zero when truck is stationary
  const etaMinutes = speed > 0 ? (remainingKm / speed) * 60 : null;

  // 4. Calculate estimated arrival wall-clock time
  let estimatedArrivalTime = null;
  if (etaMinutes !== null) {
    const arrival = new Date(Date.now() + etaMinutes * 60 * 1000);
    estimatedArrivalTime = arrival.toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  }

  return {
    distanceRemainingKm: parseFloat(remainingKm.toFixed(2)),
    currentSpeed: speed,
    etaMinutes: etaMinutes !== null ? parseFloat(etaMinutes.toFixed(1)) : null,
    estimatedArrivalTime,
    destination: destinationName
  };
}

// ==============================================================================
// TRUCK ROUTE DEFINITIONS
// Each moving truck has a start point, destination point, and destination name.
// The OSRM route (real road geometry) will be fetched on server startup.
// ==============================================================================
const TRUCK_ROUTES = {
  'TR-101': {
    start: { lat: 13.0850, lon: 80.2980, name: 'Chennai Port Container Terminal' },
    end:   { lat: 12.9675, lon: 79.9450, name: 'Sriperumbudur Logistics Park' }
  },
  'TR-103': {
    start: { lat: 13.0067, lon: 80.2025, name: 'T. Nagar Depot' },
    end:   { lat: 12.8400, lon: 80.1500, name: 'Chengalpattu Distribution Hub' }
  }
};

// ==============================================================================
// OSRM ROUTE FETCHER
// Calls the public OSRM demo server to get real driving route coordinates.
// Returns an array of [lat, lon] pairs that follow actual roads.
// ==============================================================================
async function fetchOSRMRoute(startLat, startLon, endLat, endLon) {
  // OSRM expects coordinates as longitude,latitude (NOT lat,lon)
  const url = `http://router.project-osrm.org/route/v1/driving/${startLon},${startLat};${endLon},${endLat}?overview=full&geometries=geojson&steps=false`;

  console.log(`[OSRM] Fetching route: ${url}`);

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
      console.error('[OSRM] No route found:', data.code);
      return null;
    }

    // OSRM returns GeoJSON coordinates as [longitude, latitude]
    // We convert them to [latitude, longitude] for consistency with our system
    const geoCoords = data.routes[0].geometry.coordinates;
    const routeCoords = geoCoords.map(([lon, lat]) => [lat, lon]);

    const distanceKm = (data.routes[0].distance / 1000).toFixed(2);
    console.log(`[OSRM] Route loaded: ${routeCoords.length} road points, ${distanceKm} km`);

    return routeCoords;
  } catch (err) {
    console.error('[OSRM] Fetch error:', err.message);
    return null;
  }
}

// ==============================================================================
// PRE-COMPUTE CUMULATIVE DISTANCES ALONG THE ROUTE
// This allows us to quickly find "where along the route is the truck after
// travelling X meters?" without re-summing distances every tick.
//
// cumulativeDistances[i] = total distance in meters from route start to point i
// cumulativeDistances[0] = 0
// cumulativeDistances[last] = total route length in meters
// ==============================================================================
function buildCumulativeDistances(routeCoords) {
  const cumDist = [0];
  for (let i = 1; i < routeCoords.length; i++) {
    const segLen = haversineMeters(
      routeCoords[i - 1][0], routeCoords[i - 1][1],
      routeCoords[i][0], routeCoords[i][1]
    );
    cumDist.push(cumDist[i - 1] + segLen);
  }
  return cumDist;
}

// ==============================================================================
// FIND POSITION ON ROUTE BY DISTANCE TRAVELLED
// Given a distance in meters from the start, find the exact lat/lon on the route.
// Interpolates between route points for sub-segment precision.
// ==============================================================================
function getPositionAtDistance(routeCoords, cumulativeDistances, distanceMeters) {
  const totalLength = cumulativeDistances[cumulativeDistances.length - 1];

  // Clamp to route bounds
  if (distanceMeters <= 0) {
    return { lat: routeCoords[0][0], lon: routeCoords[0][1], index: 0, finished: false };
  }
  if (distanceMeters >= totalLength) {
    const last = routeCoords.length - 1;
    return { lat: routeCoords[last][0], lon: routeCoords[last][1], index: last, finished: true };
  }

  // Binary search for the segment containing this distance
  let lo = 0, hi = cumulativeDistances.length - 1;
  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (cumulativeDistances[mid] <= distanceMeters) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  // lo is the index of the segment start, hi = lo+1 is the segment end
  const segStart = cumulativeDistances[lo];
  const segEnd = cumulativeDistances[hi];
  const segLength = segEnd - segStart;

  // How far along this segment (0.0 to 1.0)
  const t = segLength > 0 ? (distanceMeters - segStart) / segLength : 0;

  // Interpolate lat/lon within the segment
  const lat = routeCoords[lo][0] + (routeCoords[hi][0] - routeCoords[lo][0]) * t;
  const lon = routeCoords[lo][1] + (routeCoords[hi][1] - routeCoords[lo][1]) * t;

  return { lat: parseFloat(lat.toFixed(6)), lon: parseFloat(lon.toFixed(6)), index: lo, finished: false };
}

// ==============================================================================
// IN-MEMORY TRUCK DATA
// Each truck includes an appointmentEndTime — the deadline by which the
// truck must arrive. If the ETA exceeds this, we flag APPOINTMENT_RISK.
// ==============================================================================
const trucks = [
  {
    truckId: 'TR-101',
    trailerId: 'TRL-501',
    shipmentId: 'SHP-9001',
    latitude: TRUCK_ROUTES['TR-101'].start.lat,
    longitude: TRUCK_ROUTES['TR-101'].start.lon,
    speed: 45, // km/h — this is used for distance-based movement
    status: 'In Transit',
    priority: 'High',
    appointmentEndTime: new Date(Date.now() + 35 * 60 * 1000).toISOString(),
    trafficStatus: 'NORMAL'
  },
  {
    truckId: 'TR-102',
    trailerId: 'TRL-502',
    shipmentId: 'SHP-9002',
    latitude: 13.0067,
    longitude: 80.2025,
    speed: 0,
    status: 'Loading',
    priority: 'Medium',
    appointmentEndTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    trafficStatus: 'NORMAL'
  },
  {
    truckId: 'TR-103',
    trailerId: 'TRL-503',
    shipmentId: 'SHP-9003',
    latitude: TRUCK_ROUTES['TR-103'].start.lat,
    longitude: TRUCK_ROUTES['TR-103'].start.lon,
    speed: 55,
    status: 'In Transit',
    priority: 'Low',
    appointmentEndTime: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
    trafficStatus: 'NORMAL'
  }
];

// ==============================================================================
// ROUTE STATE PER TRUCK
// Stores the OSRM route geometry and distance-based progress for each truck.
// ==============================================================================
const truckRouteState = {
  // Will be populated on startup after OSRM routes are fetched:
  // 'TR-101': {
  //   routeCoords: [[lat,lon], ...],     // hundreds of road-snapped points
  //   cumulativeDistances: [0, ...],      // meters from start at each point
  //   distanceTravelled: 0,               // meters the truck has covered so far
  //   isReversing: false,                 // going back after reaching destination
  //   destinationName: 'Sriperumbudur...'
  // }
};

// ==============================================================================
// DISRUPTION SIMULATION STATE
// ==============================================================================
let trafficDelayActive = false;
let preDelayEtaMinutes = null;
let preDelayArrivalTime = null;
let preDelaySpeed = null;

// ==============================================================================
// SOCKET.IO CONNECTION MANAGEMENT
// ==============================================================================
io.on('connection', (socket) => {
  console.log(`[Socket.IO] New client connected: ${socket.id}`);

  // Push immediate telemetry on connection so frontend displays instant data
  trucks.forEach(truck => {
    socket.emit('truckLocationUpdate', truck);
  });

  // If there's an active delay, notify the new client immediately
  if (trafficDelayActive) {
    const tr101 = trucks.find(t => t.truckId === 'TR-101');
    if (tr101) {
      socket.emit('delayStatus', {
        active: true,
        truckId: 'TR-101',
        trafficStatus: tr101.trafficStatus,
        preDelayEtaMinutes,
        preDelayArrivalTime,
        preDelaySpeed,
        newEtaMinutes: tr101.etaMinutes,
        newArrivalTime: tr101.estimatedArrivalTime,
        newSpeed: tr101.speed
      });
    }
  }

  // ============================================================================
  // SIMULATE TRAFFIC DELAY EVENT
  // ============================================================================
  socket.on('simulateDelay', (data) => {
    const truckId = data?.truckId || 'TR-101';
    const truck = trucks.find(t => t.truckId === truckId);
    if (!truck) return;

    console.log(`[DISRUPTION] Simulating traffic delay for ${truckId}`);

    // Step 1: Save pre-delay ETA snapshot for comparison display
    preDelayEtaMinutes = truck.etaMinutes || null;
    preDelayArrivalTime = truck.estimatedArrivalTime || null;
    preDelaySpeed = truck.speed;

    // Step 2: Activate the delay flag
    trafficDelayActive = true;

    // Step 3: Reduce speed immediately and set traffic status
    truck.speed = Math.floor(8 + Math.random() * 4); // Crawl: 8-12 km/h
    truck.trafficStatus = 'HIGH';

    // Step 4: Recalculate ETA at the reduced speed using route-based distance
    const state = truckRouteState[truckId];
    if (state && state.routeCoords) {
      const routeIndex = getPositionAtDistance(
        state.routeCoords, state.cumulativeDistances, state.distanceTravelled
      ).index;
      const eta = calculateRouteETA(
        truck.latitude, truck.longitude,
        truck.speed,
        state.routeCoords, routeIndex,
        state.destinationName
      );
      truck.distanceRemainingKm = eta.distanceRemainingKm;
      truck.etaMinutes = eta.etaMinutes;
      truck.estimatedArrivalTime = eta.estimatedArrivalTime;
      truck.destination = eta.destination;
    }

    // Step 5: Check if new ETA exceeds the truck's appointment window
    const appointmentEnd = new Date(truck.appointmentEndTime);
    const newArrival = new Date(Date.now() + (truck.etaMinutes || 0) * 60 * 1000);
    const isAppointmentAtRisk = newArrival > appointmentEnd;

    // Broadcast updated truck state to all clients
    io.emit('truckLocationUpdate', truck);

    // Broadcast delay status with old vs new ETA comparison
    io.emit('delayStatus', {
      active: true,
      truckId: truck.truckId,
      trafficStatus: 'HIGH',
      preDelayEtaMinutes,
      preDelayArrivalTime,
      preDelaySpeed,
      newEtaMinutes: truck.etaMinutes,
      newArrivalTime: truck.estimatedArrivalTime,
      newSpeed: truck.speed
    });

    // Step 6: If appointment is at risk, emit the appointmentRisk event
    if (isAppointmentAtRisk) {
      const riskPayload = {
        type: 'APPOINTMENT_RISK',
        truckId: truck.truckId,
        shipmentId: truck.shipmentId,
        appointmentEndTime: truck.appointmentEndTime,
        originalEtaMinutes: preDelayEtaMinutes,
        originalArrivalTime: preDelayArrivalTime,
        newEtaMinutes: truck.etaMinutes,
        newArrivalTime: truck.estimatedArrivalTime,
        delayIncreaseMinutes: truck.etaMinutes && preDelayEtaMinutes
          ? parseFloat((truck.etaMinutes - preDelayEtaMinutes).toFixed(1))
          : null,
        severity: 'CRITICAL',
        message: `Truck ${truck.truckId} will miss appointment deadline due to traffic congestion`
      };
      console.log('[ALERT] APPOINTMENT_RISK:', riskPayload);
      io.emit('appointmentRisk', riskPayload);
    }
  });

  // ============================================================================
  // CLEAR DELAY EVENT
  // ============================================================================
  socket.on('clearDelay', (data) => {
    const truckId = data?.truckId || 'TR-101';
    const truck = trucks.find(t => t.truckId === truckId);
    if (!truck) return;

    console.log(`[DISRUPTION] Clearing traffic delay for ${truckId}`);

    // Reset the delay state
    trafficDelayActive = false;
    truck.trafficStatus = 'NORMAL';
    truck.speed = Math.floor(38 + Math.random() * 16); // Restore normal speed

    // Recalculate ETA at normal speed
    const state = truckRouteState[truckId];
    if (state && state.routeCoords) {
      const routeIndex = getPositionAtDistance(
        state.routeCoords, state.cumulativeDistances, state.distanceTravelled
      ).index;
      const eta = calculateRouteETA(
        truck.latitude, truck.longitude,
        truck.speed,
        state.routeCoords, routeIndex,
        state.destinationName
      );
      truck.distanceRemainingKm = eta.distanceRemainingKm;
      truck.etaMinutes = eta.etaMinutes;
      truck.estimatedArrivalTime = eta.estimatedArrivalTime;
      truck.destination = eta.destination;
    }

    // Clear pre-delay snapshots
    preDelayEtaMinutes = null;
    preDelayArrivalTime = null;
    preDelaySpeed = null;

    // Broadcast restored state
    io.emit('truckLocationUpdate', truck);
    io.emit('delayStatus', { active: false, truckId: truck.truckId });
  });

  socket.on('disconnect', () => {
    console.log(`[Socket.IO] Client disconnected: ${socket.id}`);
  });
});

// ==============================================================================
// MOVEMENT SIMULATION — SPEED-BASED ROUTE PROGRESSION
// ==============================================================================
// Runs every 2 seconds (2000 ms).
//
// HOW IT WORKS (the key fix):
//   1. Read the truck's speed (e.g. 45 km/h)
//   2. Convert to meters/second: 45 * 1000 / 3600 = 12.5 m/s
//   3. In 2 seconds, the truck travels: 12.5 * 2 = 25 meters
//   4. Add 25 meters to distanceTravelled
//   5. Use the cumulative distance table to find the exact lat/lon on the route
//      at that distance
//   6. The truck follows the actual road because the route coordinates came
//      from OSRM (real OpenStreetMap road data)
//
// This is:  speed → distance/time → route progress → lat/lon
// NOT:      timer → next coordinate
// ==============================================================================
const TICK_INTERVAL_MS = 2000; // 2 seconds between updates

function simulateMovement() {
  // Process each moving truck that has a loaded OSRM route
  for (const [truckId, state] of Object.entries(truckRouteState)) {
    if (!state.routeCoords || state.routeCoords.length === 0) continue;

    const truck = trucks.find(t => t.truckId === truckId);
    if (!truck) continue;
    if (truck.speed <= 0) continue; // Stationary trucks don't move

    // -----------------------------------------------------------------------
    // STEP 1: Calculate distance the truck travels in this 2-second tick
    // Speed is in km/h → convert to meters per second → multiply by tick time
    // -----------------------------------------------------------------------
    const speedKmh = trafficDelayActive && truckId === 'TR-101'
      ? Math.floor(8 + Math.random() * 4)   // Crawl: 8-12 km/h during delay
      : truck.speed;

    const speedMs = (speedKmh * 1000) / 3600;   // km/h → m/s
    const distanceThisTick = speedMs * (TICK_INTERVAL_MS / 1000); // meters

    // -----------------------------------------------------------------------
    // STEP 2: Advance the truck along the route by that distance
    // -----------------------------------------------------------------------
    const totalRouteLength = state.cumulativeDistances[state.cumulativeDistances.length - 1];

    if (!state.isReversing) {
      // Moving forward (start → destination)
      state.distanceTravelled += distanceThisTick;

      if (state.distanceTravelled >= totalRouteLength) {
        // Reached the destination — start reversing
        state.distanceTravelled = totalRouteLength;
        state.isReversing = true;
        console.log(`[ROUTE] ${truckId} reached destination, reversing`);
      }
    } else {
      // Moving backward (destination → start)
      state.distanceTravelled -= distanceThisTick;

      if (state.distanceTravelled <= 0) {
        // Reached the start — go forward again
        state.distanceTravelled = 0;
        state.isReversing = false;
        console.log(`[ROUTE] ${truckId} reached start, going forward`);
      }
    }

    // -----------------------------------------------------------------------
    // STEP 3: Find the exact lat/lon position on the road at this distance
    // -----------------------------------------------------------------------
    const position = getPositionAtDistance(
      state.routeCoords,
      state.cumulativeDistances,
      state.distanceTravelled
    );

    // -----------------------------------------------------------------------
    // STEP 4: Update the truck's in-memory data
    // -----------------------------------------------------------------------
    truck.latitude = position.lat;
    truck.longitude = position.lon;
    truck.speed = speedKmh;
    truck.status = trafficDelayActive && truckId === 'TR-101'
      ? 'Delayed - Heavy Traffic'
      : 'In Transit';

    // -----------------------------------------------------------------------
    // STEP 5: Calculate ETA using remaining route distance
    // -----------------------------------------------------------------------
    const currentRouteCoords = state.routeCoords;
    const currentIndex = position.index;
    const destinationName = state.isReversing
      ? state.startName
      : state.destinationName;

    // For ETA calculation, we need distance from current position to the end
    // If reversing, remaining distance = distanceTravelled (going back to 0)
    // If forward, remaining distance = totalLength - distanceTravelled
    const remainingMeters = state.isReversing
      ? state.distanceTravelled
      : totalRouteLength - state.distanceTravelled;
    const remainingKm = remainingMeters / 1000;

    const etaMinutes = speedKmh > 0 ? (remainingKm / speedKmh) * 60 : null;
    let estimatedArrivalTime = null;
    if (etaMinutes !== null) {
      const arrival = new Date(Date.now() + etaMinutes * 60 * 1000);
      estimatedArrivalTime = arrival.toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      });
    }

    truck.distanceRemainingKm = parseFloat(remainingKm.toFixed(2));
    truck.etaMinutes = etaMinutes !== null ? parseFloat(etaMinutes.toFixed(1)) : null;
    truck.estimatedArrivalTime = estimatedArrivalTime;
    truck.destination = destinationName;

    // -----------------------------------------------------------------------
    // STEP 6: Broadcast real-time update to all connected Socket.IO clients
    // -----------------------------------------------------------------------
    io.emit('truckLocationUpdate', truck);
  }
}

// Start the movement tick every 2 seconds
setInterval(simulateMovement, TICK_INTERVAL_MS);

// ==============================================================================
// REST API ROUTES (Kept for compatibility & initial hydration)
// ==============================================================================

// Root Health Check Route
app.get('/', (req, res) => {
  res.send('Cognizant SCM - Truck Live Tracking API with OSRM Road Routing is running.');
});

// GET /api/trucks - Returns all trucks
app.get('/api/trucks', (req, res) => {
  res.json({
    success: true,
    count: trucks.length,
    timestamp: new Date().toISOString(),
    data: trucks
  });
});

// GET /api/trucks/:truckId - Returns specific truck
app.get('/api/trucks/:truckId', (req, res) => {
  const requestedId = req.params.truckId.toUpperCase();
  const truck = trucks.find(
    t => t.truckId.toUpperCase() === requestedId ||
         t.truckId.replace('-', '').toUpperCase() === requestedId.replace('-', '') ||
         t.truckId.replace('TR-', 'TRK-').toUpperCase() === requestedId
  );

  if (!truck) {
    return res.status(404).json({
      success: false,
      message: `Truck '${req.params.truckId}' not found.`
    });
  }

  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    data: truck
  });
});

// ==============================================================================
// SERVER STARTUP — Fetch OSRM routes, then start listening
// ==============================================================================
async function startServer() {
  console.log('============================================================');
  console.log('  Cognizant SCM - Truck Live Tracking');
  console.log('  Loading OSRM road routes from OpenStreetMap...');
  console.log('============================================================');

  // Fetch OSRM driving routes for each moving truck
  for (const [truckId, routeDef] of Object.entries(TRUCK_ROUTES)) {
    const routeCoords = await fetchOSRMRoute(
      routeDef.start.lat, routeDef.start.lon,
      routeDef.end.lat, routeDef.end.lon
    );

    if (routeCoords && routeCoords.length > 0) {
      const cumulativeDistances = buildCumulativeDistances(routeCoords);
      const totalKm = (cumulativeDistances[cumulativeDistances.length - 1] / 1000).toFixed(2);

      truckRouteState[truckId] = {
        routeCoords,
        cumulativeDistances,
        distanceTravelled: 0,      // Start at the beginning of the route
        isReversing: false,
        destinationName: routeDef.end.name,
        startName: routeDef.start.name
      };

      console.log(`[ROUTE] ${truckId}: ${routeCoords.length} road points, ${totalKm} km total`);
    } else {
      console.warn(`[ROUTE] ${truckId}: OSRM route failed — truck will be stationary`);
    }
  }

  console.log('============================================================');
  console.log('  All routes loaded. Starting server...');
  console.log('============================================================');

  // Start HTTP + Socket.IO Server
  server.listen(PORT, () => {
    console.log(`Server with Socket.IO + OSRM is running on http://localhost:${PORT}`);
    console.log(`REST endpoint: http://localhost:${PORT}/api/trucks`);
  });
}

// Launch the server
startServer();
