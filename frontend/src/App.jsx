import React, { useState, useEffect, useRef, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import { io } from 'socket.io-client';
import { 
  Truck, 
  Navigation, 
  AlertTriangle, 
  Clock, 
  Radio, 
  Activity, 
  Gauge, 
  Package, 
  Layers, 
  ChevronRight,
  Wifi,
  WifiOff,
  MapPin,
  Timer,
  Route,
  Zap,
  ShieldAlert,
  X,
  ArrowRight,
  OctagonAlert,
  CircleCheck
} from 'lucide-react';

const SOCKET_SERVER_URL = 'http://localhost:5000';

const INITIAL_MAP_CENTER = [13.0450, 80.1700];
const INITIAL_MAP_ZOOM = 12;

// ===========================================================================
// MAP INSTANCE CAPTURE — Captures the Leaflet map instance once on mount.
// Truck telemetry updates NEVER move, pan, or recenter the map.
// The camera is ONLY moved when the user explicitly clicks "Locate".
// ===========================================================================
function MapInstanceCapture({ onMapReady }) {
  const map = useMap();
  useEffect(() => {
    if (map) onMapReady(map);
  }, [map, onMapReady]);
  return null;
}

// Generate dynamic SVG Leaflet marker for each truck
const createTruckIcon = (truck, isSelected) => {
  const isHighPriority = truck.priority === 'High';
  const isInTransit = truck.status === 'In Transit';
  const isDelayed = truck.trafficStatus === 'HIGH';
  
  // Theme colors: red for delayed, red for high priority, blue for transit, amber for other
  const primaryColor = isDelayed ? '#f97316' : isHighPriority ? '#ef4444' : isInTransit ? '#0284c7' : '#f59e0b';
  const ringColor = isSelected ? '#ffffff' : primaryColor;
  const pulseEffect = isHighPriority || truck.truckId === 'TR-101' ? 'marker-live-pulse' : '';

  return L.divIcon({
    className: 'custom-truck-marker',
    html: `
      <div style="display:flex; flex-direction:column; align-items:center; transform: translate(-50%, -100%);">
        <div style="background: rgba(15, 23, 42, 0.95); color: #f8fafc; font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 6px; border: 1.5px solid ${primaryColor}; white-space: nowrap; margin-bottom: 3px; box-shadow: 0 4px 10px rgba(0,0,0,0.5);">
          ${truck.truckId} &bull; ${truck.speed} km/h ${isDelayed ? '⚠️' : ''}
        </div>
        <div class="${pulseEffect}" style="background-color: ${primaryColor}; width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; border: 2.5px solid ${ringColor}; box-shadow: 0 6px 14px rgba(0,0,0,0.5);">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="1" y="3" width="15" height="13"></rect>
            <polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon>
            <circle cx="5.5" cy="18.5" r="2.5"></circle>
            <circle cx="18.5" cy="18.5" r="2.5"></circle>
          </svg>
        </div>
      </div>
    `,
    iconSize: [42, 54],
    iconAnchor: [21, 54],
    popupAnchor: [0, -54]
  });
};

export default function App() {
  const [trucks, setTrucks] = useState([]);
  const [selectedTruck, setSelectedTruck] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [lastReceivedTime, setLastReceivedTime] = useState(null);
  const [isLive, setIsLive] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  // Persistent ref to the Leaflet map instance — used ONLY when user clicks "Locate"
  const mapInstanceRef = useRef(null);
  const handleMapReady = useCallback((map) => {
    mapInstanceRef.current = map;
  }, []);

  // ============================================================================
  // DISRUPTION SIMULATION STATE
  // ============================================================================
  const socketRef = useRef(null);          // Persistent ref to Socket.IO connection
  const [delayStatus, setDelayStatus] = useState(null);       // Current delay info from server
  const [appointmentRisk, setAppointmentRisk] = useState(null); // APPOINTMENT_RISK alert data
  const [showRiskAlert, setShowRiskAlert] = useState(false);    // Toggle for the risk alert banner

  // 1. Initial REST fetch + Socket.IO connection with disruption listeners
  useEffect(() => {
    // Initial REST fetch
    fetch(`${SOCKET_SERVER_URL}/api/trucks`)
      .then(res => res.json())
      .then(result => {
        if (result.success && Array.isArray(result.data)) {
          setTrucks(result.data);
          setLastReceivedTime(Date.now());
          setIsLive(true);
          setLastUpdated(new Date().toLocaleTimeString());
        }
      })
      .catch(err => {
        console.warn('Initial REST load error (will rely on Socket):', err);
      });

    // Establish Socket.IO connection
    const socket = io(SOCKET_SERVER_URL, {
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 10,
      reconnectionDelay: 1000
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('[Socket.IO] Connected:', socket.id);
    });

    // Real-time truck location updates
    socket.on('truckLocationUpdate', (updatedTruck) => {
      const now = Date.now();
      setLastReceivedTime(now);
      setIsLive(true);
      setLastUpdated(new Date(now).toLocaleTimeString());

      setTrucks((prev) => {
        const idx = prev.findIndex(t => t.truckId === updatedTruck.truckId);
        if (idx !== -1) {
          const next = [...prev];
          next[idx] = { ...next[idx], ...updatedTruck };
          return next;
        }
        return [...prev, updatedTruck];
      });

      setSelectedTruck((prev) => {
        if (prev && prev.truckId === updatedTruck.truckId) {
          return { ...prev, ...updatedTruck };
        }
        return prev;
      });
    });

    // ========================================================================
    // DISRUPTION EVENT LISTENERS
    // ========================================================================
    // delayStatus: Carries the old vs new ETA comparison data from the server
    socket.on('delayStatus', (data) => {
      console.log('[Socket.IO] delayStatus:', data);
      setDelayStatus(data);
      if (!data.active) {
        // Delay cleared — dismiss alerts after a short delay for smooth UX
        setTimeout(() => {
          setAppointmentRisk(null);
          setShowRiskAlert(false);
        }, 500);
      }
    });

    // appointmentRisk: Fired when the delayed ETA exceeds the appointment window
    socket.on('appointmentRisk', (data) => {
      console.log('[Socket.IO] APPOINTMENT_RISK:', data);
      setAppointmentRisk(data);
      setShowRiskAlert(true);
    });

    socket.on('disconnect', () => {
      console.log('[Socket.IO] Disconnected');
      setIsLive(false);
    });

    return () => { socket.disconnect(); };
  }, []);

  // GPS watchdog (10s timeout)
  useEffect(() => {
    const watchdog = setInterval(() => {
      if (lastReceivedTime) {
        if (Date.now() - lastReceivedTime > 10000) setIsLive(false);
      } else {
        setIsLive(false);
      }
    }, 1000);
    return () => clearInterval(watchdog);
  }, [lastReceivedTime]);

  // Select a truck in the sidebar/popup — does NOT move the map camera
  const handleSelectTruck = (truck) => {
    setSelectedTruck(truck);
  };

  // Manually fly to a truck — ONLY called when the user clicks "Locate"
  const handleLocateTruck = useCallback((truck) => {
    setSelectedTruck(truck);
    if (mapInstanceRef.current && truck.latitude && truck.longitude) {
      mapInstanceRef.current.flyTo([truck.latitude, truck.longitude], 14, { duration: 1.2 });
    }
  }, []);

  // ============================================================================
  // DISRUPTION CONTROL HANDLERS
  // Send 'simulateDelay' or 'clearDelay' event to the Socket.IO server.
  // The server handles all logic and broadcasts results to all clients.
  // ============================================================================
  const handleSimulateDelay = () => {
    const truckId = selectedTruck?.truckId || 'TR-101';
    if (socketRef.current) {
      socketRef.current.emit('simulateDelay', { truckId });
    }
  };

  const handleClearDelay = () => {
    const truckId = selectedTruck?.truckId || 'TR-101';
    if (socketRef.current) {
      socketRef.current.emit('clearDelay', { truckId });
    }
  };

  const isDelayActive = delayStatus?.active === true;

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-slate-950 font-sans select-none">
      {/* ============================================================================== */}
      {/* ENTERPRISE DASHBOARD HEADER */}
      {/* ============================================================================== */}
      <header className="absolute top-0 left-0 right-0 z-30 flex items-center justify-between px-6 py-3 bg-slate-900/90 backdrop-blur-md border-b border-slate-800 shadow-xl">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-gradient-to-tr from-blue-600 to-indigo-600 rounded-lg shadow-md shadow-blue-500/20">
            <Truck className="w-6 h-6 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold tracking-wider uppercase text-blue-400">Cognizant SCM</span>
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-slate-600"></span>
              <span className="text-xs text-slate-400 font-medium">Socket.IO Telemetry</span>
            </div>
            <h1 className="text-lg font-bold text-white tracking-tight">Truck Live Tracking Command Center</h1>
          </div>
        </div>

        {/* Status Indicators + Disruption Buttons */}
        <div className="flex items-center gap-3 text-xs font-medium">
          {/* Live / GPS SIGNAL LOST indicator */}
          {isLive ? (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-950/80 border border-emerald-500/40 text-emerald-400 shadow-sm shadow-emerald-500/10">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
              </span>
              <span className="font-bold tracking-wide">LIVE</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-rose-950/90 border border-rose-500/50 text-rose-400 animate-pulse shadow-md shadow-rose-500/20">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
              <span className="font-bold tracking-wider">GPS SIGNAL LOST</span>
            </div>
          )}

          {/* Traffic Status Badge (shown when delay is active) */}
          {isDelayActive && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-orange-950/80 border border-orange-500/50 text-orange-400 animate-pulse">
              <OctagonAlert className="w-3.5 h-3.5" />
              <span className="font-bold tracking-wide">TRAFFIC: HIGH</span>
            </div>
          )}

          {/* ============================================================ */}
          {/* SIMULATE TRAFFIC DELAY / CLEAR DELAY BUTTONS */}
          {/* These are the primary demo controls for the disruption.      */}
          {/* ============================================================ */}
          {!isDelayActive ? (
            <button
              onClick={handleSimulateDelay}
              className="px-3 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-500 text-white font-bold transition-all shadow-md shadow-orange-500/20 flex items-center gap-1.5 text-xs"
              title="Simulate a traffic jam: speed drops, ETA increases, appointment risk is evaluated"
            >
              <Zap className="w-4 h-4" />
              <span className="hidden sm:inline">SIMULATE TRAFFIC DELAY</span>
              <span className="sm:hidden">DELAY</span>
            </button>
          ) : (
            <button
              onClick={handleClearDelay}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold transition-all shadow-md shadow-emerald-500/20 flex items-center gap-1.5 text-xs"
              title="Clear the simulated delay and restore normal speed"
            >
              <CircleCheck className="w-4 h-4" />
              <span className="hidden sm:inline">CLEAR DELAY</span>
              <span className="sm:hidden">CLEAR</span>
            </button>
          )}

          {/* Fleet Units */}
          <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-800/80 border border-slate-700 text-slate-200">
            <Activity className="w-3.5 h-3.5 text-blue-400" />
            <span>Fleet: <strong className="text-white">{trucks.length}</strong></span>
          </div>

          {/* Last Update */}
          {lastUpdated && (
            <div className="hidden md:flex items-center gap-1.5 text-slate-400">
              <Clock className="w-3.5 h-3.5" />
              <span>{lastUpdated}</span>
            </div>
          )}

          {/* Toggle Sidebar */}
          <button 
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold transition-all shadow-sm flex items-center gap-1.5"
          >
            <Layers className="w-4 h-4" />
            <span className="hidden sm:inline">{isSidebarOpen ? 'Hide Fleet' : 'Show Fleet'}</span>
          </button>
        </div>
      </header>

      {/* GPS Signal Warning Banner */}
      {!isLive && (
        <div key="banner-gps-lost" className="absolute top-16 left-1/2 -translate-x-1/2 z-40 px-5 py-2.5 bg-rose-600/90 text-white text-xs font-semibold rounded-full shadow-2xl flex items-center gap-2.5 backdrop-blur-md border border-rose-400/40">
          <WifiOff className="w-4 h-4 animate-bounce" />
          <span>GPS SIGNAL LOST &bull; No telemetry received in past 10 seconds</span>
        </div>
      )}

      {/* ============================================================================== */}
      {/* APPOINTMENT RISK ALERT BANNER                                                  */}
      {/* Displayed when the delayed ETA exceeds the truck's appointment end time.       */}
      {/* Shows old ETA vs new ETA comparison and the delay increase.                     */}
      {/* ============================================================================== */}
      {showRiskAlert && appointmentRisk && (
        <div key="banner-risk-alert" className="absolute top-16 left-1/2 -translate-x-1/2 z-50 w-[520px] max-w-[92vw] bg-gradient-to-r from-red-950/95 to-orange-950/95 backdrop-blur-lg rounded-2xl border border-red-500/50 shadow-2xl shadow-red-500/20 p-4 animate-in">
          {/* Dismiss button */}
          <button
            onClick={() => setShowRiskAlert(false)}
            className="absolute top-3 right-3 text-slate-400 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>

          {/* Alert Header */}
          <div className="flex items-center gap-2.5 mb-3">
            <div className="p-2 bg-red-500/20 rounded-lg border border-red-500/30">
              <ShieldAlert className="w-5 h-5 text-red-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-red-400">APPOINTMENT_RISK</span>
                <span className="px-2 py-0.5 bg-red-500/30 text-red-300 rounded text-[10px] font-bold border border-red-500/40">
                  {appointmentRisk.severity}
                </span>
              </div>
              <p className="text-xs text-slate-300 mt-0.5">{appointmentRisk.message}</p>
            </div>
          </div>

          {/* Old ETA vs New ETA Comparison */}
          <div className="grid grid-cols-3 gap-2 text-center">
            {/* Old ETA */}
            <div className="p-2.5 rounded-xl bg-slate-800/80 border border-slate-700">
              <span className="block text-[10px] text-slate-500 uppercase tracking-wider mb-1">Original ETA</span>
              <span className="block text-lg font-bold text-emerald-400">
                {appointmentRisk.originalEtaMinutes ?? '--'} min
              </span>
              <span className="block text-[11px] text-slate-400 mt-0.5">
                {appointmentRisk.originalArrivalTime || '--:--'}
              </span>
            </div>

            {/* Arrow */}
            <div className="flex flex-col items-center justify-center">
              <ArrowRight className="w-6 h-6 text-orange-400 animate-pulse" />
              <span className="text-[10px] text-orange-400 font-bold mt-1">
                +{appointmentRisk.delayIncreaseMinutes ?? '?'} min
              </span>
            </div>

            {/* New ETA */}
            <div className="p-2.5 rounded-xl bg-red-950/60 border border-red-800">
              <span className="block text-[10px] text-red-400 uppercase tracking-wider mb-1">Delayed ETA</span>
              <span className="block text-lg font-bold text-red-400">
                {appointmentRisk.newEtaMinutes ?? '--'} min
              </span>
              <span className="block text-[11px] text-red-300 mt-0.5">
                {appointmentRisk.newArrivalTime || '--:--'}
              </span>
            </div>
          </div>

          {/* Appointment Deadline */}
          <div className="mt-2.5 flex items-center justify-between text-[11px] px-1">
            <span className="text-slate-400">
              Appointment Deadline: <strong className="text-white">
                {new Date(appointmentRisk.appointmentEndTime).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })}
              </strong>
            </span>
            <span className="text-red-400 font-bold">⚠ WILL MISS DEADLINE</span>
          </div>
        </div>
      )}

      {/* ============================================================================== */}
      {/* OLD vs NEW ETA COMPARISON STRIP (visible during active delay)                  */}
      {/* A compact bar below the header showing the speed reduction and ETA change       */}
      {/* ============================================================================== */}
      {isDelayActive && delayStatus && !showRiskAlert && (
        <div key="banner-delay-strip" className="absolute top-16 left-1/2 -translate-x-1/2 z-40 px-5 py-2 bg-orange-950/90 backdrop-blur-md rounded-full border border-orange-500/40 shadow-xl flex items-center gap-4 text-xs text-orange-200">
          <OctagonAlert className="w-4 h-4 text-orange-400 animate-pulse" />
          <span>
            Speed: <strong className="text-white">{delayStatus.preDelaySpeed} km/h</strong>
            <ArrowRight className="w-3 h-3 inline mx-1 text-orange-400" />
            <strong className="text-orange-400">{delayStatus.newSpeed} km/h</strong>
          </span>
          <span className="text-orange-500">|</span>
          <span>
            ETA: <strong className="text-white">{delayStatus.preDelayEtaMinutes} min</strong>
            <ArrowRight className="w-3 h-3 inline mx-1 text-red-400" />
            <strong className="text-red-400">{delayStatus.newEtaMinutes} min</strong>
          </span>
        </div>
      )}

      {/* ============================================================================== */}
      {/* FULL-SCREEN LEAFLET MAP                                                       */}
      {/* The map is created ONCE. Truck markers update in-place via React props.        */}
      {/* The camera NEVER moves automatically — only via user "Locate" clicks.          */}
      {/* ============================================================================== */}
      <div key="persistent-map-wrapper" className="w-full h-full pt-[58px]">
        <MapContainer
          center={INITIAL_MAP_CENTER}
          zoom={INITIAL_MAP_ZOOM}
          scrollWheelZoom={true}
          style={{ width: '100%', height: '100%' }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {/* Captures map instance into mapInstanceRef for explicit user "Locate" clicks only */}
          <MapInstanceCapture onMapReady={handleMapReady} />

          {trucks.map((truck) => {
            const isSelected = selectedTruck?.truckId === truck.truckId;
            return (
              <Marker
                key={truck.truckId}
                position={[truck.latitude, truck.longitude]}
                icon={createTruckIcon(truck, isSelected)}
                eventHandlers={{ click: () => handleSelectTruck(truck) }}
              >
                <Popup className="enterprise-popup" autoPan={false}>
                  <div className="p-4 w-72 bg-slate-900 text-slate-100 rounded-xl">
                    {/* Header */}
                    <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                      <div className="flex items-center gap-2">
                        <div className="p-1.5 rounded-lg bg-blue-500/20 text-blue-400">
                          <Truck className="w-5 h-5" />
                        </div>
                        <div>
                          <h3 className="text-base font-bold text-white tracking-tight">{truck.truckId}</h3>
                          <p className="text-xs text-slate-400">Trailer: {truck.trailerId || 'N/A'}</p>
                        </div>
                      </div>
                      <span className={`px-2.5 py-0.5 rounded-full text-xs font-bold tracking-wide uppercase ${
                        truck.priority === 'High' ? 'bg-red-950 text-red-400 border border-red-800' :
                        truck.priority === 'Medium' ? 'bg-amber-950 text-amber-400 border border-amber-800' :
                        'bg-blue-950 text-blue-400 border border-blue-800'
                      }`}>
                        {truck.priority}
                      </span>
                    </div>

                    {/* Traffic Status Banner (shown during delay) */}
                    {truck.trafficStatus === 'HIGH' && (
                      <div className="mt-2 flex items-center gap-2 px-2 py-1.5 rounded-lg bg-orange-950/80 border border-orange-500/40 text-orange-400 text-[11px] font-bold">
                        <OctagonAlert className="w-3.5 h-3.5" />
                        TRAFFIC STATUS: HIGH — SPEED REDUCED
                      </div>
                    )}

                    {/* Specifications */}
                    <div className="mt-3 space-y-2 text-xs">
                      <div className="flex items-center justify-between py-1 px-2 rounded bg-slate-800/60">
                        <span className="text-slate-400 flex items-center gap-1.5">
                          <Package className="w-3.5 h-3.5 text-indigo-400" /> Shipment ID:
                        </span>
                        <span className="font-semibold text-white font-mono">{truck.shipmentId}</span>
                      </div>
                      <div className="flex items-center justify-between py-1 px-2 rounded bg-slate-800/60">
                        <span className="text-slate-400 flex items-center gap-1.5">
                          <Gauge className="w-3.5 h-3.5 text-emerald-400" /> Current Speed:
                        </span>
                        <span className={`font-bold ${truck.trafficStatus === 'HIGH' ? 'text-orange-400' : 'text-emerald-400'}`}>
                          {truck.speed} km/h
                        </span>
                      </div>
                      <div className="flex items-center justify-between py-1 px-2 rounded bg-slate-800/60">
                        <span className="text-slate-400 flex items-center gap-1.5">
                          <Navigation className="w-3.5 h-3.5 text-sky-400" /> Status:
                        </span>
                        <span className={`font-semibold ${
                          truck.status.includes('Delayed') ? 'text-orange-400' :
                          truck.status === 'In Transit' ? 'text-sky-400' : 'text-amber-400'
                        }`}>
                          {truck.status}
                        </span>
                      </div>
                      <div className="flex items-center justify-between py-1 px-2 rounded bg-slate-800/40 text-[11px] text-slate-400">
                        <span>Coordinates:</span>
                        <span className="font-mono text-slate-300">
                          {typeof truck.latitude === 'number' ? truck.latitude.toFixed(4) : truck.latitude}, {typeof truck.longitude === 'number' ? truck.longitude.toFixed(4) : truck.longitude}
                        </span>
                      </div>

                      {/* ETA Section */}
                      {truck.destination && (
                        <div className="mt-2 pt-2 border-t border-slate-700/50">
                          <div className="flex items-center gap-1.5 mb-2">
                            <Route className="w-3.5 h-3.5 text-violet-400" />
                            <span className="text-[11px] font-bold text-slate-300 uppercase tracking-wider">ETA Intelligence</span>
                          </div>
                          <div className="flex items-center justify-between py-1 px-2 rounded bg-slate-800/60">
                            <span className="text-slate-400 flex items-center gap-1.5">
                              <MapPin className="w-3.5 h-3.5 text-rose-400" /> Destination:
                            </span>
                            <span className="font-semibold text-white text-[11px] max-w-[140px] text-right truncate">{truck.destination}</span>
                          </div>
                          <div className="flex items-center justify-between py-1 px-2 rounded bg-slate-800/60 mt-1">
                            <span className="text-slate-400 flex items-center gap-1.5">
                              <Navigation className="w-3.5 h-3.5 text-orange-400" /> Distance Left:
                            </span>
                            <span className="font-bold text-orange-400">{truck.distanceRemainingKm} km</span>
                          </div>
                          <div className="flex items-center justify-between py-1 px-2 rounded bg-slate-800/60 mt-1">
                            <span className="text-slate-400 flex items-center gap-1.5">
                              <Timer className="w-3.5 h-3.5 text-cyan-400" /> ETA:
                            </span>
                            <span className="font-bold text-cyan-400">
                              {truck.etaMinutes !== null ? `${truck.etaMinutes} min` : 'Calculating...'}
                            </span>
                          </div>
                          <div className="flex items-center justify-between py-1 px-2 rounded bg-slate-800/60 mt-1">
                            <span className="text-slate-400 flex items-center gap-1.5">
                              <Clock className="w-3.5 h-3.5 text-violet-400" /> Arrival:
                            </span>
                            <span className="font-bold text-violet-300">
                              {truck.estimatedArrivalTime || '--:--'}
                            </span>
                          </div>

                          {/* Old vs New ETA comparison inside popup (during delay) */}
                          {isDelayActive && delayStatus && truck.truckId === delayStatus.truckId && (
                            <div className="mt-2 p-2 rounded-lg bg-red-950/50 border border-red-800/50">
                              <div className="text-[10px] font-bold text-red-400 uppercase tracking-wider mb-1.5">⚡ Delay Impact</div>
                              <div className="grid grid-cols-3 gap-1 text-center text-[11px]">
                                <div>
                                  <span className="block text-[9px] text-slate-500">BEFORE</span>
                                  <span className="text-emerald-400 font-bold">{delayStatus.preDelayEtaMinutes ?? '--'}m</span>
                                </div>
                                <div className="flex items-center justify-center">
                                  <ArrowRight className="w-3.5 h-3.5 text-orange-400" />
                                </div>
                                <div>
                                  <span className="block text-[9px] text-red-400">AFTER</span>
                                  <span className="text-red-400 font-bold">{delayStatus.newEtaMinutes ?? '--'}m</span>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </Popup>
              </Marker>
            );
          })}
        </MapContainer>
      </div>

      {/* ============================================================================== */}
      {/* FLOATING FLEET PANEL */}
      {/* ============================================================================== */}
      {isSidebarOpen && (
        <aside className="absolute bottom-6 left-6 z-20 w-84 bg-slate-900/90 backdrop-blur-md rounded-2xl border border-slate-800 shadow-2xl p-4 transition-all">
          <div className="flex items-center justify-between mb-3 pb-2 border-b border-slate-800">
            <div className="flex items-center gap-2">
              <Radio className="w-4 h-4 text-emerald-400 animate-pulse" />
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-200">Chennai Fleet Telemetry</h2>
            </div>
            <span className="text-[11px] font-semibold text-slate-400">{trucks.length} Units</span>
          </div>

          <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
            {trucks.map((truck) => {
              const isSelected = selectedTruck?.truckId === truck.truckId;
              const isMoving = truck.truckId === 'TR-101';
              const isTruckDelayed = truck.trafficStatus === 'HIGH';

              return (
                <div
                  key={truck.truckId}
                  onClick={() => handleSelectTruck(truck)}
                  className={`p-3 rounded-xl cursor-pointer border transition-all ${
                    isTruckDelayed
                      ? 'bg-orange-950/30 border-orange-500/50 shadow-md shadow-orange-500/10'
                      : isSelected 
                        ? 'bg-blue-600/20 border-blue-500 shadow-md shadow-blue-500/10' 
                        : 'bg-slate-800/60 border-slate-700/60 hover:bg-slate-800 hover:border-slate-600'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-white">{truck.truckId}</span>
                      {isTruckDelayed ? (
                        <span className="px-1.5 py-0.5 text-[10px] font-semibold bg-orange-950 text-orange-400 border border-orange-800 rounded flex items-center gap-1">
                          <OctagonAlert className="w-3 h-3" />
                          DELAYED
                        </span>
                      ) : isMoving ? (
                        <span className="px-1.5 py-0.5 text-[10px] font-semibold bg-emerald-950 text-emerald-400 border border-emerald-800 rounded flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping"></span>
                          SOCKET LIVE
                        </span>
                      ) : null}
                    </div>
                    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
                      truck.priority === 'High' ? 'bg-red-500/20 text-red-300' :
                      truck.priority === 'Medium' ? 'bg-amber-500/20 text-amber-300' :
                      'bg-slate-700 text-slate-300'
                    }`}>
                      {truck.priority}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-1 text-[11px] text-slate-400">
                    <div>
                      <span className="block text-[10px] text-slate-500">SHIPMENT</span>
                      <span className="font-mono text-slate-200">{truck.shipmentId}</span>
                    </div>
                    <div className="text-right">
                      <span className="block text-[10px] text-slate-500">SPEED</span>
                      <span className={`font-semibold ${isTruckDelayed ? 'text-orange-400' : 'text-emerald-400'}`}>
                        {truck.speed} km/h
                      </span>
                    </div>
                  </div>

                  <div className="mt-2 pt-2 border-t border-slate-700/40 flex items-center justify-between text-[11px]">
                    <span className={isTruckDelayed ? 'text-orange-400 font-semibold' : 'text-slate-400'}>
                      {truck.status}
                    </span>
                    {truck.etaMinutes !== null && truck.etaMinutes !== undefined ? (
                      <span className={`font-bold flex items-center gap-1 ${isTruckDelayed ? 'text-red-400' : 'text-cyan-400'}`}>
                        <Timer className="w-3 h-3" /> ETA {truck.etaMinutes} min
                      </span>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleLocateTruck(truck); }}
                        className="text-blue-400 flex items-center gap-0.5 hover:underline font-medium bg-transparent border-none cursor-pointer p-0"
                      >
                        Locate <ChevronRight className="w-3 h-3" />
                      </button>
                    )}
                  </div>

                  {truck.destination && (
                    <div className="mt-1.5 pt-1.5 border-t border-slate-700/30 text-[10px] text-slate-500">
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-1"><MapPin className="w-3 h-3 text-rose-400" /> {truck.destination}</span>
                        <span className="text-violet-300 font-semibold">{truck.estimatedArrivalTime || '--:--'}</span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1 text-orange-400 font-medium">
                        <Route className="w-3 h-3" /> {truck.distanceRemainingKm} km remaining
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-3 pt-2 text-[10px] text-slate-500 text-center border-t border-slate-800">
            Real-time WebSocket &bull; updates pushed every 2 seconds
          </div>
        </aside>
      )}
    </div>
  );
}
