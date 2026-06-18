    let port, reader, inputDone, keepReading = true;
    let flightData = [];
    let selectedIdx = -1;
    let termBuffer = "";
    let cmdHistory = [];
    let historyIdx = -1;

    let recording = false;
    let streaming = false;
    let currentFlightLines = [];
    let currentConfigLine = "";
    let liveDataBuffer = [];
    let maxLivePoints = 200;
    let isLiveHovering = false;

    const HEADER = [
        "timestampMs", "pressurePa", "tempK", "accelX", "accelY", "accelZ",
        "gyroX", "gyroY", "gyroZ", "imuTemp", "battV", "altitudeM",
        "velocityMS", "accelerationMSS", "unfiltAlt", "flightState",
        "drogueCont", "drogueFired", "mainCont", "mainFired",
        "tiltMagnitudeDeg", "angularVelRadS_x", "angularVelRadS_y", "angularVelRadS_z",
        "quaternion_a", "quaternion_b", "quaternion_c", "quaternion_d"
    ];
    // Minimum column count for old (pre-orientation) log format. Live-stream parser uses this
    // so old firmware streams still pass the length check; missing trailing columns plot as NaN.
    const OLD_MIN_COLS = 20;

    const stateNames = {0:"PRE_FLIGHT", 1:"ASCENT", 2:"DESCENT", 3:"POST_FLIGHT"};
    let activeSeries = [11, 12, 13];

    const configs = [
        { id: "DROGUE_DELAY", label: "Drogue Delay (milliseconds)" },
        { id: "MAIN_ELEVATION", label: "Main Elevation (meters)" },
        { id: "BATTERY_VOLTAGE_SENSOR_SCALE_FACTOR", label: "Battery Scale Factor" },
        { id: "GROUND_ELEVATION", label: "Ground Elevation Offset (meters)" },
        { id: "GROUND_TEMPERATURE", label: "Ground Temperature (kelvin)" },
        { id: "PYRO_FIRE_DURATION", label: "Pyro Duration (milliseconds)" },
        { id: "BOARD_NAME", label: "Board Name" },
        { id: "BUZZER_ENABLED", label: "Buzzer Enabled", type: "checkbox" },
        { id: "CONFIGURATION_VERSION", label: "Config Version" },
        { id: "FIRMWARE_VERSION", label: "Firmware Version", readOnly: true }
    ];

    function formatLogTime(seconds) {
        const s = parseInt(seconds);
        if (isNaN(s)) return "-";
        const hrs = Math.floor(s / 3600);
        const mins = Math.floor((s % 3600) / 60);
        const secs = s % 60;
        return `${hrs}h ${mins}m ${secs}s`;
    }

    function setBusy(val) {
        document.getElementById('busy-loader').style.display = val ? 'block' : 'none';
        if (!val && port) setSerialEnabled(true);
    }

    async function connect() {
        try {
            port = await navigator.serial.requestPort();
            await port.open({ baudRate: 115200 });
            document.getElementById('connectBtn').style.display = 'none';
            document.getElementById('disconnectBtn').style.display = 'block';
            setSerialEnabled(true);
            keepReading = true;
            readLoop();
        } catch (e) { logTerm("Connection Error: " + e.message, "red"); }
    }

    async function disconnect() {
        keepReading = false;
        if (reader) { await reader.cancel(); await inputDone.catch(() => {}); reader = null; }
        if (port) { await port.close(); port = null; }
        forceUIDisconnect();
    }

    function forceUIDisconnect() {
        port = null; setBusy(false); recording = false; streaming = false;
        document.getElementById('connectBtn').style.display = 'block';
        document.getElementById('disconnectBtn').style.display = 'none';
        setSerialEnabled(false);
    }

    async function readLoop() {
        while (port && port.readable && keepReading) {
            const textDecoder = new TextDecoderStream();
            inputDone = port.readable.pipeTo(textDecoder.writable);
            reader = textDecoder.readable.getReader();
            let rawBuffer = "";

            try {
                while (keepReading) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    rawBuffer += value;
                    let lines = rawBuffer.split("\n");
                    rawBuffer = lines.pop();

                    for (let line of lines) {
                        line = line.trim();
                        if (!line) continue;
                        logTerm(line);

                        if (line.includes("Entries in log:")) document.getElementById('log-entries').innerText = line.split(':').pop().trim();
                        if (line.includes("Remaining log length:")) {
                            const rawVal = line.split(':').pop().trim();
                            document.getElementById('log-rem').innerText = formatLogTime(rawVal);
                        }
                        if (line.includes("Logging")) document.getElementById('log-status').innerText = line.includes("enabled") ? "ON" : "OFF";

                        if (line.includes("Streaming enabled")) { streaming = true; liveDataBuffer = []; }
                        if (line.includes("Streaming disabled")) streaming = false;

                        const setMatch = line.match(/MSG:\s+([A-Z_]+)\s+is set to:\s+(.+)/);
                        if (setMatch) {
                            const inputEl = document.getElementById(`in-${setMatch[1]}`);
                            if (inputEl) {
                                const v = setMatch[2].trim();
                                if (inputEl.type === 'checkbox') inputEl.checked = (v !== '0' && v.toLowerCase() !== 'false');
                                else inputEl.value = v;
                            }
                            setBusy(false);
                        }

                        if (line.includes("Starting Offload")) { recording = true; currentFlightLines = []; currentConfigLine = ""; setBusy(true); continue; }

                        if (streaming && /^\d/.test(line)) handleLiveLine(line);

                        if (recording) {
                            if (line.includes("Logger setup")) { if (currentFlightLines.length > 5) saveFlight(currentFlightLines, currentConfigLine); currentFlightLines = []; currentConfigLine = ""; continue; }
                            if (line.includes("Ending Offload")) { if (currentFlightLines.length > 5) saveFlight(currentFlightLines, currentConfigLine); recording = false; currentFlightLines = []; currentConfigLine = ""; setBusy(false); continue; }
                            if (line.startsWith("CONFIG\t") || line.startsWith("CONFIG ")) { currentConfigLine = line; continue; }
                            if (/^\d/.test(line)) currentFlightLines.push(line);
                        }
                        if (line.includes("Erase Complete")) setBusy(false);
                    }
                }
            } catch (e) { break; } finally { if (reader) { reader.releaseLock(); reader = null; } }
        }
    }

    document.getElementById('file-upload').addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function(e) {
            const contents = e.target.result;
            const allLines = contents.split('\n').map(line => line.trim()).filter(line => line);

            // Optional first line: CONFIG row (saved by this tool when offloaded from device)
            let loadedConfig = "";
            if (allLines.length > 0 && (allLines[0].startsWith("CONFIG\t") || allLines[0].startsWith("CONFIG "))) {
                loadedConfig = allLines.shift();
            }

            // Keep only data rows. Drops any non-data preamble (column header in either
            // firmware or website format, "Logger setup" boot marker, stray MSG lines, etc.)
            // so older raw serial captures load without modification.
            const lines = allLines.filter(line => /^\d/.test(line));

            if (lines.length === 0) {
                logTerm(`Skipped ${file.name}: no data rows found`, "red");
                document.getElementById('file-upload').value = '';
                return;
            }

            // Create a new flight entry from the loaded data
            const flightNum = flightData.length + 1;
            const newFlight = {
                id: Date.now(),
                name: file.name.replace('.txt', ''),
                raw: lines,
                config: loadedConfig
            };

            flightData.push(newFlight);
            refreshList();
            selectFlight(flightData.length - 1);

            logTerm(`Loaded local file: ${file.name}`, "#22c55e");
            // Reset input so you can load the same file again if needed
            document.getElementById('file-upload').value = '';
        };
        reader.readAsText(file);
    });

    function handleLiveLine(line) {
        const parts = line.split(/[\s\t]+/);
        if (parts.length < OLD_MIN_COLS) return;
        liveDataBuffer.push(parts);
        if (liveDataBuffer.length > maxLivePoints) liveDataBuffer.shift();

        if (document.getElementById('live-tab').classList.contains('active') && !document.hidden) {
            requestAnimationFrame(plotLive);
        }
    }

    function updateLiveDashboardWithMostRecent() {
        if (liveDataBuffer.length === 0 || isLiveHovering) return;
        const dash = document.getElementById('live-hover-dashboard');
        const last = liveDataBuffer[liveDataBuffer.length - 1];
        const t0 = parseFloat(liveDataBuffer[0][0]);
        const time = (parseFloat(last[0]) - t0) / 1000;

        let html = `<div class="hover-item">Live Time: <span class="hover-val">${time.toFixed(3)}s</span></div>`;
        activeSeries.forEach(idx => {
            html += `<div class="hover-item">${HEADER[idx]}: <span class="hover-val">${parseFloat(last[idx]).toFixed(2)}</span></div>`;
        });
        dash.innerHTML = html;
    }

    function plotLive() {
        if (liveDataBuffer.length === 0) return;

        const t0 = parseFloat(liveDataBuffer[0][0]);
        const t = liveDataBuffer.map(r => (parseFloat(r[0]) - t0) / 1000);

        const traces = activeSeries.map(idx => {
            const vals = liveDataBuffer.map(r => parseFloat(r[idx]));
            return {
                x: t, y: vals, name: HEADER[idx], mode: 'lines',
                hoverinfo: 'none'
            };
        });

        const gd = document.getElementById('live-plot-container');

        Plotly.react(gd, traces, {
            paper_bgcolor:'rgba(0,0,0,0)', plot_bgcolor:'rgba(0,0,0,0)',
            font:{color:'#f8fafc'}, margin:{t:40, r:20, l:50, b:40},
            hovermode:'x', xaxis:{title:'Time (s)', gridcolor:'#334155', showspikes: true, spikemode: 'across', spikesnap: 'cursor', spikedash: 'dash', spikecolor: '#94a3b8', spikethickness: 1},
            yaxis:{gridcolor:'#334155'}, showlegend: true,
            legend: { orientation: 'h', y: 1.1 }
        }, {responsive: true, displaylogo: false}).then(() => {
            setupHoverEvents('live-plot-container', 'live-hover-dashboard', true);
            updateLiveDashboardWithMostRecent();
        });
    }

    async function sendCmd(msg) {
        if (!port || !port.writable) return;
        setBusy(true);
        const writer = port.writable.getWriter();
        await writer.write(new TextEncoder().encode(msg + "\n"));
        writer.releaseLock();
        logTerm(`>> ${msg}`, "#38bdf8");
        if(!msg.includes("offload") && !msg.includes("erase") && !msg.includes("streamLog")) setTimeout(() => setBusy(false), 800);
    }

    function saveFlight(lines, configLine = "") {
        const flightNum = flightData.length + 1;
        const flight = { id: Date.now(), name: `Flight_${flightNum}`, raw: [...lines], config: configLine || "" };
        flightData.push(flight);
        refreshList();
        selectFlight(flightData.length - 1);
    }

    function refreshList() {
        const list = document.getElementById('flight-list');
        list.innerHTML = '';
        flightData.forEach((f, i) => {
            const item = document.createElement('div');
            item.className = `flight-item ${i === selectedIdx ? 'active' : ''}`;
            item.innerHTML = `<span>${f.name}</span><button class="del-btn" onclick="event.stopPropagation(); deleteLog(${i})">×</button>`;
            item.onclick = () => selectFlight(i);
            list.appendChild(item);
        });
        document.getElementById('clearAllBtn').disabled = (flightData.length === 0);
        document.getElementById('downloadZipBtn').disabled = (flightData.length === 0);
    }

    const FLIGHT_STATE_NAMES = {0:"PRE_FLIGHT", 1:"ASCENT", 2:"DESCENT", 3:"POST_FLIGHT", 4:"UNKNOWN_FLIGHT_STATE"};
    const BOARD_ORIENTATION_NAMES = {0:"ERROR_AXIS_DIRECTION", 1:"POS_X", 2:"NEG_X", 3:"POS_Y", 4:"NEG_Y", 5:"POS_Z", 6:"NEG_Z"};
    const CONFIG_VALUE_FORMATTERS = {
        FLIGHT_STATE: v => `${FLIGHT_STATE_NAMES[parseInt(v)] || '?'} (${v})`,
        BOARD_ORIENTATION: v => `${BOARD_ORIENTATION_NAMES[parseInt(v)] || '?'} (${v})`,
    };

    function openConfigModal() {
        const contentEl = document.getElementById('config-content');
        const f = (selectedIdx >= 0) ? flightData[selectedIdx] : null;
        if (!f || !f.config) {
            contentEl.innerHTML = '<div style="color:#94a3b8">No configuration available for this flight.</div>';
        } else {
            const body = f.config.replace(/^CONFIG[\s\t]+/, '');
            const pairs = body.split(/[\t]+/).filter(p => p.length);
            contentEl.innerHTML = pairs.map(p => {
                const eq = p.indexOf('=');
                if (eq < 0) return `<div style="padding:4px 0">${p}</div>`;
                const k = p.slice(0, eq), v = p.slice(eq + 1);
                const display = CONFIG_VALUE_FORMATTERS[k] ? CONFIG_VALUE_FORMATTERS[k](v) : v;
                return `<div style="display:flex; justify-content:space-between; padding:4px 2px; border-bottom:1px solid #1e293b"><span style="color:#94a3b8">${k}</span><span style="color:var(--accent); font-family:'Courier New',monospace">${display}</span></div>`;
            }).join('');
        }
        document.getElementById('config-modal').style.display = 'flex';
    }
    function closeConfigModal() {
        document.getElementById('config-modal').style.display = 'none';
    }

    function selectFlight(i) {
        selectedIdx = i; refreshList();
        plotFlight(flightData[i]);
        document.getElementById('saveFileBtn').disabled = false;
    }

    function plotFlight(flight) {
        const rows = flight.raw.map(l => l.split(/[\s\t]+/));
        const t0 = parseFloat(rows[0][0]);
        const t = rows.map(r => (parseFloat(r[0]) - t0) / 1000);

        const traces = activeSeries.map(idx => {
            const vals = rows.map(r => parseFloat(r[idx]));
            return {
                x: t, y: vals, name: HEADER[idx], mode: 'lines',
                hoverinfo: 'none'
            };
        });

        const states = rows.map(r => parseInt(r[15]));
        const shapes = [], annotations = [];
        const addEv = (time, txt, col) => {
            shapes.push({ type:'line', x0:time, x1:time, y0:0, y1:1, yref:'paper', line:{color:col, width:1, dash:'dash'} });
            annotations.push({ x:time, y:1, yref:'paper', text:txt, showarrow:false, textangle:-90, xanchor:'right', font:{color:col, size:9} });
        };

        for (let i = 1; i < states.length; i++) {
            if (states[i] !== states[i-1]) addEv(t[i], `${stateNames[states[i-1]]} → ${stateNames[states[i]]}`, 'green');
            if (rows[i][17] == "1" && rows[i-1][17] == "0") addEv(t[i], "DROGUE FIRED", "purple");
            if (rows[i][19] == "1" && rows[i-1][19] == "0") addEv(t[i], "MAIN FIRED", "blue");
        }

        const gd = document.getElementById('plot-container');
        Plotly.newPlot(gd, traces, {
            paper_bgcolor:'rgba(0,0,0,0)', plot_bgcolor:'rgba(0,0,0,0)',
            font:{color:'#f8fafc'}, margin:{t:60, r:20, l:50, b:40},
            hovermode:'x', xaxis:{title:'Time (s)', gridcolor:'#334155', showspikes: true, spikemode: 'across', spikesnap: 'cursor', spikedash: 'dash', spikecolor: '#94a3b8', spikethickness: 1},
            yaxis:{title:'Data', gridcolor:'#334155'}, shapes, annotations,
            showlegend: true,
            legend: { orientation: 'h', yanchor: 'bottom', y: 1.02, xanchor: 'right', x: 1, font: { size: 10, color: '#94a3b8' } }
        }, {responsive: true, displaylogo: false}).then(() => {
            setupHoverEvents('plot-container', 'hover-dashboard', false);
        });

        document.getElementById('stat-alt').innerText = Math.max(...rows.map(r => parseFloat(r[11]))).toFixed(1);
        document.getElementById('stat-vel').innerText = Math.max(...rows.map(r => parseFloat(r[12]))).toFixed(1);
        document.getElementById('stat-state').innerText = stateNames[states[states.length-1]] || '-';
    }

    function setupHoverEvents(plotId, dashId, isLiveTab) {
        const gd = document.getElementById(plotId);
        const dash = document.getElementById(dashId);

        const resetText = () => {
            if (isLiveTab) {
                isLiveHovering = false;
                updateLiveDashboardWithMostRecent();
            } else {
                dash.innerHTML = `<div style="color: #64748b; font-style: italic;">Hover over the chart to see data...</div>`;
            }
        };

        gd.removeAllListeners('plotly_hover');
        gd.removeAllListeners('plotly_unhover');

        gd.on('plotly_hover', data => {
            if (!data || !data.points) return;
            if (isLiveTab) isLiveHovering = true;
            let html = `<div class="hover-item">Time: <span class="hover-val">${data.points[0].x.toFixed(3)}s</span></div>`;
            data.points.forEach(pt => {
                html += `<div class="hover-item">${pt.data.name}: <span class="hover-val">${pt.y.toFixed(2)}</span></div>`;
            });
            dash.innerHTML = html;
        });

        gd.on('plotly_unhover', resetText);

        if (!isLiveTab || !isLiveHovering) resetText();
    }

    function logTerm(msg, color = "#00ff41") {
        termBuffer += `<div style="color:${color}">[${new Date().toLocaleTimeString()}] ${msg}</div>`;
    }

    setInterval(() => {
        if (termBuffer) {
            const t = document.getElementById('terminal');
            t.insertAdjacentHTML('beforeend', termBuffer);
            termBuffer = ""; t.scrollTop = t.scrollHeight;
            while (t.childNodes.length > 80) t.removeChild(t.firstChild);
        }
    }, 100);

    function setSerialEnabled(en) {
        document.querySelectorAll('.ctrl-btn, .cfg-get, .cfg-set, #sendBtn, #offloadBtn, #getAllBtn, #eraseBtn, #streamStartBtn, #streamStopBtn, #logStartBtn, #logStopBtn, #logHealthBtn').forEach(b => b.disabled = !en);
    }

    function initUI() {
        const picker = document.getElementById('series-picker');
        HEADER.forEach((h, i) => {
            if(i === 0) return;
            picker.innerHTML += `<label class="series-opt"><input type="checkbox" data-idx="${i}" ${activeSeries.includes(i) ? 'checked' : ''}> ${h}</label>`;
        });
        const cfgContainer = document.getElementById('config-fields');
        configs.forEach(cfg => {
            const readOnlyAttr = cfg.readOnly ? ' readonly' : '';
            const inputHtml = cfg.type === 'checkbox'
                ? `<input type="checkbox" id="in-${cfg.id}" style="width:20px; height:24px; flex-grow:0; align-self:center; margin-right:auto;"${readOnlyAttr}>`
                : `<input type="text" id="in-${cfg.id}" placeholder="..."${readOnlyAttr}>`;
            const setBtnHtml = cfg.readOnly ? '' : `<button class="btn cfg-set" data-id="${cfg.id}" style="width:50px; padding:2px; height:24px; font-size:0.7rem">Set</button>`;
            cfgContainer.innerHTML += `
                <div class="config-item">
                    <div class="config-label">${cfg.label}</div>
                    <div class="config-input-group">
                        ${inputHtml}
                        <button class="btn btn-secondary cfg-get" data-id="${cfg.id}" style="width:50px; padding:2px; height:24px; font-size:0.7rem">Get</button>
                        ${setBtnHtml}
                    </div>
                </div>`;
        });
    }

    function deleteLog(i) {
        flightData.splice(i, 1);
        if(selectedIdx === i) {
            selectedIdx = -1;
            Plotly.purge('plot-container');
            document.getElementById('saveFileBtn').disabled = true;
            document.getElementById('hover-dashboard').innerHTML = `<div style="color: #64748b; font-style: italic;">Hover over the chart to see data...</div>`;
        }
        refreshList();
    }

    function clearAllSession() {
        if(confirm("Clear current session flights?")) {
            flightData = []; selectedIdx = -1;
            Plotly.purge('plot-container');
            document.getElementById('saveFileBtn').disabled = true;
            document.getElementById('hover-dashboard').innerHTML = `<div style="color: #64748b; font-style: italic;">Hover over the chart to see data...</div>`;
            refreshList();
        }
    }

    function openTab(id) {
        document.querySelectorAll('.tab-content, .tab-btn').forEach(el => el.classList.remove('active'));
        document.getElementById(id).classList.add('active');
        if (event) event.currentTarget.classList.add('active');
    }

    function openSeriesModal() { document.getElementById('series-modal').style.display = 'flex'; }
    function closeSeriesModal() {
        activeSeries = Array.from(document.querySelectorAll('#series-picker input:checked')).map(i => parseInt(i.dataset.idx));
        document.getElementById('series-modal').style.display = 'none';
        if(selectedIdx !== -1) plotFlight(flightData[selectedIdx]);
        if(streaming) plotLive();
    }

    async function confirmErase() { if(confirm("⚠️ Erase flash?")) await sendCmd("--erase"); }

    const cmdInput = document.getElementById('cmd-input');
    cmdInput.onkeydown = e => {
        if(e.key === 'Enter') {
            const val = cmdInput.value.trim();
            if(val) { sendCmd(val); cmdHistory.push(val); historyIdx = cmdHistory.length; cmdInput.value = ''; }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (historyIdx > 0) { historyIdx--; cmdInput.value = cmdHistory[historyIdx]; }
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (historyIdx < cmdHistory.length - 1) { historyIdx++; cmdInput.value = cmdHistory[historyIdx]; } else { historyIdx = cmdHistory.length; cmdInput.value = ''; }
        }
    };

    document.getElementById('history-slider').oninput = function() {
        maxLivePoints = parseInt(this.value);
        document.getElementById('hist-val').innerText = this.value;
    };

    function buildFlightText(f) {
        const parts = [];
        if (f.config) parts.push(f.config);
        parts.push(HEADER.join("\t"));
        parts.push(f.raw.join("\n"));
        return parts.join("\n");
    }

    document.getElementById('saveFileBtn').onclick = () => {
        const f = flightData[selectedIdx];
        const blob = new Blob([buildFlightText(f)], {type: 'text/plain'});
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        a.download = f.name + ".txt"; a.click();
    };

    document.getElementById('downloadZipBtn').onclick = async () => {
        const zip = new JSZip();
        flightData.forEach(f => { zip.file(`${f.name}.txt`, buildFlightText(f)); });
        const content = await zip.generateAsync({type:"blob"});
        const a = document.createElement('a'); a.href = URL.createObjectURL(content);
        a.download = "SillyGoose_All_Flights.zip"; a.click();
    };

    document.getElementById('connectBtn').onclick = connect;
    document.getElementById('disconnectBtn').onclick = disconnect;
    document.getElementById('offloadBtn').onclick = () => sendCmd("--offload");
    document.getElementById('clearAllBtn').onclick = clearAllSession;
    document.getElementById('getAllBtn').onclick = () => configs.forEach((c, i) => setTimeout(() => sendCmd(`--${c.id}`), i * 150));

    window.onload = initUI;

    document.addEventListener('click', e => {
        if(e.target.classList.contains('cfg-get')) {
            const id = e.target.dataset.id;
            sendCmd(`--${id}`);
        }
        if(e.target.classList.contains('cfg-set')) {
            const id = e.target.dataset.id;
            const el = document.getElementById(`in-${id}`);
            const val = el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value;
            sendCmd(`--${id} -set ${val}`);
        }
        if(e.target.classList.contains('ctrl-btn')) {
            sendCmd(e.target.dataset.cmd);
        }
    });
