/* global jsQR, ZXing */
(() => {
  "use strict";

  /* ---------------- 공통 헬퍼 ---------------- */
  const $ = (id) => document.getElementById(id);
  const statusText = { complete: "입고 완료", review: "확인 필요", missing: "실물 미확인" };
  const recordStatusText = { pending: "미처리", match: "수량 일치", short: "수량 부족", over: "수량 초과", nobase: "기준수량 없음" };
  const normalize = (v) => String(v || "").toLowerCase().replace(/[\s()\-_./]/g, "");
  const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const date = (v) => (v ? String(v).slice(0, 10) : "—");
  const now = () => new Date().toISOString();
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const num = (v) => { const n = parseFloat(String(v ?? "").replace(/[^\d.-]/g, "")); return Number.isFinite(n) ? n : null; };
  const qty = (v) => (v === null || v === undefined ? "—" : `${Math.round(v * 1000) / 1000}`);

  const state = {
    records: [], racks: [], meta: null, rackMeta: null,
    placements: [], unlisted: [], conflicts: [], closures: [],
    rack: null, pickZone: null, pickBase: null,
    scanMode: "sample", stream: null, scanFrame: null, cameras: [], cameraIndex: -1,
    scanSession: 0, lastScan: { value: "", at: 0 }, pendingScan: null,
    page: 1, undo: null, wedge: { buffer: "", at: 0 },
    queue: 0, syncing: false, syncTimer: null,
  };
  let device = { id: null, name: "", operator: "", zones: [], isMaster: false };

  const recordMap = () => new Map(state.records.map((x) => [x.id, x]));
  const currentOperator = () => (device.operator || "").trim();
  const placementId = (recordId, rackCode) => `${recordId}|${String(rackCode).toUpperCase()}`;

  /* 검체별 배치 집계 — 한 검체가 여러 랙에 나뉘어 보관될 수 있다. */
  function placementIndex() {
    const map = new Map();
    for (const p of state.placements) {
      const list = map.get(p.recordId) || [];
      list.push(p);
      map.set(p.recordId, list);
    }
    return map;
  }
  const sumOf = (list) => (list || []).reduce((total, p) => total + (num(p.quantity) || 0), 0);

  function recordStatus(record, list) {
    if (!list || !list.length) return "pending";
    const base = num(record?.retentionQuantity);
    if (base === null) return "nobase";
    const placed = sumOf(list);
    if (placed === base) return "match";
    return placed < base ? "short" : "over";
  }

  function toast(message, kind) {
    const el = $("toast");
    el.textContent = message;
    el.className = `toast${kind ? ` ${kind}` : ""}`;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, 4200);
  }

  function download(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }
  const csvCell = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csvFile = (name, rows) => download(name, `﻿${rows.map((r) => r.map(csvCell).join(",")).join("\r\n")}`, "text/csv;charset=utf-8");

  let audioCtx;
  function feedback(kind) {
    if (navigator.vibrate) navigator.vibrate(kind === "ok" ? 40 : [60, 50, 60]);
    if (!$("soundMode").checked) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
      osc.connect(gain); gain.connect(audioCtx.destination);
      osc.frequency.value = { ok: 950, warn: 520, error: 240 }[kind] || 950;
      const dur = kind === "ok" ? 0.11 : 0.34;
      gain.gain.setValueAtTime(0.09, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
      osc.start(); osc.stop(audioCtx.currentTime + dur);
    } catch { /* 오디오 미지원 기기는 무시 */ }
  }

  /* ---------------- 로컬 저장소 ---------------- */
  let dbPromise;
  function openDb() {
    dbPromise = dbPromise || new Promise((resolve, reject) => {
      const req = indexedDB.open("retention-rack-windows-offline", 5);
      req.onupgradeneeded = (event) => {
        const db = req.result, tx = req.transaction;
        if (!db.objectStoreNames.contains("unlisted")) db.createObjectStore("unlisted", { keyPath: "id" });
        if (db.objectStoreNames.contains("audit") && event.oldVersion < 2) db.deleteObjectStore("audit");
        if (!db.objectStoreNames.contains("audit")) db.createObjectStore("audit", { keyPath: "id" });
        if (!db.objectStoreNames.contains("conflicts")) db.createObjectStore("conflicts", { keyPath: "id" });
        if (!db.objectStoreNames.contains("closures")) db.createObjectStore("closures", { keyPath: "rackCode" });
        if (!db.objectStoreNames.contains("placements")) db.createObjectStore("placements", { keyPath: "id" });
        if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "id" });
        if (!db.objectStoreNames.contains("master")) db.createObjectStore("master", { keyPath: "id" });

        // v2 까지는 검체 1건당 랙 1곳만 저장했다. 분산 보관을 지원하려면
        // 검체+랙 조합을 키로 하는 placements 로 옮겨야 한다.
        if (db.objectStoreNames.contains("assignments") && event.oldVersion < 3) {
          const target = tx.objectStore("placements");
          tx.objectStore("assignments").openCursor().onsuccess = (e) => {
            const cursor = e.target.result;
            if (!cursor) return;
            const old = cursor.value;
            if (old.rackCode) {
              target.put({
                id: placementId(old.recordId, old.rackCode), recordId: old.recordId,
                rackCode: old.rackCode, zone: old.zone, rackBase: old.rackBase, level: old.level,
                quantity: num(old.actualQuantity), unit: old.unit || "",
                workStatus: old.workStatus || "complete", note: old.note || "", scanCount: 1,
                deviceId: old.deviceId, deviceName: old.deviceName,
                updatedBy: old.updatedBy, updatedAt: old.updatedAt,
              });
            }
            cursor.continue();
          };
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  async function dbAll(store) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(store, "readonly").objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
  }
  async function dbWrite(store, action, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store)[action](value);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
  }
  async function dbGet(store, key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(store, "readonly").objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
  }
  const dbPut = (store, value) => dbWrite(store, "put", value);
  const dbDelete = (store, key) => dbWrite(store, "delete", key);
  const logAudit = (action, targetId, payload) =>
    dbPut("audit", { id: uuid(), action, targetId, at: now(), deviceId: device.id, deviceName: device.name, performedBy: currentOperator(), payload: JSON.stringify(payload || {}) });

  const byNewest = (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt));
  async function refreshStored() {
    [state.placements, state.unlisted, state.conflicts, state.closures] =
      await Promise.all([dbAll("placements"), dbAll("unlisted"), dbAll("conflicts"), dbAll("closures")]);
    state.placements.sort(byNewest); state.unlisted.sort(byNewest);
    renderAll();
  }

  /* ---------------- 기기 설정 ---------------- */
  function loadDevice() {
    const saved = JSON.parse(localStorage.getItem("qc-device") || "null");
    device = saved || { id: uuid(), name: "", operator: "", zones: [], isMaster: false };
    if (!saved) localStorage.setItem("qc-device", JSON.stringify(device));
  }
  function saveDevice(next) {
    device = { ...device, ...next };
    localStorage.setItem("qc-device", JSON.stringify(device));
    renderDeviceChip();
  }
  function renderDeviceChip() {
    $("deviceChipName").textContent = device.operator || "미설정";
    $("deviceChipScope").textContent = device.isMaster ? "취합용 · 전체 구역"
      : device.zones.length ? `담당 ${device.zones.join(", ")} 구역` : "담당 구역 미지정";
    $("deviceChip").classList.toggle("unset", !device.operator);
  }
  function openSetup() {
    const form = $("setupForm");
    form.operator.value = device.operator;
    form.isMaster.checked = device.isMaster;
    $("setupZones").innerHTML = zoneList().map((z) =>
      `<button type="button" class="chip ${device.zones.includes(z) ? "on" : ""}" data-zone="${esc(z)}">${esc(z)} 구역</button>`).join("");
    $("setupZones").querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => b.classList.toggle("on")));
    $("setupModal").hidden = false;
  }

  /* ---------------- 랙 마스터 ---------------- */
  const zoneList = () => [...new Set(state.racks.map((r) => r.zone))].sort();
  const baseList = (zone) => [...new Set(state.racks.filter((r) => r.zone === zone).map((r) => r.rackBaseCode))].sort();
  const levelList = (base) => [...new Set(state.racks.filter((r) => r.rackBaseCode === base).map((r) => r.level))].sort((a, b) => Number(a) - Number(b));
  const findRack = (code) => state.racks.find((r) => normalize(r.fullCode) === normalize(code));

  function renderPicker() {
    const zones = device.isMaster || !device.zones.length ? zoneList() : zoneList().filter((z) => device.zones.includes(z));
    $("zoneGrid").innerHTML = zones.map((z) =>
      `<button class="chip big ${state.pickZone === z ? "on" : ""}" data-pick="zone" data-value="${esc(z)}">${esc(z)}</button>`).join("");
    $("baseGrid").innerHTML = state.pickZone
      ? baseList(state.pickZone).map((b) => `<button class="chip ${state.pickBase === b ? "on" : ""}" data-pick="base" data-value="${esc(b)}">${esc(b)}</button>`).join("")
      : '<p class="picker-hint">구역을 먼저 선택하세요</p>';
    $("levelGrid").innerHTML = state.pickBase
      ? levelList(state.pickBase).map((l) => {
          const code = `${state.pickBase}-${l}`;
          const here = state.placements.filter((p) => p.rackCode === code);
          return `<button class="chip level" data-pick="level" data-value="${esc(l)}"><b>${esc(l)}단</b><small>${here.length ? `${here.length}건 · ${qty(sumOf(here))}` : "비어 있음"}</small></button>`;
        }).join("")
      : '<p class="picker-hint">랙을 먼저 선택하세요</p>';
    document.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => {
      const { pick, value } = b.dataset;
      if (pick === "zone") { state.pickZone = value; state.pickBase = null; }
      if (pick === "base") state.pickBase = value;
      if (pick === "level") return setRack(`${state.pickBase}-${value}`);
      renderPicker();
    }));
  }

  function setRack(code) {
    const rack = findRack(code);
    if (!rack) return toast(`랙코드 ${code} 를 마스터에서 찾지 못했습니다.`, "bad");
    state.rack = rack;
    localStorage.setItem("qc-rack", rack.fullCode);
    $("rackPicker").hidden = true; $("rackWork").hidden = false;
    $("currentRack").textContent = rack.fullCode;
    renderRackContext(); renderRackItems(); resetScanResult();
    focusScan();
    toast(`${rack.fullCode} 랙 작업을 시작합니다.`);
  }
  function clearRack() {
    state.rack = null; localStorage.removeItem("qc-rack");
    $("rackPicker").hidden = false; $("rackWork").hidden = true;
    renderPicker();
  }
  function renderRackContext() {
    if (!state.rack) return;
    const mine = state.placements.filter((p) => p.deviceId === device.id).length;
    const here = state.placements.filter((p) => p.rackCode === state.rack.fullCode);
    const closed = state.closures.find((c) => c.rackCode === state.rack.fullCode);
    $("currentRackMeta").innerHTML = `${esc(state.rack.zone)} 구역 · ${esc(state.rack.rackBaseCode)} · ${esc(state.rack.level)}단 &nbsp;|&nbsp; 이 랙 <b>${here.length}</b>건 / 수량 <b>${qty(sumOf(here))}</b> · 이 기기 누적 <b>${mine}</b>건${closed ? ' <span class="pill">마감됨</span>' : ""}`;
    $("closeRackBtn").textContent = closed ? "마감 해제" : "이 랙 작업 마감";
  }

  /* ---------------- 스캔 값 → 마스터 매칭 ---------------- */
  function matchRecords(raw) {
    const key = normalize(raw);
    if (!key) return [];
    const exact = (field) => state.records.filter((r) => normalize(r[field]) && normalize(r[field]) === key);
    for (const field of ["requestNumber", "id", "testNumber", "lotNumber"]) {
      const hits = exact(field);
      if (hits.length) return hits;
    }
    const contained = state.records.filter((r) => {
      const req = normalize(r.requestNumber), id = normalize(r.id);
      return (req.length >= 6 && key.includes(req)) || (id.length >= 6 && key.includes(id));
    });
    if (contained.length) return contained;
    const combo = state.records.filter((r) => {
      const code = normalize(r.itemCode), lot = normalize(r.lotNumber);
      return code && lot && key.includes(code) && key.includes(lot);
    });
    if (combo.length) return combo;
    return state.records.filter((r) => normalize(r.lotNumber).length >= 4 && key.includes(normalize(r.lotNumber)));
  }

  /* ---------------- 스캔 처리 ---------------- */
  function focusScan() {
    if (!state.rack || !document.querySelector(".modal-backdrop:not([hidden])")) setTimeout(() => $("scanInput")?.focus(), 30);
  }
  function resetScanResult() { $("scanResult").innerHTML = ""; $("scanReady").textContent = "스캔 대기 중"; }

  async function handleScan(raw, source = "input") {
    const value = String(raw || "").trim();
    if (!value) return;
    if (state.scanMode === "rack") {
      const rack = state.racks.find((r) => normalize(value).includes(normalize(r.fullCode)));
      closeScanner();
      return rack ? setRack(rack.fullCode) : toast(`랙코드를 인식하지 못했습니다: ${value}`, "bad");
    }
    if (state.scanMode === "rackDetail") {
      const rack = state.racks.find((r) => normalize(value).includes(normalize(r.fullCode)));
      $("detailRack").value = (rack?.fullCode || value).toUpperCase();
      closeScanner();
      return;
    }
    // 카메라는 같은 코드를 연속 프레임마다 읽으므로 짧은 시간 내 동일 값은 무시한다.
    // 반대로 스캐너 트리거를 다시 당기거나 직접 입력한 것은 "한 개 더 넣겠다"는 의도이므로 그대로 처리한다.
    if (source === "camera") {
      const stamp = Date.now();
      if (value === state.lastScan.value && stamp - state.lastScan.at < 2500) return;
      state.lastScan = { value, at: stamp };
    }
    await processSampleScan(value);
  }

  async function processSampleScan(value) {
    if (!state.rack) return toast("먼저 랙을 선택하세요.", "bad");
    if (!currentOperator()) { feedback("error"); return toast("작업자명을 먼저 입력하세요.", "bad"); }
    const hits = matchRecords(value);
    if (!hits.length) { feedback("error"); return showScanResult({ type: "none", value }); }
    if (hits.length > 1) { feedback("warn"); return showScanResult({ type: "multi", value, hits }); }
    feedback("ok");
    openQuantity(hits[0], value);
  }

  function showScanResult(result) {
    const box = $("scanResult");
    const card = (cls, title, body, actions) =>
      `<div class="result-card ${cls}"><div class="result-head"><b>${title}</b><span>${esc(result.value || "")}</span></div>${body}<div class="result-actions">${actions || ""}</div></div>`;

    if (result.type === "multi") {
      const index = placementIndex();
      box.innerHTML = card("info", `후보 ${result.hits.length}건 · 하나를 선택하세요`,
        `<div class="result-list">${result.hits.slice(0, 12).map((r) => {
          const list = index.get(r.id) || [];
          const status = recordStatus(r, list);
          return `<button class="result-pick" data-act="pick" data-id="${r.id}"><span><b>${esc(r.productName)}</b><small>${esc(r.requestNumber)} · 제조 ${esc(r.lotNumber)}</small></span><span class="badge ${status}">${list.length ? `${qty(sumOf(list))}/${qty(num(r.retentionQuantity))}` : "미처리"}</span></button>`;
        }).join("")}</div>`, "");
    } else if (result.type === "saved") {
      $("scanReady").textContent = "저장 완료 · 다음 검체를 스캔하세요";
      box.innerHTML = card("ok", `✔ ${esc(result.rackCode)} 저장 완료`,
        `<div class="result-body"><strong>${esc(result.record.productName)}</strong><p>이 랙 <b>${qty(result.here)}</b> · 전체 <b>${qty(result.placed)}</b> / 기준 ${qty(num(result.record.retentionQuantity))} ${esc(result.record.retentionUnit || "")}</p></div>`,
        `<button class="ghost dark" data-act="undo">방금 저장 취소</button><button class="ghost dark" data-act="detail" data-id="${esc(result.pid)}">수정</button>`);
    } else {
      box.innerHTML = card("bad", "일치하는 검체를 찾지 못했습니다",
        `<p class="result-warn">스캔값이 의뢰번호·검체ID·제조번호 어디에도 없습니다. 라벨을 다시 스캔하거나 아래에서 수동으로 검색하세요.</p>`,
        `<button class="ghost dark" data-act="search">수동 검색 열기</button><button class="ghost dark" data-act="unlisted">목록 외 실물 등록</button>`);
    }
    box.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => onResultAction(b.dataset.act, b.dataset.id, result)));
  }

  async function onResultAction(act, id, result) {
    if (act === "undo") return undoLast();
    if (act === "detail") return openDetail(id);
    if (act === "search") { $("manualSearch").open = true; $("productQuery").value = result.value || ""; renderCandidates(); return $("productQuery").focus(); }
    if (act === "unlisted") return openUnlisted();
    if (act === "pick") {
      const record = state.records.find((r) => r.id === id);
      if (record) openQuantity(record, result.value);
    }
  }

  /* ---------------- 수량 확인 팝업 ---------------- */
  // 검체가 여러 랙에 나뉘어 있을 수 있으므로, 저장 전에 기준수량 / 다른 랙 포함 합계 /
  // 이 랙 기존 수량을 모두 보여준 뒤 이번에 넣을 수량을 직접 입력받는다.
  function openQuantity(record, scannedValue) {
    const list = placementIndex().get(record.id) || [];
    const here = list.find((p) => p.rackCode === state.rack.fullCode);
    const base = num(record.retentionQuantity);
    const placed = sumOf(list);
    const unit = record.retentionUnit || "";

    state.pendingScan = { recordId: record.id, scannedValue, hereQty: num(here?.quantity) || 0, placed, base };

    $("qtyForm").dataset.id = record.id;
    $("qtyName").textContent = record.productName || record.id;
    $("qtyMeta").textContent = `제조 ${record.lotNumber || "—"} · 의뢰 ${record.requestNumber || "—"} · ${record.itemCode || ""}`;
    $("qtyMaster").textContent = `${qty(base)} ${unit}`;
    $("qtyPlaced").textContent = `${qty(placed)} ${unit}`;
    $("qtyHere").textContent = `${qty(num(here?.quantity) || 0)} ${unit}`;
    $("qtyRemain").textContent = base === null ? "—" : `${qty(base - placed)} ${unit}`;
    $("qtyUnit").textContent = unit ? `(${unit})` : "";

    const others = list.filter((p) => p.rackCode !== state.rack.fullCode);
    $("qtyBreakdown").innerHTML = list.length
      ? `<small>등록된 위치</small>${list.map((p) => `<span class="${p.rackCode === state.rack.fullCode ? "self" : ""}">${esc(p.rackCode)} <b>${qty(num(p.quantity))}</b></span>`).join("")}`
      : "";

    const alerts = [];
    if (others.length) alerts.push(`다른 랙 ${others.length}곳에 ${qty(sumOf(others))} ${unit} 이 이미 등록되어 있습니다.`);
    if (here) alerts.push(`이 랙에 이미 ${qty(num(here.quantity))} ${unit} 기록이 있습니다. 누적하면 합산됩니다.`);
    $("qtyAlert").hidden = !alerts.length;
    $("qtyAlert").textContent = alerts.join(" ");

    $("qtyValue").value = "";
    $("qtyForm").querySelectorAll('input[name="qtyMode"]').forEach((r) => {
      r.checked = r.value === "add";
      r.closest("label").classList.toggle("checked", r.checked);
    });
    updateQtyPreview();
    $("qtyModal").hidden = false;
    setTimeout(() => $("qtyValue").focus(), 40);
  }

  function updateQtyPreview() {
    const pending = state.pendingScan;
    if (!pending) return;
    const entered = num($("qtyValue").value);
    const mode = $("qtyForm").querySelector('input[name="qtyMode"]:checked')?.value || "add";
    if (entered === null) { $("qtyPreview").textContent = "수량을 입력하세요."; $("qtyPreview").className = "qty-preview"; return; }
    const nextHere = mode === "add" ? pending.hereQty + entered : entered;
    const nextTotal = pending.placed - pending.hereQty + nextHere;
    const over = pending.base !== null && nextTotal > pending.base;
    $("qtyPreview").textContent = `저장 후 이 랙 ${qty(nextHere)} · 전체 ${qty(nextTotal)}${pending.base === null ? "" : ` / ${qty(pending.base)}`}${over ? "  ⚠ 기준수량 초과" : ""}`;
    $("qtyPreview").className = `qty-preview${over ? " over" : ""}`;
  }

  async function submitQuantity(event) {
    event.preventDefault();
    const pending = state.pendingScan;
    const record = state.records.find((r) => r.id === $("qtyForm").dataset.id);
    if (!pending || !record) return;
    const entered = num($("qtyValue").value);
    if (entered === null) { $("qtyValue").focus(); return toast("수량을 입력하세요.", "bad"); }
    if (entered < 0) return toast("수량은 0 이상이어야 합니다.", "bad");
    const mode = $("qtyForm").querySelector('input[name="qtyMode"]:checked').value;
    const saved = await savePlacement(record, {
      quantity: mode === "add" ? pending.hereQty + entered : entered,
      scannedValue: pending.scannedValue,
    });
    $("qtyModal").hidden = true;
    state.pendingScan = null;
    state.scanSession++;
    $("scanSession").textContent = state.scanSession;

    const list = placementIndex().get(record.id) || [];
    showScanResult({ type: "saved", record, rackCode: saved.rackCode, pid: saved.id, here: num(saved.quantity), placed: sumOf(list) });
    feedback("ok");
    if (!$("scanModal").hidden) {
      if ($("keepCamera").checked) scanLoop(); else closeScanner();
    } else focusScan();
  }

  function cancelQuantity() {
    state.pendingScan = null;
    $("qtyModal").hidden = true;
    if (!$("scanModal").hidden) scanLoop(); else focusScan();
  }

  /* ---------------- 저장 · 되돌리기 ---------------- */
  async function savePlacement(record, overrides = {}) {
    const rackCode = (overrides.rackCode || state.rack.fullCode).toUpperCase();
    const rack = findRack(rackCode) || state.rack;
    const id = placementId(record.id, rackCode);
    const previous = state.placements.find((p) => p.id === id) || null;
    const item = {
      id, recordId: record.id, rackCode,
      zone: rack.zone, rackBase: rack.rackBaseCode, level: rack.level,
      quantity: overrides.quantity ?? num(previous?.quantity) ?? null,
      unit: record.retentionUnit || "",
      workStatus: overrides.workStatus || previous?.workStatus || "complete",
      note: overrides.note ?? previous?.note ?? "",
      scanCount: (previous?.scanCount || 0) + 1,
      scannedValue: overrides.scannedValue ?? previous?.scannedValue ?? null,
      deviceId: device.id, deviceName: device.name || device.operator || "미설정",
      updatedBy: currentOperator(), updatedAt: now(),
    };
    await dbPut("placements", item);
    await logAudit(previous ? "placement_update" : "placement_create", id, item);
    await enqueue(item, false);
    state.undo = { id, previous };
    $("undoBtn").disabled = false;
    await refreshStored();
    return item;
  }

  async function undoLast() {
    if (!state.undo) return;
    const { id, previous } = state.undo;
    if (previous) await dbPut("placements", previous); else await dbDelete("placements", id);
    await logAudit("placement_undo", id, { restored: !!previous });
    state.undo = null; $("undoBtn").disabled = true;
    await refreshStored(); resetScanResult();
    toast("방금 저장을 취소했습니다.");
    focusScan();
  }

  /* ---------------- 배치 상세 수정 ---------------- */
  function openDetail(pid) {
    const placement = state.placements.find((p) => p.id === pid);
    if (!placement) return;
    const record = state.records.find((r) => r.id === placement.recordId);
    const list = placementIndex().get(placement.recordId) || [];
    $("detailForm").dataset.id = pid;
    $("detailId").textContent = placement.recordId;
    $("detailName").textContent = record?.productName || placement.recordId;
    $("detailMeta").textContent = `${record?.itemCode || ""} · 의뢰번호 ${record?.requestNumber || ""}`;
    $("detailLot").textContent = record?.lotNumber || "";
    $("detailRequest").textContent = record?.requestNumber || "—";
    $("detailStandard").textContent = `${qty(num(record?.retentionQuantity))} ${record?.retentionUnit || ""}`;
    $("detailExpiry").textContent = date(record?.expiryDate);
    $("detailUntil").textContent = date(record?.retentionUntil);
    $("detailQuantity").value = num(placement.quantity) ?? "";
    $("detailRack").value = placement.rackCode;
    $("detailNote").value = placement.note || "";
    $("detailDelete").hidden = false;

    const others = list.filter((p) => p.id !== pid);
    $("detailAlert").hidden = !others.length;
    $("detailAlert").textContent = others.length
      ? `이 검체는 다른 랙 ${others.length}곳에도 있습니다 — ${others.map((p) => `${p.rackCode} ${qty(num(p.quantity))}`).join(", ")} · 전체 합계 ${qty(sumOf(list))}`
      : "";

    $("detailForm").querySelectorAll('input[name="workStatus"]').forEach((r) => {
      r.checked = r.value === (placement.workStatus || "complete");
      r.closest("label").classList.toggle("checked", r.checked);
    });
    $("detailModal").hidden = false;
  }

  async function submitDetail(event) {
    event.preventDefault();
    if (!currentOperator()) return toast("작업자명을 먼저 입력하세요.", "bad");
    const pid = $("detailForm").dataset.id;
    const placement = state.placements.find((p) => p.id === pid);
    const record = state.records.find((r) => r.id === placement.recordId);
    const rackCode = $("detailRack").value.trim().toUpperCase();
    if (!rackCode) return toast("랙코드가 필요합니다.", "bad");
    const quantity = num($("detailQuantity").value);
    if (quantity === null) return toast("수량을 입력하세요.", "bad");
    // 랙을 옮긴 경우 이전 위치 기록은 지워야 수량이 두 번 잡히지 않는다.
    if (rackCode !== placement.rackCode) await dbDelete("placements", pid);
    await savePlacement(record, {
      rackCode, quantity,
      workStatus: $("detailForm").querySelector('input[name="workStatus"]:checked').value,
      note: $("detailNote").value.trim(),
    });
    $("detailModal").hidden = true;
    toast(`${record?.productName || placement.recordId} 수정 완료`);
  }

  async function deleteDetail() {
    const pid = $("detailForm").dataset.id;
    const removed = state.placements.find((p) => p.id === pid);
    await dbDelete("placements", pid);
    await logAudit("placement_delete", pid, {});
    if (removed) await enqueue(removed, true);
    $("detailModal").hidden = true;
    await refreshStored();
    toast("이 위치의 기록을 삭제했습니다.");
  }

  /* ---------------- 목록 외 실물 ---------------- */
  function openUnlisted() {
    $("unlistedRack").textContent = state.rack?.fullCode || "랙 미선택";
    $("unlistedModal").hidden = false;
  }
  async function saveUnlisted(event) {
    event.preventDefault();
    if (!currentOperator()) return toast("작업자명을 먼저 입력하세요.", "bad");
    if (!state.rack) return toast("먼저 랙을 선택하세요.", "bad");
    const f = new FormData(event.target);
    const item = {
      id: `EXTRA-${uuid()}`,
      productName: String(f.get("productName")).trim(), lotNumber: String(f.get("lotNumber")).trim(),
      expiryDate: f.get("expiryDate") || null, quantity: num(f.get("actualQuantity")), unit: f.get("unit") || "EA",
      rackCode: state.rack.fullCode, zone: state.rack.zone, rackBase: state.rack.rackBaseCode, level: state.rack.level,
      note: f.get("note") || "", deviceId: device.id, deviceName: device.name, updatedBy: currentOperator(), updatedAt: now(),
    };
    await dbPut("unlisted", item);
    await logAudit("unlisted_create", item.id, item);
    await enqueue({ ...item, recordId: item.id, workStatus: "unlisted", scanCount: 1 }, false);
    event.target.reset();
    $("unlistedModal").hidden = true;
    await refreshStored();
    toast("목록 외 실물을 저장했습니다.");
  }

  /* ---------------- 렌더링 ---------------- */
  function renderAll() { renderSummary(); renderRackContext(); renderRackItems(); renderCandidates(); renderList(); renderRacks(); renderIssues(); renderDevices(); }

  function renderSummary() {
    const index = placementIndex();
    let match = 0, short = 0, over = 0, nobase = 0;
    for (const [recordId, list] of index) {
      const record = state.records.find((r) => r.id === recordId);
      const status = recordStatus(record, list);
      if (status === "match") match++; else if (status === "short") short++; else if (status === "over") over++; else nobase++;
    }
    const touched = index.size;
    const rate = state.records.length ? Math.round((touched / state.records.length) * 1000) / 10 : 0;
    const attention = over + state.unlisted.length + state.conflicts.length
      + state.placements.filter((p) => p.workStatus !== "complete").length;
    $("rateLabel").textContent = "배치된 검체 비율";
    $("rate").textContent = `${rate}%`;
    $("ring").style.setProperty("--p", `${rate * 3.6}deg`);
    $("processed").textContent = touched.toLocaleString();
    $("total").textContent = state.records.length.toLocaleString();
    $("complete").textContent = (match + nobase).toLocaleString();
    $("short").textContent = short.toLocaleString();
    $("over").textContent = over.toLocaleString();
    $("conflictCount").textContent = attention.toLocaleString();
    $("issueShort").textContent = short;
    $("issueOver").textContent = over;
    $("issueUnlisted").textContent = state.unlisted.length;
    $("issueConflict").textContent = state.conflicts.length;
  }

  function renderRackItems() {
    if (!state.rack) return;
    const rmap = recordMap(), index = placementIndex();
    const rows = state.placements.filter((p) => p.rackCode === state.rack.fullCode);
    const extras = state.unlisted.filter((u) => u.rackCode === state.rack.fullCode);
    $("rackCount").textContent = `${rows.length + extras.length}건 · ${qty(sumOf(rows))}`;
    $("rackItems").innerHTML = [
      ...rows.map((p) => {
        const record = rmap.get(p.recordId);
        const list = index.get(p.recordId) || [];
        const elsewhere = list.length > 1 ? `<em>다른 랙 ${list.length - 1}곳 · 합계 ${qty(sumOf(list))}/${qty(num(record?.retentionQuantity))}</em>` : "";
        return `<button class="rack-item" data-id="${esc(p.id)}"><span><b>${esc(record?.productName || p.recordId)}</b><small>제조 ${esc(record?.lotNumber)} · ${esc(record?.requestNumber)}</small>${elsewhere}</span><span class="qty-badge">${qty(num(p.quantity))}<small>${esc(p.unit || "")}</small></span></button>`;
      }),
      ...extras.map((u) => `<div class="rack-item extra"><span><b>${esc(u.productName)}</b><small>제조 ${esc(u.lotNumber)} · 목록 외</small></span><span class="qty-badge">${qty(num(u.quantity))}<small>${esc(u.unit || "")}</small></span></div>`),
    ].join("") || '<p class="picker-hint">아직 이 랙에 담긴 검체가 없습니다. 제품 바코드를 스캔하세요.</p>';
    $("rackItems").querySelectorAll(".rack-item[data-id]").forEach((b) => b.addEventListener("click", () => openDetail(b.dataset.id)));
  }

  function candidateRecords() {
    const pq = normalize($("productQuery").value), lq = normalize($("lotQuery").value);
    if (!pq && !lq) return [];
    return state.records
      .filter((r) => (!pq || normalize(`${r.productName} ${r.itemCode} ${r.requestNumber} ${r.id}`).includes(pq)) && (!lq || normalize(r.lotNumber).includes(lq)))
      .slice(0, 20);
  }
  function renderCandidates() {
    const rows = candidateRecords(), index = placementIndex();
    $("candidateCount").textContent = rows.length ? `${rows.length}건 표시` : "검색어를 입력하세요";
    $("candidates").innerHTML = rows.map((r) => {
      const list = index.get(r.id) || [];
      const status = recordStatus(r, list);
      return `<button class="candidate" data-id="${r.id}"><div class="candidate-main"><div><strong>${esc(r.productName)}</strong><small>${esc(r.itemCode)} · ${esc(r.requestNumber)}</small></div><div><span>제조번호</span><strong>${esc(r.lotNumber)}</strong></div></div><div class="candidate-meta"><span>기준 ${qty(num(r.retentionQuantity))}${esc(r.retentionUnit)}</span><span>보관기한 ${date(r.retentionUntil)}</span><span class="badge ${status}">${list.length ? `${qty(sumOf(list))} · ${list.length}곳` : "미처리"}</span></div></button>`;
    }).join("");
    $("candidates").querySelectorAll(".candidate").forEach((b) =>
      b.addEventListener("click", () => {
        const record = state.records.find((r) => r.id === b.dataset.id);
        if (!state.rack) return toast("먼저 랙을 선택하세요.", "bad");
        if (record) openQuantity(record, $("productQuery").value);
      }));
  }

  function filteredList() {
    const q = normalize($("listQuery").value), filter = $("listStatus").value, scope = $("listScope").value;
    const index = placementIndex();
    return state.records.filter((r) => {
      const list = index.get(r.id) || [];
      if (scope === "mine" && list.length && !list.some((p) => p.deviceId === device.id)) return false;
      const status = recordStatus(r, list);
      const statusOk = filter === "all" || (filter === "pending" && status === "pending") || status === filter;
      const racks = list.map((p) => p.rackCode).join(" ");
      return statusOk && (!q || normalize(`${r.productName} ${r.lotNumber} ${r.requestNumber} ${racks}`).includes(q));
    });
  }
  function renderList() {
    if (!state.records.length) return;
    const rows = filteredList(), pages = Math.max(1, Math.ceil(rows.length / 20));
    if (state.page > pages) state.page = pages;
    const index = placementIndex();
    $("listBody").innerHTML = rows.slice((state.page - 1) * 20, state.page * 20).map((r) => {
      const list = index.get(r.id) || [];
      const status = recordStatus(r, list);
      const base = num(r.retentionQuantity), placed = sumOf(list);
      const diff = base === null || !list.length ? null : placed - base;
      const where = list.map((p) => `${p.rackCode} ${qty(num(p.quantity))}`).join(" · ");
      return `<button class="data-card" data-id="${r.id}">
        <div class="dc-top"><b>${esc(r.productName)}</b><span class="badge ${status}">${recordStatusText[status]}</span></div>
        <div class="dc-sub">제조 ${esc(r.lotNumber)} · ${esc(r.requestNumber)}</div>
        <div class="dc-nums"><span>기준 <b>${qty(base)}${esc(r.retentionUnit || "")}</b></span><span>배치 <b>${list.length ? qty(placed) : "—"}</b></span>${diff ? `<span class="diff">차이 <b>${diff > 0 ? "+" : ""}${qty(diff)}</b></span>` : ""}</div>
        ${where ? `<div class="dc-where">${esc(where)}</div>` : ""}
      </button>`;
    }).join("") || '<p class="picker-hint">해당하는 검체가 없습니다.</p>';
    $("pageInfo").textContent = `${rows.length.toLocaleString()}건 · ${state.page}/${pages}페이지`;
    $("prevPage").disabled = state.page <= 1; $("nextPage").disabled = state.page >= pages;
    $("listBody").querySelectorAll(".data-card").forEach((card) => card.addEventListener("click", () => {
      const list = placementIndex().get(card.dataset.id) || [];
      if (list.length) return openDetail(list[0].id);
      const record = state.records.find((r) => r.id === card.dataset.id);
      if (!state.rack) return toast("먼저 [스캔] 탭에서 랙을 선택하세요.", "bad");
      showTab("work");
      openQuantity(record, "");
    }));
  }

  function rackGroups() {
    const groups = new Map(), rmap = recordMap();
    state.placements.forEach((p) => {
      const g = groups.get(p.rackCode) || { count: 0, quantity: 0, products: new Set(), devices: new Set(), last: "" };
      g.count++; g.quantity += num(p.quantity) || 0;
      const record = rmap.get(p.recordId); if (record?.productName) g.products.add(record.productName);
      if (p.deviceName) g.devices.add(p.deviceName);
      if (String(p.updatedAt) > g.last) g.last = p.updatedAt;
      groups.set(p.rackCode, g);
    });
    return groups;
  }
  function renderRacks() {
    const groups = rackGroups();
    $("rackSummary").textContent = `${groups.size} / ${new Set(state.racks.map((r) => r.fullCode)).size}개 위치 사용`;
    $("rackGrid").innerHTML = [...groups.entries()].sort().map(([code, g]) => {
      const closed = state.closures.find((c) => c.rackCode === code);
      return `<article class="rack-card ${closed ? "closed" : ""}"><small>랙코드</small><h3>${esc(code)}</h3><b>${g.count}건</b><p>${esc([...g.products].slice(0, 3).join(" · "))}</p><small>수량 ${qty(g.quantity)} · ${g.products.size}개 품목 · ${esc([...g.devices].join(", ") || "—")}</small>${closed ? '<span class="pill">마감</span>' : ""}</article>`;
    }).join("") || '<p class="picker-hint">아직 배치된 검체가 없습니다.</p>';
  }

  function renderIssues() {
    const index = placementIndex(), rmap = recordMap();
    const rows = [];
    for (const [recordId, list] of index) {
      const record = rmap.get(recordId);
      const status = recordStatus(record, list);
      if (status === "short" || status === "over") {
        rows.push({ kind: recordStatusText[status], record, base: num(record?.retentionQuantity), placed: sumOf(list),
          detail: list.map((p) => `${p.rackCode} ${qty(num(p.quantity))}`).join(", "), by: list[0]?.updatedBy });
      }
    }
    state.placements.filter((p) => p.workStatus !== "complete").forEach((p) => {
      const record = rmap.get(p.recordId);
      rows.push({ kind: statusText[p.workStatus], record, base: num(record?.retentionQuantity), placed: num(p.quantity), detail: p.rackCode, by: p.updatedBy });
    });
    state.unlisted.forEach((u) => rows.push({ kind: "목록 외 실물", record: { productName: u.productName, lotNumber: u.lotNumber, requestNumber: "—" }, base: null, placed: num(u.quantity), detail: u.rackCode, by: u.updatedBy }));
    state.conflicts.forEach((c) => rows.push({ kind: "병합 충돌", record: rmap.get(c.recordId), base: null, placed: null,
      detail: c.entries.map((e) => `${e.rackCode} ${qty(num(e.quantity))} (${e.deviceName})`).join(" ↔ "), by: c.entries.map((e) => e.updatedBy).join(" ↔ "), conflict: true }));

    $("issueBody").innerHTML = rows.map((x) =>
      `<div class="data-card static ${x.conflict ? "conflict" : ""}">
        <div class="dc-top"><b>${esc(x.record?.productName)}</b><span class="badge ${x.conflict ? "over" : "short"}">${esc(x.kind)}</span></div>
        <div class="dc-sub">제조 ${esc(x.record?.lotNumber)} · ${esc(x.record?.requestNumber)}</div>
        <div class="dc-nums"><span>기준 <b>${qty(x.base)}</b></span><span>합계 <b>${qty(x.placed)}</b></span></div>
        <div class="dc-where">${esc(x.detail)}${x.by ? ` · ${esc(x.by)}` : ""}</div>
      </div>`
    ).join("") || '<p class="picker-hint">점검할 대상이 없습니다.</p>';
  }

  function renderDevices() {
    const devices = new Map();
    state.placements.forEach((p) => {
      const key = p.deviceId || "unknown";
      const d = devices.get(key) || { name: p.deviceName || "—", count: 0, racks: new Set(), zones: new Set(), last: "" };
      d.count++; if (p.rackCode) d.racks.add(p.rackCode); if (p.zone) d.zones.add(p.zone);
      if (String(p.updatedAt) > d.last) d.last = p.updatedAt;
      devices.set(key, d);
    });
    $("deviceTotal").textContent = `${devices.size}명 · 배치 ${state.placements.length.toLocaleString()}건`;
    $("deviceBody").innerHTML = [...devices.entries()].map(([id, d]) =>
      `<div class="data-card static">
        <div class="dc-top"><b>${esc(d.name)}</b>${id === device.id ? '<span class="badge match">이 기기</span>' : '<span class="badge">병합됨</span>'}</div>
        <div class="dc-nums"><span>처리 <b>${d.count.toLocaleString()}건</b></span><span>랙 <b>${d.racks.size}개</b></span><span>구역 <b>${esc([...d.zones].sort().join(",") || "—")}</b></span></div>
        <div class="dc-where">${esc(String(d.last).replace("T", " ").slice(0, 16))}</div>
      </div>`
    ).join("") || '<p class="picker-hint">아직 작업 데이터가 없습니다.</p>';
  }

  function showTab(name) {
    document.querySelectorAll(".tab-panel").forEach((p) => { p.hidden = true; });
    const panel = $(`${name}Tab`);
    if (panel) panel.hidden = false;
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    window.scrollTo(0, 0);
    if (name === "work") focusScan();
    if (name === "status") { renderList(); renderRacks(); renderIssues(); }
  }

  // 현황 탭 안의 세 화면(검체 목록 / 랙 현황 / 점검) 전환
  function showView(name) {
    ["list", "racks", "issues"].forEach((v) => { const el = $(`${v}View`); if (el) el.hidden = v !== name; });
    document.querySelectorAll(".segment button").forEach((b) => b.classList.toggle("on", b.dataset.view === name));
  }

  /* ---------------- 카메라 ---------------- */
  async function openScanner(mode) {
    state.scanMode = mode;
    const isRack = mode !== "sample";
    $("scanTitle").textContent = isRack ? "랙 라벨 촬영" : "제품 라벨 촬영";
    $("scanHint").textContent = isRack
      ? "랙에 부착된 QR 또는 바코드를 가운데 띠에 맞추세요."
      : "바코드를 가운데 가로 띠에 가득 차게 맞추세요. 인식되면 수량 입력창이 뜨고, 저장 후 계속 스캔할 수 있습니다.";
    $("manualScan").placeholder = isRack ? "랙코드 직접 입력" : "의뢰번호 또는 코드 직접 입력";
    $("manualScan").value = ""; $("scanError").hidden = true;
    $("finishScanBtn").hidden = isRack;
    state.scanSession = 0; $("scanSession").textContent = "0";
    state.lastScan = { value: "", at: 0 };
    $("scanModal").hidden = false;
    await startCamera();
  }

  // 태블릿은 후면 카메라가 기본이지만 기기마다 구성이 달라, 권한 허용 후
  // 실제 장치 목록을 읽어 두고 버튼으로 순환 전환한다.
  async function startCamera() {
    stopCamera();
    const saved = localStorage.getItem("qc-camera");
    const constraints = state.cameras.length && state.cameraIndex >= 0
      ? { video: { deviceId: { exact: state.cameras[state.cameraIndex].deviceId } }, audio: false }
      : { video: saved ? { deviceId: { ideal: saved } } : { facingMode: { ideal: "environment" } }, audio: false };
    try {
      state.stream = await navigator.mediaDevices.getUserMedia(constraints);
      const video = $("video");
      video.srcObject = state.stream;
      await video.play();
      await refreshCameraList();
      scanLoop();
    } catch {
      $("scanError").textContent = "카메라를 열지 못했습니다. Windows 설정 > 개인정보 및 보안 > 카메라 에서 권한을 허용하거나, 아래에 코드를 직접 입력하세요.";
      $("scanError").hidden = false;
      $("switchCamBtn").hidden = true;
    }
  }

  async function refreshCameraList() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      state.cameras = devices.filter((d) => d.kind === "videoinput");
    } catch { state.cameras = []; }
    const active = state.stream?.getVideoTracks()[0];
    const activeId = active?.getSettings?.().deviceId;
    if (activeId) {
      const index = state.cameras.findIndex((c) => c.deviceId === activeId);
      if (index >= 0) state.cameraIndex = index;
      localStorage.setItem("qc-camera", activeId);
    }
    $("switchCamBtn").hidden = state.cameras.length < 2;
    $("camLabel").textContent = state.cameras.length > 1
      ? `${state.cameraIndex + 1}/${state.cameras.length} · ${active?.label || "카메라"}`
      : active?.label || "";
  }

  async function switchCamera() {
    if (state.cameras.length < 2) return;
    state.cameraIndex = (state.cameraIndex + 1) % state.cameras.length;
    await startCamera();
    toast(`카메라 전환: ${state.cameras[state.cameraIndex]?.label || `${state.cameraIndex + 1}번`}`);
  }

  function stopCamera() {
    if (state.scanFrame) clearTimeout(state.scanFrame);
    state.scanFrame = null;
    state.stream?.getTracks().forEach((t) => t.stop());
    state.stream = null;
    $("video").srcObject = null;
  }

  // jsQR 은 QR 전용이라 제품 라벨의 1차원 바코드를 읽지 못한다. 1D 는 ZXing 으로 처리한다.
  let oneDReader, bandCanvas, scanTick = 0;
  function getOneDReader() {
    if (oneDReader || typeof ZXing === "undefined") return oneDReader;
    const hints = new Map();
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
      ZXing.BarcodeFormat.CODE_128, ZXing.BarcodeFormat.CODE_39, ZXing.BarcodeFormat.CODE_93,
      ZXing.BarcodeFormat.ITF, ZXing.BarcodeFormat.CODABAR,
      ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8,
      ZXing.BarcodeFormat.UPC_A, ZXing.BarcodeFormat.UPC_E,
    ]);
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    oneDReader = new ZXing.MultiFormatReader();
    oneDReader.setHints(hints);
    return oneDReader;
  }

  // 1차원 바코드는 가로로 길기 때문에 화면 중앙의 가로 띠만 잘라 넘기면
  // 배경 잡음이 줄어 인식률이 오르고 처리량도 줄어든다.
  function decodeOneD(sourceCanvas) {
    const reader = getOneDReader();
    if (!reader || !sourceCanvas.width) return null;
    bandCanvas = bandCanvas || document.createElement("canvas");
    const bandHeight = Math.max(60, Math.round(sourceCanvas.height * 0.45));
    const top = Math.round((sourceCanvas.height - bandHeight) / 2);
    bandCanvas.width = sourceCanvas.width;
    bandCanvas.height = bandHeight;
    bandCanvas.getContext("2d", { willReadFrequently: true })
      .drawImage(sourceCanvas, 0, top, sourceCanvas.width, bandHeight, 0, 0, sourceCanvas.width, bandHeight);
    // 이진화 방식에 따라 인식 여부가 갈린다. Hybrid 는 조명이 고르지 않은 실제 촬영에,
    // GlobalHistogram 은 선명하고 대비가 균일한 라벨에 강해서 둘 다 시도한다.
    for (const Binarizer of [ZXing.HybridBinarizer, ZXing.GlobalHistogramBinarizer]) {
      try {
        const luminance = new ZXing.HTMLCanvasElementLuminanceSource(bandCanvas);
        const text = reader.decode(new ZXing.BinaryBitmap(new Binarizer(luminance)))?.getText();
        if (text) return text;
      } catch { /* 이 방식으로는 못 찾음 */ } finally {
        try { reader.reset(); } catch { /* 무시 */ }
      }
    }
    return null;
  }

  function scanLoop() {
    if (!state.stream || !$("qtyModal").hidden) return; // 수량 입력 중에는 멈춘다
    const video = $("video"), canvas = $("scanCanvas"), ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const qr = jsQR(image.data, image.width, image.height, { inversionAttempts: "attemptBoth" });
      if (qr?.data) return handleScan(qr.data, "camera");
      if (++scanTick % 2 === 0) {
        const oneD = decodeOneD(canvas);
        if (oneD) return handleScan(oneD, "camera");
      }
    }
    // requestAnimationFrame 은 창이 비활성이면 멈춘다. 스캔은 계속 돌아야 하므로 타이머로 돌린다.
    state.scanFrame = setTimeout(scanLoop, 80);
  }
  function closeScanner() {
    stopCamera();
    $("scanModal").hidden = true;
    focusScan();
  }

  /* ---------------- 내보내기 · 백업 · 병합 ---------------- */
  const SUMMARY_HEADERS = ["검체ID", "의뢰번호", "품목코드", "품목명", "제조번호", "유효기한", "보관기한", "기준수량", "단위", "배치합계", "차이", "위치수", "위치내역", "상태", "최종확인자", "최종기기", "최종확인일시"];
  function summaryRows(onlyIssues) {
    const index = placementIndex();
    return state.records.map((record) => {
      const list = (index.get(record.id) || []).slice().sort((a, b) => a.rackCode.localeCompare(b.rackCode));
      const status = recordStatus(record, list);
      if (onlyIssues && (status === "match")) return null;
      const base = num(record.retentionQuantity), placed = sumOf(list);
      const latest = list.slice().sort(byNewest)[0];
      return [record.id, record.requestNumber, record.itemCode, record.productName, record.lotNumber,
        record.expiryDate, record.retentionUntil, qty(base), record.retentionUnit || "",
        list.length ? qty(placed) : "", base === null || !list.length ? "" : qty(placed - base),
        list.length, list.map((p) => `${p.rackCode}:${qty(num(p.quantity))}`).join("; "),
        recordStatusText[status], latest?.updatedBy || "", latest?.deviceName || "", latest?.updatedAt || ""];
    }).filter(Boolean);
  }
  function exportCsv(mode) {
    const extras = state.unlisted.map((u) => [u.id, "", "", u.productName, u.lotNumber, u.expiryDate, "", "", u.unit || "",
      qty(num(u.quantity)), "", 1, `${u.rackCode}:${qty(num(u.quantity))}`, "목록 외 실물", u.updatedBy, u.deviceName, u.updatedAt]);
    csvFile(`보관검체_${mode === "all" ? "전체결과" : "점검목록"}_${now().slice(0, 10)}.csv`,
      [SUMMARY_HEADERS, ...summaryRows(mode !== "all"), ...extras]);
    toast("CSV 파일을 저장했습니다.");
  }

  function exportPlacements() {
    const rmap = recordMap();
    const rows = state.placements.slice().sort((a, b) => a.id.localeCompare(b.id)).map((p) => {
      const record = rmap.get(p.recordId);
      return [p.id, p.recordId, record?.requestNumber || "", record?.productName || "", record?.lotNumber || "",
        p.rackCode, p.zone, p.rackBase, p.level, qty(num(p.quantity)), p.unit || "",
        statusText[p.workStatus] || p.workStatus, p.scanCount || "", p.note || "", p.updatedBy, p.deviceName, p.updatedAt];
    });
    const extras = state.unlisted.map((u) => [u.id, u.id, "", u.productName, u.lotNumber, u.rackCode, u.zone, u.rackBase, u.level,
      qty(num(u.quantity)), u.unit || "", "목록 외 실물", "", u.note || "", u.updatedBy, u.deviceName, u.updatedAt]);
    csvFile(`보관검체_배치상세_${now().slice(0, 10)}.csv`,
      [["배치ID", "검체ID", "의뢰번호", "품목명", "제조번호", "랙코드", "구역", "랙", "단", "수량", "단위", "확인결과", "스캔횟수", "비고", "확인자", "기기명", "확인일시"], ...rows, ...extras]);
    toast("배치상세 CSV를 저장했습니다.");
  }

  // LIMS 업체에 넘길 일괄 반영용 파일. 컬럼 구성은
  // "LIMS_보관검체_랙위치_일괄반영_요청_예시.xlsx" 의 [업로드데이터] 시트와 동일하게 유지한다.
  function limsNote(list, unit) {
    return list.map((p) => `${p.rackCode} (${qty(num(p.quantity))}${unit || "EA"})`).join(", ");
  }
  function exportLimsCsv() {
    const index = placementIndex();
    const rows = [];
    let seq = 0;
    for (const record of state.records) {
      const list = (index.get(record.id) || []).slice().sort((a, b) => a.rackCode.localeCompare(b.rackCode));
      if (!list.length) continue;
      const base = num(record.retentionQuantity), placed = sumOf(list);
      const unit = record.retentionUnit || "EA";
      const latest = list.slice().sort(byNewest)[0];
      rows.push([++seq, record.requestNumber, record.itemCode, record.lotNumber,
        record.productName, record.testNumber, qty(base), unit, record.containerCount,
        limsNote(list, unit), list[0].rackCode,
        qty(placed), list.length,
        base === null ? "기준없음" : (placed === base ? "일치" : placed < base ? "부족" : "초과"),
        String(latest?.updatedAt || "").replace("T", " ").slice(0, 16)]);
    }
    if (!rows.length) return toast("아직 배치된 검체가 없습니다.", "bad");
    csvFile(`LIMS_보관검체_랙위치_일괄반영_${now().slice(0, 10)}.csv`,
      [["순번", "의뢰번호", "품목코드", "제조번호", "품목명", "시험번호", "검체량(기준)", "단위", "통수",
        "비고 (랙 위치)", "보관위치 (선택 반영)", "배치수량 합계", "위치 수", "수량확인", "확인일시"], ...rows]);
    toast(`LIMS 업로드용 ${rows.length.toLocaleString()}건을 저장했습니다.`);
  }

  function exportRackCsv() {
    const groups = rackGroups();
    const rows = [...groups.entries()].sort().map(([code, g]) => {
      const rack = findRack(code), closed = state.closures.find((c) => c.rackCode === code);
      return [code, rack?.zone || "", rack?.rackBaseCode || "", rack?.level || "", g.count, qty(g.quantity), g.products.size,
        [...g.devices].join(" / "), closed ? "마감" : "작업중", String(g.last).replace("T", " ").slice(0, 16)];
    });
    csvFile(`보관검체_랙별집계_${now().slice(0, 10)}.csv`,
      [["랙코드", "구역", "랙", "단", "배치건수", "총수량", "품목수", "작업기기", "마감상태", "마지막작업"], ...rows]);
    toast("랙별 집계 CSV를 저장했습니다.");
  }

  async function backup() {
    const payload = {
      format: "retention-rack-windows-offline", version: 3, exportedAt: now(),
      device: { id: device.id, name: device.name, zones: device.zones, isMaster: device.isMaster },
      placements: await dbAll("placements"), unlisted: await dbAll("unlisted"),
      closures: await dbAll("closures"), audit: await dbAll("audit"),
    };
    const safeName = (device.name || "기기").replace(/[\\/:*?"<>|]/g, "");
    download(`보관검체_백업_${safeName}_${now().slice(0, 10)}.json`, JSON.stringify(payload, null, 2), "application/json");
    toast(`배치 ${payload.placements.length}건을 백업 파일로 저장했습니다.`);
  }

  async function merge(event) {
    const files = [...(event.target.files || [])];
    if (!files.length) return;
    const summary = { files: 0, added: 0, updated: 0, conflicts: 0, extras: 0, skipped: 0 };
    try {
      const current = new Map((await dbAll("placements")).map((p) => [p.id, p]));
      const extraIds = new Set((await dbAll("unlisted")).map((u) => u.id));
      const conflicts = new Map((await dbAll("conflicts")).map((c) => [c.id, c]));

      for (const file of files) {
        let data;
        try { data = JSON.parse(await file.text()); } catch { summary.skipped++; continue; }
        if (data.format !== "retention-rack-windows-offline") { summary.skipped++; continue; }
        summary.files++;

        // v2 백업(검체 1건 = 랙 1곳)도 받아 배치 형태로 변환한다.
        const incoming = data.placements || (data.assignments || []).filter((a) => a.rackCode).map((a) => ({
          id: placementId(a.recordId, a.rackCode), recordId: a.recordId, rackCode: a.rackCode,
          zone: a.zone, rackBase: a.rackBase, level: a.level, quantity: num(a.actualQuantity),
          unit: "", workStatus: a.workStatus || "complete", note: a.note || "", scanCount: 1,
          deviceId: a.deviceId, deviceName: a.deviceName, updatedBy: a.updatedBy, updatedAt: a.updatedAt,
        }));

        for (const p of incoming) {
          const old = current.get(p.id);
          if (!old) { await dbPut("placements", p); current.set(p.id, p); summary.added++; continue; }
          // 같은 검체+랙을 서로 다른 기기가 다른 수량으로 기록한 경우만 진짜 충돌이다.
          // (같은 검체가 여러 랙에 있는 것은 분산 보관으로 정상 처리한다.)
          if (old.deviceId !== p.deviceId && num(old.quantity) !== num(p.quantity)) {
            const entry = conflicts.get(p.id) || { id: p.id, recordId: p.recordId, entries: [], detectedAt: now() };
            const seen = new Set(entry.entries.map((e) => `${e.deviceId}|${e.quantity}`));
            [old, p].forEach((x) => {
              if (seen.has(`${x.deviceId}|${x.quantity}`)) return;
              entry.entries.push({ rackCode: x.rackCode, quantity: x.quantity, deviceId: x.deviceId, deviceName: x.deviceName, updatedBy: x.updatedBy, updatedAt: x.updatedAt });
            });
            conflicts.set(p.id, entry);
            await dbPut("conflicts", entry);
            summary.conflicts++;
          }
          if (String(p.updatedAt) > String(old.updatedAt)) { await dbPut("placements", p); current.set(p.id, p); summary.updated++; }
        }
        for (const extra of data.unlisted || []) if (!extraIds.has(extra.id)) { await dbPut("unlisted", extra); extraIds.add(extra.id); summary.extras++; }
        for (const closure of data.closures || []) await dbPut("closures", closure);
        for (const entry of data.audit || []) if (entry.id) await dbPut("audit", entry);
      }

      await logAudit("merge", "-", summary);
      await refreshStored();
      showTab("settings");
      const parts = [`${summary.files}개 파일`, `신규 ${summary.added}건`, `갱신 ${summary.updated}건`, `목록외 ${summary.extras}건`];
      if (summary.conflicts) parts.push(`⚠ 충돌 ${summary.conflicts}건`);
      if (summary.skipped) parts.push(`제외 ${summary.skipped}개`);
      toast(`병합 완료 · ${parts.join(" · ")}`, summary.conflicts ? "bad" : "");
    } catch (error) {
      toast(error.message || "백업 파일을 읽지 못했습니다.", "bad");
    } finally {
      event.target.value = "";
    }
  }

  async function toggleClosure() {
    if (!state.rack) return;
    const code = state.rack.fullCode;
    const closed = state.closures.find((c) => c.rackCode === code);
    if (closed) { await dbDelete("closures", code); toast(`${code} 마감을 해제했습니다.`); }
    else {
      const here = state.placements.filter((p) => p.rackCode === code);
      await dbPut("closures", { rackCode: code, count: here.length, quantity: sumOf(here), closedBy: currentOperator(), deviceName: device.name, closedAt: now() });
      toast(`${code} 를 ${here.length}건 / 수량 ${qty(sumOf(here))} 으로 마감했습니다.`);
    }
    await logAudit(closed ? "rack_reopen" : "rack_close", code, {});
    await refreshStored();
  }

  async function resetLocal() {
    if (!confirm("이 기기에 저장된 작업 데이터를 모두 삭제합니다.\n백업 파일을 만들었는지 확인하세요. 되돌릴 수 없습니다.")) return;
    const stores = ["placements", "unlisted", "conflicts", "closures", "audit", "outbox"];
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(stores, "readwrite");
      stores.forEach((s) => tx.objectStore(s).clear());
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    await refreshStored();
    toast("작업 데이터를 초기화했습니다.");
  }


  /* ---------------- 구글 시트 업로드 ---------------- */
  // 지하 보관소처럼 신호가 없는 곳에서도 작업이 멈추면 안 되므로,
  // 저장은 항상 기기에 먼저 하고 outbox 에 쌓아둔다. 신호가 잡히면 그때 올린다.
  // 업로드가 확인되기 전에는 큐에서 지우지 않는다.
  // 사용자가 폰마다 주소를 붙여넣지 않아도 되도록 기본값을 심어 둔다.
  // 기기에서 [연결 설정]으로 바꾸면 그 값이 우선한다.
  const DEFAULT_CLOUD = {
    url: "https://script.google.com/macros/s/AKfycbxAYqG-pLJPZ67GUswqMOQ47DmwBnC3dXerGV7SaE_8Mo3SDCQxoy3AgeFEkloTLVRWxA/exec",
    token: "kd-qc",
    enabled: true,
  };
  let cloud = { ...DEFAULT_CLOUD };

  function loadCloud() {
    const saved = JSON.parse(localStorage.getItem("qc-cloud") || "null");
    // 예전에 빈 값으로 저장된 기기도 기본값을 되찾도록 보정한다.
    cloud = saved && saved.url ? saved : { ...DEFAULT_CLOUD };
  }
  function saveCloud(next) {
    cloud = { ...cloud, ...next };
    localStorage.setItem("qc-cloud", JSON.stringify(cloud));
    updateSyncChip();
  }
  const sentCount = () => Number(localStorage.getItem("qc-sent") || 0);

  async function enqueue(item, deleted) {
    if (!cloud.enabled) return;
    const record = state.records.find((r) => r.id === item.recordId);
    await dbPut("outbox", {
      id: item.id,
      queuedAt: now(),
      payload: {
        id: item.id, recordId: item.recordId,
        requestNumber: record?.requestNumber || "", itemCode: record?.itemCode || "",
        productName: record?.productName || item.productName || "",
        lotNumber: record?.lotNumber || item.lotNumber || "",
        rackCode: item.rackCode, zone: item.zone, rackBase: item.rackBase, level: item.level,
        quantity: item.quantity, unit: item.unit || record?.retentionUnit || "",
        // LIMS 대조를 위해 마스터 기준수량을 함께 올린다. 시트에서 차이를 계산한다.
        baseQuantity: record?.retentionQuantity ?? null,
        workStatus: item.workStatus, scanCount: item.scanCount || 1, note: item.note || "",
        updatedBy: item.updatedBy, deviceName: item.deviceName, deviceId: item.deviceId,
        updatedAt: item.updatedAt, deleted: !!deleted,
      },
    });
    await updateSyncChip();
    scheduleSync(1500);
  }

  // 저장 시점에 연동이 꺼져 있었으면 대기열에 안 들어간다.
  // 나중에 켰을 때 그 기록들이 영영 누락되지 않도록, 전체를 다시 대기열에 넣는다.
  async function requeueAll() {
    if (!cloud.enabled || !cloud.url) return toast("먼저 [연결 설정]에서 구글 시트를 연결하세요.", "bad");
    const total = state.placements.length + state.unlisted.length;
    if (!total) return toast("올릴 작업 내용이 없습니다.");
    if (!confirm(`이 기기의 작업 ${total.toLocaleString()}건을 모두 다시 올립니다.\n` +
                 "이미 올라간 것은 시트에서 덮어써지며 중복 행이 생기지 않습니다. 진행할까요?")) return;
    for (const p of state.placements) await enqueue(p, false);
    for (const u of state.unlisted) await enqueue({ ...u, recordId: u.id, workStatus: "unlisted", scanCount: 1 }, false);
    await updateSyncChip();
    toast(`${total.toLocaleString()}건을 업로드 대기열에 넣었습니다.`);
    syncNow(true);
  }

  function scheduleSync(delay) {
    clearTimeout(state.syncTimer);
    state.syncTimer = setTimeout(() => syncNow(false), delay || 8000);
  }

  async function updateSyncChip() {
    const queued = (await dbAll("outbox")).length;
    state.queue = queued;
    const chip = $("syncChip"), label = $("syncLabel");
    if ($("queueCount")) $("queueCount").textContent = queued.toLocaleString();
    if ($("sentCount")) $("sentCount").textContent = sentCount().toLocaleString();
    if ($("lastSync")) $("lastSync").textContent = localStorage.getItem("qc-sync-at") || "—";
    if ($("cloudState")) $("cloudState").textContent = cloud.enabled ? (cloud.url ? "사용 중" : "주소 미설정") : "사용 안 함";

    if (!cloud.enabled) { chip.className = "local-state"; label.textContent = "기기 내부 저장"; return; }
    if (!navigator.onLine) { chip.className = "local-state offline"; label.textContent = `오프라인 · 대기 ${queued}건`; return; }
    if (state.syncing) { chip.className = "local-state busy"; label.textContent = "업로드 중…"; return; }
    chip.className = queued ? "local-state pending" : "local-state";
    label.textContent = queued ? `업로드 대기 ${queued}건` : "구글 시트 동기화됨";
  }

  async function syncNow(manual) {
    if (!cloud.enabled || !cloud.url) {
      if (manual) toast("먼저 [연결 설정]에서 구글 시트 주소를 넣으세요.", "bad");
      return;
    }
    if (state.syncing) return;
    if (!navigator.onLine) { if (manual) toast("인터넷 연결이 없습니다. 신호가 잡히면 자동으로 올라갑니다.", "bad"); return; }
    const queue = await dbAll("outbox");
    if (!queue.length) { if (manual) toast("업로드할 내용이 없습니다."); return; }

    state.syncing = true;
    await updateSyncChip();
    const batch = queue.slice(0, 200);
    try {
      // text/plain 으로 보내면 CORS 사전요청(preflight)이 생기지 않아 Apps Script 로 바로 간다.
      const res = await fetch(cloud.url, {
        method: "POST", redirect: "follow",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          token: cloud.token, deviceId: device.id, deviceName: device.name,
          operator: currentOperator(), items: batch.map((x) => x.payload),
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error === "token_mismatch" ? "토큰이 일치하지 않습니다." : data.error);
      for (const row of batch) await dbDelete("outbox", row.id);
      localStorage.setItem("qc-sent", String(sentCount() + batch.length));
      localStorage.setItem("qc-sync-at", new Date().toISOString().replace("T", " ").slice(0, 16));
      state.syncing = false;
      await updateSyncChip();
      if (manual || batch.length > 5) toast(`구글 시트 업로드 완료 · ${batch.length}건 (신규 ${data.saved} / 갱신 ${data.updated})`);
      if (queue.length > batch.length) scheduleSync(1200);
    } catch (error) {
      state.syncing = false;
      await updateSyncChip();
      // 실패해도 큐는 그대로 둔다. 다음 기회에 다시 시도한다.
      if (manual) toast(`업로드 실패: ${error.message} — 기기에는 그대로 보관되어 있습니다.`, "bad");
      scheduleSync(60000);
    }
  }

  function openCloudSetup() {
    const form = $("cloudForm");
    form.url.value = cloud.url || DEFAULT_CLOUD.url;
    form.token.value = cloud.token || DEFAULT_CLOUD.token;
    form.enabled.checked = cloud.enabled;
    $("cloudTestResult").hidden = true;
    $("cloudModal").hidden = false;
  }

  async function testCloud() {
    const url = $("cloudForm").url.value.trim(), token = $("cloudForm").token.value.trim();
    const box = $("cloudTestResult");
    box.hidden = false; box.textContent = "확인 중…";
    if (!url) { box.textContent = "웹앱 URL 을 입력하세요."; return; }
    try {
      const res = await fetch(`${url}?token=${encodeURIComponent(token)}`, { redirect: "follow" });
      const data = await res.json();
      box.textContent = data.ok
        ? `연결 성공 — 시트 "${data.sheet}" · 현재 ${data.rows}행`
        : (data.error === "token_mismatch" ? "연결은 되지만 토큰이 일치하지 않습니다." : `오류: ${data.error}`);
    } catch (error) {
      box.textContent = `연결 실패: ${error.message} — URL 이 /exec 로 끝나는지, 배포 시 '액세스 권한: 모든 사용자' 인지 확인하세요.`;
    }
  }

  /* ---------------- 이벤트 바인딩 ---------------- */
  // 폰 전용으로 화면을 정리하면서 일부 요소가 빠질 수 있으므로,
  // 없는 요소에 붙이려 해도 앱 전체가 멈추지 않도록 감싼다.
  const on = (id, event, handler) => { const el = $(id); if (el) el.addEventListener(event, handler); };

  function bind() {
    on("setupBtn", "click", openSetup);
    on("deviceChip", "click", openSetup);
    on("setupForm", "submit", (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const zones = [...$("setupZones").querySelectorAll(".chip.on")].map((b) => b.dataset.zone);
      // 폰 한 대를 한 사람이 쓰므로 기기명을 따로 받지 않고 작업자 이름을 그대로 쓴다.
      // 기기 구분은 최초 실행 때 만들어진 device.id(UUID)가 계속 담당한다.
      const operator = String(f.get("operator")).trim();
      saveDevice({ name: operator, operator, zones, isMaster: !!f.get("isMaster") });
      $("setupModal").hidden = true;
      renderPicker();
      toast(`작업자를 ${device.operator} (으)로 설정했습니다.`);
    });

    document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
    document.querySelectorAll(".segment button").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
    document.querySelectorAll("[data-scan]").forEach((b) => b.addEventListener("click", () => openScanner(b.dataset.scan)));
    document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.close === "scan") return closeScanner();
      if (b.dataset.close === "qty") return cancelQuantity();
      $(`${b.dataset.close}Modal`).hidden = true;
      focusScan();
    }));

    on("rackDirectApply", "click", () => setRack($("rackDirect").value.trim()));
    on("rackDirect", "keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); setRack(e.target.value.trim()); } });
    on("changeRackBtn", "click", clearRack);
    on("closeRackBtn", "click", toggleClosure);
    on("undoBtn", "click", undoLast);

    on("scanInput", "keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const value = e.target.value;
      e.target.value = "";
      handleScan(value);
    });
    on("switchCamBtn", "click", switchCamera);
    on("finishScanBtn", "click", closeScanner);
    on("manualApply", "click", () => handleScan($("manualScan").value));
    on("manualScan", "keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); handleScan(e.target.value); } });

    // 수량 팝업
    on("qtyForm", "submit", submitQuantity);
    on("qtyValue", "input", updateQtyPreview);
    $("qtyForm").querySelectorAll("[data-qty]").forEach((b) => b.addEventListener("click", () => {
      const next = (num($("qtyValue").value) || 0) + Number(b.dataset.qty);
      $("qtyValue").value = Math.max(0, next);
      updateQtyPreview();
      $("qtyValue").focus();
    }));
    $("qtyForm").querySelectorAll('input[name="qtyMode"]').forEach((r) => r.addEventListener("change", () => {
      $("qtyForm").querySelectorAll(".qty-mode label").forEach((l) => l.classList.toggle("checked", l.querySelector("input").checked));
      updateQtyPreview();
    }));

    // USB/블루투스 바코드 스캐너는 키보드처럼 입력된다. 입력창에 포커스가 없어도 놓치지 않도록 버퍼링한다.
    document.addEventListener("keydown", (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (!state.rack || $("workTab").hidden || !$("qtyModal").hidden) return;
      const time = Date.now();
      if (time - state.wedge.at > 120) state.wedge.buffer = "";
      state.wedge.at = time;
      if (e.key === "Enter") {
        const value = state.wedge.buffer;
        state.wedge.buffer = "";
        if (value.length >= 3) handleScan(value);
      } else if (e.key.length === 1) state.wedge.buffer += e.key;
    });

    on("productQuery", "input", renderCandidates);
    on("lotQuery", "input", renderCandidates);
    on("unlistedBtn", "click", (e) => { e.preventDefault(); openUnlisted(); });
    on("unlistedForm", "submit", saveUnlisted);

    on("detailForm", "submit", submitDetail);
    on("detailDelete", "click", deleteDetail);
    $("detailForm").querySelectorAll('input[name="workStatus"]').forEach((radio) =>
      radio.addEventListener("change", () => $("detailForm").querySelectorAll(".status-row label")
        .forEach((l) => l.classList.toggle("checked", l.querySelector("input").checked))));

    on("listQuery", "input", () => { state.page = 1; renderList(); });
    on("listStatus", "change", () => { state.page = 1; renderList(); });
    on("listScope", "change", () => { state.page = 1; renderList(); });
    on("prevPage", "click", () => { if (state.page > 1) { state.page--; renderList(); } });
    on("nextPage", "click", () => { state.page++; renderList(); });

    on("exportBtn", "click", () => exportCsv("all"));
    on("issuesExport", "click", () => exportCsv("issues"));
    on("exportIssues2", "click", () => exportCsv("issues"));
    on("exportDetail", "click", exportPlacements);
    on("exportLims", "click", exportLimsCsv);
    on("rackExport", "click", exportRackCsv);
    on("backupBtn", "click", backup);
    on("mergeBtn", "click", () => $("mergeInput").click());
    on("mergeInput", "change", merge);
    on("resetBtn", "click", resetLocal);
    on("replaceMasterBtn", "click", () => {
      const picker = document.createElement("input");
      picker.type = "file"; picker.accept = ".json,application/json"; picker.multiple = true;
      picker.onchange = (e) => {
        $("dataSetup").hidden = false; $("app").hidden = true;
        $("masterFiles").onchange = importMaster;
        importMaster(e);
      };
      picker.click();
    });

    on("syncChip", "click", () => showTab("settings"));
    on("cloudSetupBtn", "click", openCloudSetup);
    on("cloudTestBtn", "click", testCloud);
    on("syncNowBtn", "click", () => syncNow(true));
    on("requeueBtn", "click", requeueAll);
    on("cloudForm", "submit", (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      saveCloud({ url: String(f.get("url")).trim(), token: String(f.get("token")).trim(), enabled: !!f.get("enabled") });
      $("cloudModal").hidden = true;
      toast(cloud.enabled
        ? "구글 시트 업로드를 켰습니다. 이전에 저장한 기록도 올리려면 [전체 다시 올리기]를 누르세요."
        : "구글 시트 업로드를 껐습니다.");
      if (cloud.enabled) syncNow(false);
    });
    window.addEventListener("online", () => { updateSyncChip(); scheduleSync(1000); });
    window.addEventListener("offline", updateSyncChip);
  }

  /* ---------------- 기준 데이터 ---------------- */
  // 윈도우 배포본은 data 폴더에 파일이 같이 들어 있다.
  // GitHub Pages 처럼 공개되는 곳에는 회사 데이터를 올릴 수 없으므로,
  // 파일이 없으면 기기에 저장해 둔 것을 쓰고, 그것도 없으면 불러오기 화면을 띄운다.
  async function loadMaster() {
    try {
      const [retention, rack] = await Promise.all([
        fetch("data/retention-samples.json").then((r) => { if (!r.ok) throw new Error("404"); return r.json(); }),
        fetch("data/rack-master.json").then((r) => { if (!r.ok) throw new Error("404"); return r.json(); }),
      ]);
      if (retention?.records?.length && rack?.racks?.length) return { retention, rack };
    } catch { /* 번들에 없으면 기기 저장본을 쓴다 */ }
    const saved = await dbGet("master", "current");
    return saved?.retention?.records?.length ? { retention: saved.retention, rack: saved.rack } : null;
  }

  function applyMaster(master) {
    state.records = master.retention.records; state.meta = master.retention.meta;
    state.racks = master.rack.racks; state.rackMeta = master.rack.meta;
  }

  function showDataSetup() {
    $("loading").hidden = true;
    $("dataSetup").hidden = false;
    $("masterFiles").onchange = importMaster;
    $("retryLoad").onclick = () => location.reload();
  }

  async function importMaster(event) {
    const files = [...(event.target.files || [])];
    const box = $("masterStatus");
    box.hidden = false;
    box.textContent = "읽는 중…";
    let retention = null, rack = null;
    try {
      for (const file of files) {
        const data = JSON.parse(await file.text());
        if (data.records && data.records.length) retention = data;
        else if (data.racks && data.racks.length) rack = data;
      }
      const saved = await dbGet("master", "current");
      retention = retention || saved?.retention;
      rack = rack || saved?.rack;
      if (!retention || !rack) {
        box.textContent = `파일이 부족합니다. 보관검체 목록${retention ? "(확인됨)" : "(없음)"} 과 랙 코드${rack ? "(확인됨)" : "(없음)"} 두 개를 함께 선택하세요.`;
        event.target.value = "";
        return;
      }
      await dbPut("master", { id: "current", retention, rack, importedAt: now() });
      box.textContent = `불러오기 완료 — 검체 ${retention.records.length.toLocaleString()}건 · 랙 ${rack.racks.length.toLocaleString()}개. 잠시 후 시작합니다.`;
      setTimeout(() => location.reload(), 900);
    } catch (error) {
      box.textContent = `파일을 읽지 못했습니다: ${error.message}`;
      event.target.value = "";
    }
  }

  /* ---------------- 시작 ---------------- */
  async function init() {
    try {
      const master = await loadMaster();
      if (!master) return showDataSetup();
      applyMaster(master);

      loadDevice();
      $("rackCodes").innerHTML = [...new Set(state.racks.map((r) => r.fullCode))].sort()
        .map((code) => `<option value="${esc(code)}"></option>`).join("");
      $("sourceInfo").textContent = `${state.meta.sourceFile} · ${state.rackMeta.sourceFile}`;

      bind();
      loadCloud();
      renderDeviceChip();
      await refreshStored();
      renderPicker();
      showView("list");

      const savedRack = localStorage.getItem("qc-rack");
      if (savedRack && findRack(savedRack)) setRack(savedRack);

      await updateSyncChip();
      if (cloud.enabled) scheduleSync(3000);
      $("loading").hidden = true; $("app").hidden = false;
      if (!device.operator) openSetup();
      if ("serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js").catch(() => {});
    } catch (error) {
      $("loading").innerHTML = `<b>기준 데이터를 불러오지 못했습니다.</b><p>${esc(error.message)}</p><p>START_OFFLINE.bat 파일로 실행했는지 확인하세요.</p>`;
    }
  }

  init();
})();
